/**
 * UX-FRM-RES-001 Firm private results — Phase 14 DoD.
 *  - standing() derives direction from gap-vs-score in ONE place (no per-index flag).
 *  - a within-margin difference makes no claim; outside it, the direction is correct
 *    for both a gap and a score index.
 *  - the stored 0–100 value is shown verbatim, never rescaled.
 *  - provenance per index comes from its metric_definitions composition.
 *  - the retail cut reuses Phase 6's thresholds; the combined report is unconditional.
 *  - no institutional cut, no ranking / other-firm data ever.
 *  - figures reflect investors who RATED the firm, regardless of arrival route.
 *  - access is coordinator-only (interim default).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  createCoordinator,
  createCalculationRun,
  insertCalculatedResult,
  createRespondent,
  insertResponse,
  updateEditionStatus,
} from '@cis/db';
import {
  seedReferenceData,
  requestSignoff,
  approveSignoff,
  getFirmResults,
  standing,
  isGapIndex,
  FirmResultsAccessError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  editionId = (await seedReferenceData(pool)).editionId;
});
afterAll(async () => {
  await closeTestPool();
});

const goodAccount = {
  populationCountsReviewed: true,
  floorStatusReviewed: true,
  dataQualityFlagsReviewed: true,
};

async function firm(slug: string): Promise<string> {
  const org = await createOrganization(pool, { slug, displayName: slug, orgType: 'firm' });
  return org.id;
}
async function coordinatorFor(firmId: string, accessCode: string): Promise<void> {
  await createCoordinator(pool, {
    organizationId: firmId,
    name: 'Coordinator',
    email: `${accessCode}@x.example`,
    accessCode,
    isLead: true,
  });
}
async function signedRun(): Promise<string> {
  await updateEditionStatus(pool, editionId, 'locked');
  const run = await createCalculationRun(pool, {
    editionId,
    runType: 'scoring',
    datasetHash: 'ds',
    status: 'complete',
  });
  const so = await requestSignoff(pool, {
    editionId,
    calculationRunId: run.id,
    requestedBy: 'maker',
    checkedAccount: goodAccount,
  });
  await approveSignoff(pool, { signoffId: so.id, approvedBy: 'checker' });
  return run.id;
}
async function seedFirmScores(
  runId: string,
  firmId: string,
  scores: Record<string, number>,
): Promise<void> {
  for (const [metricCode, value] of Object.entries(scores)) {
    await insertCalculatedResult(pool, {
      calculationRunId: runId,
      subjectType: 'firm',
      subjectId: firmId,
      metricCode,
      value,
      n: 40,
      denominator: 40,
      sufficiencyState: 'REPORTABLE',
    });
  }
}
/** One retail (S4) respondent, arriving via `recruitingFirmId`, rating `ratedFirmId`. */
async function retailRating(ratedFirmId: string, recruitingFirmId: string | null): Promise<void> {
  const r = await createRespondent(pool, {
    editionId,
    instrumentCode: 'S4',
    recruitingFirmId,
  });
  await insertResponse(pool, {
    editionId,
    respondentId: r.id,
    questionId: 'S4-Q1',
    scope: 'firm_specific',
    ratedFirmId,
    answer: { a: '8' },
  });
}

// ─── Pure standing() — the correctness crux ───────────────────────────────────

describe('standing() derives direction from gap-vs-score in one place', () => {
  it('a gap index (SEI) and a score index (OMI) both compute correctly from one function', () => {
    // SEI is a gap: a NARROWER (lower) gap is better.
    expect(standing(13, 18, isGapIndex('SEI'), 3)).toBe(true); // 13 < 18 → narrower → better
    expect(standing(23, 18, isGapIndex('SEI'), 3)).toBe(false); // wider → worse
    // OMI is a score: HIGHER is better.
    expect(standing(68, 61, isGapIndex('OMI'), 3)).toBe(true); // higher → better
    expect(standing(52, 59, isGapIndex('OMI'), 3)).toBe(false); // lower → worse
    // The direction is derived — SEI is the only gap, no per-index override.
    expect(isGapIndex('SEI')).toBe(true);
    expect(['OMI', 'DMI', 'IEI', 'ICI'].every((c) => isGapIndex(c) === false)).toBe(true);
  });

  it('a difference inside the margin makes NO claim; just outside, direction is correct', () => {
    expect(standing(62, 60, false, 3)).toBeNull(); // d=2 inside → null
    expect(standing(61, 63, true, 3)).toBeNull(); // gap d=-2 inside → null
    expect(standing(64, 60, false, 3)).toBe(true); // d=4 outside, score → better
    expect(standing(59, 63, true, 3)).toBe(true); // gap d=-4 outside → narrower → better
  });
});

// ─── DB-backed ────────────────────────────────────────────────────────────────

describe('The stored 0–100 value is shown verbatim (never rescaled)', () => {
  it('a calculated_results value of 68 renders as 68', async () => {
    const runId = await signedRun();
    const a = await firm('firm-a');
    await coordinatorFor(a, 'CODE-A');
    await seedFirmScores(runId, a, { OMI: 68, DMI: 52, IEI: 71, ICI: 64, SEI: 13 });

    const res = await getFirmResults(pool, {
      editionId,
      firmId: a,
      coordinatorAccessCode: 'CODE-A',
    });
    expect(res.indices.find((i) => i.metricCode === 'OMI')!.you).toBe(68);
    expect(res.indices.find((i) => i.metricCode === 'SEI')!.you).toBe(13); // not /10, not *anything
  });
});

describe('Provenance per index comes from its metric_definitions composition', () => {
  it('firm-side indices, investor-side indices, and the matched-pair gap each label correctly', async () => {
    const runId = await signedRun();
    const a = await firm('firm-a');
    await coordinatorFor(a, 'CODE-A');
    await seedFirmScores(runId, a, { OMI: 68, DMI: 52, IEI: 71, ICI: 64, SEI: 13 });
    const res = await getFirmResults(pool, {
      editionId,
      firmId: a,
      coordinatorAccessCode: 'CODE-A',
    });
    const prov = (c: string): string => res.indices.find((i) => i.metricCode === c)!.provenance;
    expect(prov('OMI')).toBe('From your own three surveys');
    expect(prov('DMI')).toBe('From your own three surveys');
    expect(prov('IEI')).toBe('From investors who rated you');
    expect(prov('ICI')).toBe('From investors who rated you');
    expect(prov('SEI')).toBe('Your answers against what investors reported');
  });
});

describe('Retail cut reuses Phase 6 sufficiency; combined report is unconditional', () => {
  it('reads directional at 12 ratings and still renders the combined report + all five indices', async () => {
    const runId = await signedRun();
    const a = await firm('firm-a');
    await coordinatorFor(a, 'CODE-A');
    await seedFirmScores(runId, a, { OMI: 68, DMI: 52, IEI: 71, ICI: 64, SEI: 13 });
    for (let i = 0; i < 12; i++) await retailRating(a, a); // 12 → directional (10..29)

    const res = await getFirmResults(pool, {
      editionId,
      firmId: a,
      coordinatorAccessCode: 'CODE-A',
    });
    expect(res.retail.count).toBe(12);
    expect(res.retail.state).toBe('directional');
    expect(res.combinedReportAvailable).toBe(true);
    expect(res.indices).toHaveLength(5);
  });

  it('renders the combined report even with zero retail (below the floor)', async () => {
    const runId = await signedRun();
    const a = await firm('firm-a');
    await coordinatorFor(a, 'CODE-A');
    await seedFirmScores(runId, a, { OMI: 68, DMI: 52, IEI: 71, ICI: 64, SEI: 13 });
    const res = await getFirmResults(pool, {
      editionId,
      firmId: a,
      coordinatorAccessCode: 'CODE-A',
    });
    expect(res.retail.count).toBe(0);
    expect(res.retail.state).toBe('none');
    expect(res.combinedReportAvailable).toBe(true);
    expect(res.indices).toHaveLength(5); // unconditional
  });
});

describe('No institutional cut, no ranking, no other-firm data', () => {
  it('returns only this firm and the anonymised industry aggregate — nothing institutional or ranked', async () => {
    const runId = await signedRun();
    const a = await firm('firm-a');
    const b = await firm('firm-b');
    await coordinatorFor(a, 'CODE-A');
    await seedFirmScores(runId, a, { OMI: 68, DMI: 52, IEI: 71, ICI: 64, SEI: 13 });
    await seedFirmScores(runId, b, { OMI: 54, DMI: 60, IEI: 60, ICI: 62, SEI: 23 });

    const res = await getFirmResults(pool, {
      editionId,
      firmId: a,
      coordinatorAccessCode: 'CODE-A',
    });
    // Only the five indices; no institutional (local/foreign) metric anywhere.
    expect(res.indices.map((i) => i.metricCode).sort()).toEqual([
      'DMI',
      'ICI',
      'IEI',
      'OMI',
      'SEI',
    ]);
    // The result names only this firm; firm-b's id never appears in the payload.
    expect(res.firmId).toBe(a);
    expect(JSON.stringify(res)).not.toContain(b);
    // Industry is a single aggregate number per index, not a per-firm breakdown.
    const omi = res.indices.find((i) => i.metricCode === 'OMI')!;
    expect(typeof omi.industry).toBe('number');
  });
});

describe('Attribution, not arrival route, determines inclusion', () => {
  it("counts a respondent who arrived via a DIFFERENT firm's link but rated this firm", async () => {
    const runId = await signedRun();
    const a = await firm('firm-a');
    const other = await firm('firm-other');
    await coordinatorFor(a, 'CODE-A');
    await seedFirmScores(runId, a, { OMI: 68, DMI: 52, IEI: 71, ICI: 64, SEI: 13 });

    // Arrives via firm-other's outreach, but RATES firm-a.
    await retailRating(a, other);
    // Arrives via firm-a's own link but RATES firm-other → must NOT count for firm-a.
    await retailRating(other, a);

    const res = await getFirmResults(pool, {
      editionId,
      firmId: a,
      coordinatorAccessCode: 'CODE-A',
    });
    expect(res.retail.count).toBe(1); // the cross-route rating of firm-a, not firm-a's own-link departer
  });
});

describe('Coordinator-only access (interim default)', () => {
  it('allows the firm’s coordinator and refuses any other code or a different firm’s coordinator', async () => {
    const runId = await signedRun();
    const a = await firm('firm-a');
    const b = await firm('firm-b');
    await coordinatorFor(a, 'CODE-A');
    await coordinatorFor(b, 'CODE-B');
    await seedFirmScores(runId, a, { OMI: 68, DMI: 52, IEI: 71, ICI: 64, SEI: 13 });

    // The firm's own coordinator: allowed.
    await expect(
      getFirmResults(pool, { editionId, firmId: a, coordinatorAccessCode: 'CODE-A' }),
    ).resolves.toBeTruthy();
    // An unknown code: refused.
    await expect(
      getFirmResults(pool, { editionId, firmId: a, coordinatorAccessCode: 'NOPE' }),
    ).rejects.toBeInstanceOf(FirmResultsAccessError);
    // A DIFFERENT firm's coordinator: refused (no cross-firm viewing).
    await expect(
      getFirmResults(pool, { editionId, firmId: a, coordinatorAccessCode: 'CODE-B' }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
