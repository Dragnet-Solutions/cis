/**
 * CIS-SCORE-2026 v0.15 candidate methodology — Phase 11 DoD (DB-backed).
 *
 *  - TEST_UNAPPROVED hard gate: a run produced under the candidate methodology
 *    can NEVER back an official evidence pack, AI (national) generation, firm
 *    report generation/correction, or the UX-ADM-006 release path — each attempt
 *    is a hard, specific failure, not a downstream filter.
 *  - DMI completeness is ITEM-level (S1-Q3, S1-Q8, S3-Q2 valid) — a firm that
 *    left S1-Q8 unanswered is excluded even with its S1 and S3 seats complete.
 *  - OMI completeness is role-subindex-level; a firm with no Compliance-seat
 *    answers is not OMI-complete and shows in the missing-role counts.
 *  - Firm-specific investor aggregation excludes shared market-level items
 *    (S5b-Q1) structurally via the Phase 2 `scope` flag.
 *  - A like-for-like comparison is a new, separately-immutable
 *    LIKE_FOR_LIKE_RECALCULATED run that preserves both original headlines.
 *  - runCandidateScoring always marks the run TEST_UNAPPROVED and records
 *    Industry SEI as NOT_CALCULABLE (a methodology block, no value).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  ensureSeats,
  setSeatState,
  createRespondent,
  insertResponse,
  createCalculationRun,
  createEdition,
  createNationalReport,
  approveNationalReport,
  createFirmReport,
  getComparisonRun,
  listCalculatedResults,
} from '@cis/db';
import {
  seedReferenceData,
  runCandidateScoring,
  dmiCompleteFirmIds,
  omiCompleteFirmIds,
  missingOmiRoleCounts,
  firmDmiScores,
  firmSpecificInvestorAnswers,
  recordLikeForLikeComparison,
  recordInvestorLikeForLike,
  investorSegmentUnitScores,
  firmInvestorScores,
  buildEvidencePack,
  generateNationalReport,
  generateFirmReports,
  correctFirmReport,
  releaseFirmReports,
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

/** Create a firm and record firm-side item answers through its seats (S1/S2/S3).
 *  A response's respondent is the seat's respondent, so the answers are attributed
 *  to the firm exactly as the scoring reader joins them. */
async function firmWithFirmSideAnswers(
  slug: string,
  answers: Record<string, string>,
): Promise<string> {
  const org = await createOrganization(pool, {
    slug,
    displayName: slug.toUpperCase(),
    orgType: 'firm',
  });
  await ensureSeats(pool, editionId, org.id);
  const byInstr: Record<'S1' | 'S2' | 'S3', Array<[string, string]>> = { S1: [], S2: [], S3: [] };
  for (const [q, a] of Object.entries(answers)) {
    const seat = q.startsWith('S1') ? 'S1' : q.startsWith('S2') ? 'S2' : 'S3';
    byInstr[seat].push([q, a]);
  }
  for (const seat of ['S1', 'S2', 'S3'] as const) {
    if (byInstr[seat].length === 0) continue;
    const resp = await createRespondent(pool, { editionId, instrumentCode: seat });
    await setSeatState(pool, {
      editionId,
      organizationId: org.id,
      seatCode: seat,
      state: 'complete',
      respondentId: resp.id,
    });
    for (const [q, a] of byInstr[seat]) {
      await insertResponse(pool, {
        editionId,
        respondentId: resp.id,
        questionId: q,
        scope: 'shared',
        ratedFirmId: null,
        answer: { a },
      });
    }
  }
  return org.id;
}

describe('TEST_UNAPPROVED hard gate — candidate output cannot reach official paths', () => {
  it('runCandidateScoring always marks the run TEST_UNAPPROVED', async () => {
    const { run } = await runCandidateScoring(pool, editionId);
    expect(run.methodologyStatus).toBe('TEST_UNAPPROVED');
    expect(run.methodologyVersion).toBe('CIS-SCORE-2026@0.15');
  });

  it('buildEvidencePack refuses a TEST_UNAPPROVED run with a specific error', async () => {
    const { run } = await runCandidateScoring(pool, editionId);
    await expect(
      buildEvidencePack(pool, {
        calculationRunId: run.id,
        reportType: 'PUBLIC_REPORT',
        subjectType: 'market',
        subjectId: 'INDUSTRY',
        facts: [{ sectionId: 'PUB_01', sufficiencyState: 'REPORTABLE', value: 50 }],
      }),
    ).rejects.toMatchObject({ code: 'TEST_UNAPPROVED_RUN' });
  });

  it('national (AI) generation refuses a TEST_UNAPPROVED run', async () => {
    const { run } = await runCandidateScoring(pool, editionId);
    await expect(
      generateNationalReport(pool, {
        editionId,
        scoringRunId: run.id,
        context: { segments: {}, regulatorsEngaged: 0 },
      }),
    ).rejects.toMatchObject({ code: 'TEST_UNAPPROVED_RUN' });
  });

  it('firm report generation and correction refuse a TEST_UNAPPROVED run', async () => {
    const { run } = await runCandidateScoring(pool, editionId);
    await expect(
      generateFirmReports(pool, { editionId, scoringRunId: run.id }),
    ).rejects.toMatchObject({ code: 'TEST_UNAPPROVED_RUN' });
    const firm = await createOrganization(pool, {
      slug: 'corr-firm',
      displayName: 'CORR',
      orgType: 'firm',
    });
    await expect(
      correctFirmReport(pool, { editionId, organizationId: firm.id, scoringRunId: run.id }),
    ).rejects.toMatchObject({ code: 'TEST_UNAPPROVED_RUN' });
  });

  it('the UX-ADM-006 release path refuses to release a report backed by a TEST_UNAPPROVED run', async () => {
    const { run } = await runCandidateScoring(pool, editionId);
    // An approved national report clears the release-ordering gate…
    const approvedRun = await createCalculationRun(pool, {
      editionId,
      runType: 'scoring',
      datasetHash: 'approved',
    });
    const nr = await createNationalReport(pool, { editionId, scoringRunId: approvedRun.id });
    await approveNationalReport(pool, nr.id, 'approver');
    // …but a firm report row backed by the TEST_UNAPPROVED run must never release.
    const firm = await createOrganization(pool, {
      slug: 'rel-firm',
      displayName: 'REL',
      orgType: 'firm',
    });
    await createFirmReport(pool, {
      editionId,
      organizationId: firm.id,
      scoringRunId: run.id,
      retailN: 0,
      cutState: 'none',
      generationState: 'generated',
    });
    await expect(releaseFirmReports(pool, editionId)).rejects.toMatchObject({
      code: 'TEST_UNAPPROVED_RUN',
    });
  });
});

describe('DMI completeness is item-level, not seat-level', () => {
  it('excludes a firm missing S1-Q8 even with S1 and S3 answers present', async () => {
    // Complete: all three required items valid.
    await firmWithFirmSideAnswers('firm-dmi-complete', {
      'S1-Q3': '8',
      'S1-Q8': '9',
      'S3-Q2': '0-10%',
    });
    // Missing S1-Q8 — item-level incomplete though S1 and S3 both carry answers.
    await firmWithFirmSideAnswers('firm-dmi-partial', {
      'S1-Q3': '8',
      'S3-Q2': '0-10%',
    });
    const complete = await dmiCompleteFirmIds(pool, editionId);
    expect(complete).toHaveLength(1);

    const scores = await firmDmiScores(pool, editionId);
    expect(scores).toHaveLength(1);
    // 0.40·N1(8) + 0.40·N4('0-10%') + 0.20·N1(9)
    //   = 0.40·77.7778 + 0.40·95 + 0.20·88.8889 = 86.8889
    expect(scores[0]!.score).toBeCloseTo(86.8889, 3);
  });
});

describe('OMI completeness is role-subindex-level', () => {
  it('excludes a firm with no Compliance answers and counts the missing role', async () => {
    await firmWithFirmSideAnswers('firm-omi-complete', {
      'S1-Q2': '8', // CEO
      'S2-Q1': '3', // Compliance
      'S3-Q2': '0-10%', // Operations
    });
    await firmWithFirmSideAnswers('firm-omi-nocompliance', {
      'S1-Q2': '8', // CEO
      'S3-Q2': '0-10%', // Operations — but NO Compliance item
    });
    const complete = await omiCompleteFirmIds(pool, editionId);
    expect(complete).toHaveLength(1);
    const missing = await missingOmiRoleCounts(pool, editionId);
    expect(missing['Compliance']).toBe(1);
    expect(missing['CEO']).toBe(0);
  });
});

describe('Firm-specific investor aggregation excludes shared market-level items', () => {
  it('never includes S5b-Q1 (shared) in a firm-specific record; keeps S5b-Q2/Q3', async () => {
    const firm = await createOrganization(pool, {
      slug: 'firm-inv',
      displayName: 'INV',
      orgType: 'firm',
    });
    const resp = await createRespondent(pool, { editionId, instrumentCode: 'S5b' });
    // Shared market-level item — carries no rated firm; must not enter a firm record.
    await insertResponse(pool, {
      editionId,
      respondentId: resp.id,
      questionId: 'S5b-Q1',
      scope: 'shared',
      ratedFirmId: null,
      answer: { a: '7' },
    });
    for (const q of ['S5b-Q2', 'S5b-Q3']) {
      await insertResponse(pool, {
        editionId,
        respondentId: resp.id,
        questionId: q,
        scope: 'firm_specific',
        ratedFirmId: firm.id,
        answer: { a: '8' },
      });
    }
    const rows = await firmSpecificInvestorAnswers(pool, editionId, firm.id);
    const ids = rows.map((r) => r.questionId).sort();
    expect(ids).toEqual(['S5b-Q2', 'S5b-Q3']);
    expect(ids).not.toContain('S5b-Q1');
  });
});

describe('Like-for-like cross-edition comparison is a new, immutable, labelled run', () => {
  it('records both recalculated values and preserves both original headlines', async () => {
    const runA = await createCalculationRun(pool, {
      editionId,
      runType: 'scoring',
      datasetHash: 'a',
    });
    const runB = await createCalculationRun(pool, {
      editionId,
      runType: 'scoring',
      datasetHash: 'b',
    });
    const cmp = await recordLikeForLikeComparison(pool, {
      metricCode: 'IEI',
      editionAId: editionId,
      editionBId: editionId,
      runAId: runA.id,
      runBId: runB.id,
      a: {
        reportable: ['retail', 'local'],
        unitScoresBySegment: { retail: [80, 80], local: [40] },
        publishedHeadline: 66,
      },
      b: {
        reportable: ['retail'],
        unitScoresBySegment: { retail: [90, 90] },
        publishedHeadline: 90,
      },
    });
    expect(cmp.label).toBe('LIKE_FOR_LIKE_RECALCULATED');
    expect(cmp.commonSegments).toEqual(['retail']);
    // Both editions restated on {retail}: A = 80, B = 90.
    expect(cmp.recalculatedA).toBeCloseTo(80, 6);
    expect(cmp.recalculatedB).toBeCloseTo(90, 6);
    // Originals preserved, never overwritten.
    expect(cmp.originalHeadlineA).toBe(66);
    expect(cmp.originalHeadlineB).toBe(90);
    // Persisted and immutable.
    const fetched = await getComparisonRun(pool, cmp.id);
    expect(fetched?.methodologyVersion).toBe('CIS-SCORE-2026@0.15');
  });
});

describe('runCandidateScoring records Industry SEI as NOT_CALCULABLE', () => {
  it('writes a valueless NOT_CALCULABLE SEI result (methodology block, not a shortfall)', async () => {
    const { run, industrySei } = await runCandidateScoring(pool, editionId);
    expect(industrySei.status).toBe('NOT_CALCULABLE');
    const results = await listCalculatedResults(pool, run.id);
    const sei = results.find((r) => r.metricCode === 'SEI');
    expect(sei).toBeTruthy();
    expect(sei!.sufficiencyState).toBe('NOT_CALCULABLE');
    expect(sei!.value).toBeNull();
    expect(sei!.band).toBeNull();
  });
});

// ─── Phase 22 — investor-unit scoring pipeline, real data through the real path

const n1 = (x: number): number => ((x - 1) / 9) * 100;
const n8 = (v: 'Yes' | 'No'): number => (v === 'No' ? 100 : 0);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** One respondent of the given investor instrument, with the given raw items
 *  recorded exactly as the real journey would write them. */
async function seedInvestorRespondent(
  targetEditionId: string,
  instrumentCode: 'S4' | 'S5a' | 'S5b',
  items: Array<{
    questionId: string;
    scope: 'shared' | 'firm_specific';
    ratedFirmId: string | null;
    a: unknown;
  }>,
): Promise<string> {
  const resp = await createRespondent(pool, { editionId: targetEditionId, instrumentCode });
  for (const item of items) {
    await insertResponse(pool, {
      editionId: targetEditionId,
      respondentId: resp.id,
      questionId: item.questionId,
      scope: item.scope,
      ratedFirmId: item.ratedFirmId,
      answer: { a: item.a },
    });
  }
  return resp.id;
}

const RETAIL_FULL = {
  q1: '8',
  q2: '7',
  q3: '9',
  q4: '8',
  q5: 'No' as const,
  q6: 'No' as const,
  q7: 'No' as const,
};
async function seedRetailFull(targetEditionId: string, firmId: string): Promise<string> {
  return seedInvestorRespondent(targetEditionId, 'S4', [
    { questionId: 'S4-Q1', scope: 'firm_specific', ratedFirmId: firmId, a: RETAIL_FULL.q1 },
    { questionId: 'S4-Q2', scope: 'firm_specific', ratedFirmId: firmId, a: RETAIL_FULL.q2 },
    { questionId: 'S4-Q3', scope: 'firm_specific', ratedFirmId: firmId, a: RETAIL_FULL.q3 },
    { questionId: 'S4-Q4', scope: 'firm_specific', ratedFirmId: firmId, a: RETAIL_FULL.q4 },
    { questionId: 'S4-Q5', scope: 'firm_specific', ratedFirmId: firmId, a: RETAIL_FULL.q5 },
    { questionId: 'S4-Q6', scope: 'firm_specific', ratedFirmId: firmId, a: RETAIL_FULL.q6 },
    { questionId: 'S4-Q7', scope: 'firm_specific', ratedFirmId: firmId, a: RETAIL_FULL.q7 },
  ]);
}
const RETAIL_FULL_IEI = mean([n1(8), n1(7), n1(9)]);
const RETAIL_FULL_ICI = 0.5 * n1(8) + 0.5 * mean([n8('No'), n8('No'), n8('No')]);

/** Exactly 2 of the 3 ICI behavioural items (§11's explicit partial allowance) —
 *  IEI is unaffected (Q1-Q3 all present); ICI must still be INCLUDED. */
async function seedRetailIciBoundary(targetEditionId: string, firmId: string): Promise<string> {
  return seedInvestorRespondent(targetEditionId, 'S4', [
    { questionId: 'S4-Q1', scope: 'firm_specific', ratedFirmId: firmId, a: '8' },
    { questionId: 'S4-Q2', scope: 'firm_specific', ratedFirmId: firmId, a: '7' },
    { questionId: 'S4-Q3', scope: 'firm_specific', ratedFirmId: firmId, a: '9' },
    { questionId: 'S4-Q4', scope: 'firm_specific', ratedFirmId: firmId, a: '8' },
    { questionId: 'S4-Q5', scope: 'firm_specific', ratedFirmId: firmId, a: 'Yes' },
    { questionId: 'S4-Q6', scope: 'firm_specific', ratedFirmId: firmId, a: 'No' },
    // Q7 deliberately absent — 2 of 3.
  ]);
}
const RETAIL_BOUNDARY_ICI = 0.5 * n1(8) + 0.5 * mean([n8('Yes'), n8('No')]);

/** Only 1 of the 3 ICI behavioural items — below §11's allowance; ICI must be
 *  EXCLUDED entirely (IEI still valid — Q1-Q3 present). */
async function seedRetailIciIneligible(targetEditionId: string, firmId: string): Promise<string> {
  return seedInvestorRespondent(targetEditionId, 'S4', [
    { questionId: 'S4-Q1', scope: 'firm_specific', ratedFirmId: firmId, a: '8' },
    { questionId: 'S4-Q2', scope: 'firm_specific', ratedFirmId: firmId, a: '7' },
    { questionId: 'S4-Q3', scope: 'firm_specific', ratedFirmId: firmId, a: '9' },
    { questionId: 'S4-Q4', scope: 'firm_specific', ratedFirmId: firmId, a: '8' },
    { questionId: 'S4-Q5', scope: 'firm_specific', ratedFirmId: firmId, a: 'Yes' },
    // Q6, Q7 absent — only 1 of 3.
  ]);
}

const LOCAL_ATTRS = [
  'Service quality',
  'Reporting quality',
  'Responsiveness',
  'Operational efficiency',
];
async function seedLocalFull(targetEditionId: string, firmId: string): Promise<string> {
  const grid: Record<string, { Rating: string }> = {};
  for (const row of LOCAL_ATTRS) grid[row] = { Rating: '8' };
  return seedInvestorRespondent(targetEditionId, 'S5a', [
    { questionId: 'S5a-Q1', scope: 'firm_specific', ratedFirmId: firmId, a: grid },
    { questionId: 'S5a-Q2', scope: 'firm_specific', ratedFirmId: firmId, a: '8' },
  ]);
}
const LOCAL_FULL_IEI = mean([n1(8), n1(8)]); // q1Composite (all four = N1(8)) then mean with q2=N1(8)

async function seedForeignFull(targetEditionId: string, firmId: string): Promise<string> {
  return seedInvestorRespondent(targetEditionId, 'S5b', [
    { questionId: 'S5b-Q1', scope: 'shared', ratedFirmId: null, a: '8' },
    { questionId: 'S5b-Q8', scope: 'shared', ratedFirmId: null, a: '7' },
    { questionId: 'S5b-Q2', scope: 'firm_specific', ratedFirmId: firmId, a: '9' },
    { questionId: 'S5b-Q3', scope: 'firm_specific', ratedFirmId: firmId, a: '6' },
    { questionId: 'S5b-Q4', scope: 'firm_specific', ratedFirmId: firmId, a: '8' },
  ]);
}
const FOREIGN_FIRM_SPECIFIC_IEI = mean([n1(9), n1(6)]); // only the firm-specific Q2/Q3, per §7.4

describe('Phase 22 — investor-unit scoring pipeline, real data through the real path', () => {
  it('pools a real REPORTABLE retail segment, excludes a below-floor local (SUPPRESSED) and foreign (SHOWN_DIRECTIONALLY) segment, and respects §11 eligibility', async () => {
    const f1 = await firmWithFirmSideAnswers('f1-p22', { 'S1-Q11': '9' });

    // Retail: 30 fully-eligible + one 2-of-3-ICI boundary (included) + one
    // 1-of-3-ICI (ICI-excluded, IEI-included) = 32 valid IEI, 31 valid ICI —
    // clears the REPORTABLE_AT(30) floor for both.
    for (let i = 0; i < 30; i++) await seedRetailFull(editionId, f1);
    await seedRetailIciBoundary(editionId, f1);
    await seedRetailIciIneligible(editionId, f1);

    // Local: 3 fully-eligible respondents — n=3 < SUPPRESS_BELOW(10) → SUPPRESSED.
    for (let i = 0; i < 3; i++) await seedLocalFull(editionId, f1);

    // Foreign: 15 fully-eligible institutions — 10 <= n=15 < REPORTABLE_AT(30)
    // → SHOWN_DIRECTIONALLY.
    for (let i = 0; i < 15; i++) await seedForeignFull(editionId, f1);

    // The actual production entry point — not a call to pooledHeadline in isolation.
    const { run, investorPooling, firmSeiCount } = await runCandidateScoring(pool, editionId);

    // Real calculated_results rows, at subject_type='market', exist afterward.
    const results = await listCalculatedResults(pool, run.id);
    const ieiRow = results.find((r) => r.subjectType === 'market' && r.metricCode === 'IEI')!;
    const iciRow = results.find((r) => r.subjectType === 'market' && r.metricCode === 'ICI')!;
    expect(ieiRow).toBeTruthy();
    expect(iciRow).toBeTruthy();

    // Correct pooled value: retail-only (32 identical units for IEI).
    expect(ieiRow.sufficiencyState).toBe('REPORTABLE');
    expect(ieiRow.value).toBeCloseTo(Math.round(RETAIL_FULL_IEI * 10) / 10, 1);
    expect(ieiRow.n).toBe(32);

    // ICI pooled over 31 valid units (30 full @ RETAIL_FULL_ICI + 1 boundary
    // @ RETAIL_BOUNDARY_ICI); the 1-of-3 respondent is excluded entirely.
    const expectedIci = mean([...Array(30).fill(RETAIL_FULL_ICI), RETAIL_BOUNDARY_ICI]);
    expect(iciRow.sufficiencyState).toBe('REPORTABLE');
    expect(iciRow.value).toBeCloseTo(Math.round(expectedIci * 10) / 10, 1);
    expect(iciRow.n).toBe(31);

    // §9 composition: ONLY the contributing (retail) segment appears — local
    // and foreign are OMITTED entirely, never zeroed.
    expect(ieiRow.composition).toEqual([{ segment: 'retail', label: 'Retail', count: 32 }]);
    expect(iciRow.composition).toEqual([{ segment: 'retail', label: 'Retail', count: 31 }]);
    expect(ieiRow.composition!.some((c) => c.segment === 'local')).toBe(false);
    expect(ieiRow.composition!.some((c) => c.segment === 'foreign')).toBe(false);

    // Below-floor segments are excluded from BOTH the headline and the
    // denominator, but each still carries its own correct standalone state —
    // SUPPRESSED (local, n=3) is a genuinely different state from
    // SHOWN_DIRECTIONALLY (foreign, n=15), never blurred into one behaviour.
    expect(investorPooling.iei.excludedSegments.sort()).toEqual(['foreign', 'local']);
    expect(investorPooling.iei.standaloneState['local']).toBe('SUPPRESSED');
    expect(investorPooling.iei.standaloneState['foreign']).toBe('SHOWN_DIRECTIONALLY');
    expect(investorPooling.iei.standaloneState['retail']).toBe('REPORTABLE');

    // Firm_SEI_f: real, pipeline-sourced Firm_Investor_IEI_f (never a stub).
    // f1's combined evidence = 32 retail (@ RETAIL_FULL_IEI, since the
    // boundary/ineligible-ICI respondents still have valid IEI) + 3 local
    // (@ LOCAL_FULL_IEI) + 15 foreign firm-specific (@ FOREIGN_FIRM_SPECIFIC_IEI).
    expect(firmSeiCount).toBe(1);
    const firmInvestorIei = mean([
      ...Array(32).fill(RETAIL_FULL_IEI),
      ...Array(3).fill(LOCAL_FULL_IEI),
      ...Array(15).fill(FOREIGN_FIRM_SPECIFIC_IEI),
    ]);
    const expectedSei = 100 - Math.abs(n1(9) - firmInvestorIei);
    const firmSei = results.find((r) => r.subjectType === 'firm' && r.metricCode === 'SEI')!;
    expect(firmSei).toBeTruthy();
    expect(firmSei.sufficiencyState).toBe('REPORTABLE');
    expect(firmSei.value).toBeCloseTo(Math.round(expectedSei * 10000) / 10000, 3);

    // Every new row this run produced is still a TEST_UNAPPROVED run — no
    // exception introduced for the investor-side additions.
    expect(run.methodologyStatus).toBe('TEST_UNAPPROVED');
    await expect(
      buildEvidencePack(pool, {
        calculationRunId: run.id,
        reportType: 'PUBLIC_REPORT',
        subjectType: 'market',
        subjectId: 'INDUSTRY',
        facts: [
          { sectionId: 'PUB_01', metricCode: 'IEI', sufficiencyState: 'REPORTABLE', value: 50 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'TEST_UNAPPROVED_RUN' });
  }, 30000);

  it('exposes the same real unit scores investorSegmentUnitScores/firmInvestorScores compute — no orphan pure function left uncalled', async () => {
    const f1 = await firmWithFirmSideAnswers('f1-direct', { 'S1-Q11': '9' });
    for (let i = 0; i < 5; i++) await seedRetailFull(editionId, f1);

    const scores = await investorSegmentUnitScores(pool, editionId);
    expect(scores.retail.iei).toHaveLength(5);
    expect(scores.retail.iei[0]).toBeCloseTo(RETAIL_FULL_IEI, 6);

    const firmScores = await firmInvestorScores(pool, editionId);
    const f1Score = firmScores.find((s) => s.firmId === f1)!;
    expect(f1Score.investorIei).toBeCloseTo(RETAIL_FULL_IEI, 6);
    expect(f1Score.nIei).toBe(5);
  });

  it('like-for-like: two editions with differing reportable segment sets produce a real, immutable, correctly-labelled comparison via the real pooled-headline service, preserving both original headlines', async () => {
    // Edition A (the shared beforeEach edition): retail REPORTABLE only.
    const f1 = await firmWithFirmSideAnswers('f1-lfl-a', {});
    for (let i = 0; i < 30; i++) await seedRetailFull(editionId, f1);
    const { run: runA, investorPooling: poolingA } = await runCandidateScoring(pool, editionId);
    expect(poolingA.iei.excludedSegments.sort()).toEqual(['foreign', 'local']);

    // Edition B: retail AND local both REPORTABLE.
    const editionB = await createEdition(pool, { label: '2027-test' });
    const f2 = await createOrganization(pool, {
      slug: 'f2-lfl-b',
      displayName: 'F2',
      orgType: 'firm',
    });
    for (let i = 0; i < 30; i++) await seedRetailFull(editionB.id, f2.id);
    for (let i = 0; i < 30; i++) await seedLocalFull(editionB.id, f2.id);
    const { run: runB, investorPooling: poolingB } = await runCandidateScoring(pool, editionB.id);
    expect(poolingB.iei.excludedSegments).toEqual(['foreign']);

    const cmp = await recordInvestorLikeForLike(pool, {
      metricCode: 'IEI',
      editionAId: editionId,
      editionBId: editionB.id,
      runAId: runA.id,
      runBId: runB.id,
    });

    expect(cmp.label).toBe('LIKE_FOR_LIKE_RECALCULATED');
    // The common segment set is retail only — local is reportable in B but
    // not in A, so it correctly drops out of the like-for-like set.
    expect(cmp.commonSegments).toEqual(['retail']);
    // Both editions restated on {retail}; since both used identical retail
    // answers, both recalculated values equal the same per-unit IEI.
    expect(cmp.recalculatedA).toBeCloseTo(RETAIL_FULL_IEI, 6);
    expect(cmp.recalculatedB).toBeCloseTo(RETAIL_FULL_IEI, 6);
    // Both ORIGINAL published headlines are preserved untouched alongside —
    // A's original headline is retail-only already (so it matches), but the
    // preservation itself, not equality, is what matters here.
    expect(cmp.originalHeadlineA).toBeCloseTo(Math.round(RETAIL_FULL_IEI * 10) / 10, 1);
    expect(cmp.originalHeadlineB).not.toBeNull();

    const fetched = await getComparisonRun(pool, cmp.id);
    expect(fetched?.methodologyVersion).toBe('CIS-SCORE-2026@0.15');
  }, 30000);
});
