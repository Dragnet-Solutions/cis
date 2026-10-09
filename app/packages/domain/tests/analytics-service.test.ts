/**
 * Scoring / sufficiency / analytics integration tests — Phase 5 (E07) DoD §9.
 *  - funnel_event written transactionally with response completion; ONE completed
 *    event per multi-firm response.
 *  - firm eligibility: 0, 1, 3 of S1/S2/S3 complete.
 *  - AT-02: two methodology versions over the same frozen dataset, both retained.
 *  - traceability: a calculated_result → its run → the eligible raw responses.
 *  - report-dependency evaluated against live segment sufficiency.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  createRespondent,
  ensureSeats,
  setSeatState,
  listFunnelEvents,
  insertMetricDefinition,
  getMetricDefinitionsByVersion,
  listCalculatedResults,
  getCalculationRun,
  getResponsesRatingFirm,
  countAttributable,
  upsertSampleFloor,
} from '@cis/db';
import {
  seedReferenceData,
  submitResponses,
  isFirmEligible,
  eligibleFirmIds,
  runEligibility,
  runScoring,
  datasetHashFor,
  evaluateReportDependencies,
  computeSufficiency,
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
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
});
afterAll(async () => {
  await closeTestPool();
});

async function firm(slug: string) {
  return createOrganization(pool, { slug, displayName: slug.toUpperCase(), orgType: 'firm' });
}
async function completeSeats(orgId: string, seatCodes: Array<'S1' | 'S2' | 'S3'>) {
  await ensureSeats(pool, editionId, orgId);
  for (const code of seatCodes) {
    await setSeatState(pool, {
      editionId,
      organizationId: orgId,
      seatCode: code,
      state: 'complete',
    });
  }
}

describe('funnel_event — one completed per response', () => {
  it('a single multi-firm response produces exactly one completed event', async () => {
    const b = await firm('firm-b');
    const c = await firm('firm-c');
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });

    await submitResponses(pool, {
      editionId,
      respondentId: respondent.id,
      sharedAnswers: { 'S4-P1': { a: 'Under ₦50,000' } },
      firmAnswers: {
        [b.id]: { 'S4-Q1': { a: 8 } },
        [c.id]: { 'S4-Q1': { a: 5 } },
      },
    });

    const events = await listFunnelEvents(pool, editionId);
    const completed = events.filter((e) => e.eventType === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.responseId).toBe(respondent.id);
    expect(completed[0]?.segment).toBe('retail');
    // Retail completion carries no firm_id — attribution is not via the funnel.
    expect(completed[0]?.firmId).toBeNull();
    expect(await countAttributable(pool, editionId)).toBe(0);
  });
});

describe('Firm eligibility (≥1 of S1/S2/S3 complete)', () => {
  it('is false at 0 complete, true at 1, true at 3', async () => {
    const none = await firm('firm-none');
    const one = await firm('firm-one');
    const three = await firm('firm-three');
    await completeSeats(none.id, []);
    await completeSeats(one.id, ['S1']);
    await completeSeats(three.id, ['S1', 'S2', 'S3']);

    expect(await isFirmEligible(pool, editionId, none.id)).toBe(false);
    expect(await isFirmEligible(pool, editionId, one.id)).toBe(true);
    expect(await isFirmEligible(pool, editionId, three.id)).toBe(true);

    const eligible = await eligibleFirmIds(pool, editionId);
    expect(eligible.sort()).toEqual([one.id, three.id].sort());
  });

  it('persists a separate eligibility run (not folded into scoring)', async () => {
    const one = await firm('firm-elig');
    await completeSeats(one.id, ['S1']);
    const { run, firmResults, segmentResults } = await runEligibility(pool, editionId);
    expect(run.runType).toBe('eligibility');
    expect(firmResults.find((r) => r.subjectId === one.id)?.eligible).toBe(true);
    // Segment sufficiency rows exist for firm + the three respondent segments.
    expect(segmentResults.map((r) => r.subjectId).sort()).toEqual(
      ['firm', 'foreign_institution', 'local_institution', 'retail'].sort(),
    );
  });
});

describe('AT-02 — two methodology versions, same frozen dataset, both retained', () => {
  it('retains both result sets against the same dataset hash', async () => {
    const a = await firm('firm-a');
    await completeSeats(a.id, ['S1']); // eligible for scoring
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    await submitResponses(pool, {
      editionId,
      respondentId: respondent.id,
      sharedAnswers: {},
      firmAnswers: { [a.id]: { 'S4-Q1': { a: 8 } } },
    });

    // Version 2 methodology: a different config for the same metrics.
    await insertMetricDefinition(pool, {
      metricCode: 'OMI',
      version: 2,
      config: { questionIds: ['S4-Q1'], aggregation: 'equal_weight_mean' },
      isActive: false,
    });
    const v1 = await getMetricDefinitionsByVersion(pool, 1);
    const v2 = await getMetricDefinitionsByVersion(pool, 2);

    const hash = await datasetHashFor(pool, editionId);
    const run1 = await runScoring(pool, {
      editionId,
      methodologyVersion: 'M1',
      metricDefinitions: v1,
      datasetHash: hash,
    });
    const run2 = await runScoring(pool, {
      editionId,
      methodologyVersion: 'M2',
      metricDefinitions: v2,
      datasetHash: hash,
    });

    // Two distinct runs, same frozen dataset.
    expect(run1.run.id).not.toBe(run2.run.id);
    expect(run1.run.datasetHash).toBe(run2.run.datasetHash);
    expect(run1.run.methodologyVersion).toBe('M1');
    expect(run2.run.methodologyVersion).toBe('M2');

    // Both result sets are retained and independently readable, and reflect their
    // own methodology config: M1 scored all five indices, M2 only OMI.
    const r1 = await listCalculatedResults(pool, run1.run.id);
    const r2 = await listCalculatedResults(pool, run2.run.id);
    const metrics1 = [...new Set(r1.map((r) => r.metricCode))].sort();
    const metrics2 = [...new Set(r2.map((r) => r.metricCode))].sort();
    expect(metrics1).toEqual(['DMI', 'ICI', 'IEI', 'OMI', 'SEI']);
    expect(metrics2).toEqual(['OMI']);
    // Both still exist after the second run — neither overwrote the other.
    expect((await listCalculatedResults(pool, run1.run.id)).length).toBe(r1.length);
  });

  it('a calculated_result is immutable (a correction is a new run)', async () => {
    const a = await firm('firm-immutable');
    await completeSeats(a.id, ['S1']);
    const { results } = await runScoring(pool, { editionId });
    const target = results[0]!;
    await expect(
      pool.query('UPDATE calculated_results SET n = 999 WHERE id = $1', [target.id]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('Traceability — result → run → eligible raw responses', () => {
  it('resolves a firm result back to the responses that produced it', async () => {
    const a = await firm('firm-trace');
    await completeSeats(a.id, ['S1']);
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    await submitResponses(pool, {
      editionId,
      respondentId: respondent.id,
      sharedAnswers: {},
      firmAnswers: { [a.id]: { 'S4-Q1': { a: 7 } } },
    });

    const { run, results } = await runScoring(pool, { editionId });
    const firmResult = results.find((r) => r.subjectId === a.id)!;
    expect(firmResult.n).toBe(1);

    // result → run
    const resolvedRun = await getCalculationRun(pool, firmResult.calculationRunId);
    expect(resolvedRun?.id).toBe(run.id);

    // run/subject → the eligible raw responses that rated this firm
    const raw = await getResponsesRatingFirm(pool, editionId, a.id);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((x) => x.respondentId === respondent.id)).toBe(true);
  });
});

describe('Report-dependency evaluation against live sufficiency', () => {
  it('reports each output viable or not from current segment state', async () => {
    // Make retail trivially satisfiable and record one completed retail response.
    await upsertSampleFloor(pool, { editionId, category: 'retail', floorValue: 1 });
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    await submitResponses(pool, {
      editionId,
      respondentId: respondent.id,
      sharedAnswers: { 'S4-P1': { a: 'Under ₦50,000' } },
      firmAnswers: {},
    });

    const evals = await evaluateReportDependencies(pool, editionId);
    const publicReport = evals.find((e) => e.outputId === 'PUBLIC_REPORT')!;
    expect(publicReport.segmentStates['retail']?.meets).toBe(true);
    expect(publicReport.viable).toBe(true);

    // PUB_10 depends on institutions (floors 25/15, zero collected) → not viable.
    const pub10 = evals.find((e) => e.outputId === 'PUBLIC_REPORT.PUB_10')!;
    expect(pub10.viable).toBe(false);
  });
});

describe('Sufficiency thresholds (FRM_04 rule)', () => {
  it('suppresses below 10, DIRECTIONAL 10–29, REPORTABLE 30+', () => {
    expect(computeSufficiency(9)).toBe('SUPPRESSED');
    expect(computeSufficiency(10)).toBe('DIRECTIONAL');
    expect(computeSufficiency(29)).toBe('DIRECTIONAL');
    expect(computeSufficiency(30)).toBe('REPORTABLE');
    expect(computeSufficiency(50, { binaryConsequenceSignal: true })).toBe('BANDED');
  });
});
