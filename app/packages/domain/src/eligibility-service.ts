import { Pool } from 'pg';
import {
  listSampleFloors,
  getFirmSeatCompletionCounts,
  countCompletedBySegment,
  countDistinctInstitutions,
  createCalculationRun,
  insertEligibilityResult,
  withTransaction,
} from '@cis/db';
import type { EligibilityResult, CalculationRun } from '@cis/shared-types';

/**
 * Eligibility — computed and persisted as its OWN step, before any scoring pass
 * touches response data. Two kinds:
 *  - Firm eligibility: a firm is eligible for scoring with AT LEAST ONE of its
 *    S1/S2/S3 surveys complete. This is the queryable check other callers reuse.
 *  - Segment sufficiency: each segment's counted value against its configured
 *    floor (from Phase 1 `edition_sample_floors`, the single source of truth —
 *    not duplicated here). Institutions count by DISTINCT institution, never by
 *    response count.
 */

const SEGMENT_FLOOR_CATEGORY = {
  retail: 'retail',
  local_institution: 'local_institution',
  foreign_institution: 'foreign_institution',
} as const;

/** A firm is eligible for scoring with at least one of S1/S2/S3 complete. */
export async function isFirmEligible(
  pool: Pool,
  editionId: string,
  firmId: string,
): Promise<boolean> {
  const counts = await getFirmSeatCompletionCounts(pool, editionId);
  const row = counts.find((c) => c.organizationId === firmId);
  return !!row && row.complete >= 1;
}

/** All firms eligible for scoring this edition (≥1 of S1/S2/S3 complete). */
export async function eligibleFirmIds(pool: Pool, editionId: string): Promise<string[]> {
  const counts = await getFirmSeatCompletionCounts(pool, editionId);
  return counts.filter((c) => c.complete >= 1).map((c) => c.organizationId);
}

export interface EligibilityRunResult {
  run: CalculationRun;
  firmResults: EligibilityResult[];
  segmentResults: EligibilityResult[];
}

/**
 * Compute and persist a full eligibility snapshot for an edition as its own
 * immutable run (run_type='eligibility'), separate from scoring.
 */
export async function runEligibility(pool: Pool, editionId: string): Promise<EligibilityRunResult> {
  const floors = await listSampleFloors(pool, editionId);
  const floorOf = (category: string): number =>
    floors.find((f) => f.category === category)?.floorValue ?? 0;

  const seatCounts = await getFirmSeatCompletionCounts(pool, editionId);
  const completedBySegment = await countCompletedBySegment(pool, editionId);
  const localInst = await countDistinctInstitutions(pool, editionId, 'local_institution');
  const foreignInst = await countDistinctInstitutions(pool, editionId, 'foreign_institution');

  return withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const run = await createCalculationRun(c, {
      editionId,
      runType: 'eligibility',
      datasetHash: `eligibility-${editionId}`,
    });

    const firmResults: EligibilityResult[] = [];
    for (const fc of seatCounts) {
      firmResults.push(
        await insertEligibilityResult(c, {
          calculationRunId: run.id,
          subjectType: 'firm',
          subjectId: fc.organizationId,
          segment: 'firm',
          counted: fc.complete,
          floor: 1,
          eligible: fc.complete >= 1,
        }),
      );
    }
    // Firm segment as a whole against the participating-firms floor.
    const eligibleFirms = firmResults.filter((r) => r.eligible).length;
    const segmentResults: EligibilityResult[] = [];
    segmentResults.push(
      await insertEligibilityResult(c, {
        calculationRunId: run.id,
        subjectType: 'segment',
        subjectId: 'firm',
        segment: 'firm',
        counted: eligibleFirms,
        floor: floorOf('firm'),
        eligible: eligibleFirms >= floorOf('firm'),
      }),
    );

    const segmentCounts: Record<string, number> = {
      retail: completedBySegment['retail'] ?? 0,
      local_institution: localInst,
      foreign_institution: foreignInst,
    };
    for (const [segment, category] of Object.entries(SEGMENT_FLOOR_CATEGORY)) {
      const counted = segmentCounts[segment] ?? 0;
      const floor = floorOf(category);
      segmentResults.push(
        await insertEligibilityResult(c, {
          calculationRunId: run.id,
          subjectType: 'segment',
          subjectId: segment,
          segment,
          counted,
          floor,
          eligible: counted >= floor,
        }),
      );
    }

    return { run, firmResults, segmentResults };
  });
}

/** Current per-segment sufficiency (meets floor or not), computed live for the
 *  report-dependency evaluator. */
export async function currentSegmentSufficiency(
  pool: Pool,
  editionId: string,
): Promise<Record<string, { counted: number; floor: number; meets: boolean }>> {
  const floors = await listSampleFloors(pool, editionId);
  const floorOf = (category: string): number =>
    floors.find((f) => f.category === category)?.floorValue ?? 0;
  const completedBySegment = await countCompletedBySegment(pool, editionId);
  const localInst = await countDistinctInstitutions(pool, editionId, 'local_institution');
  const foreignInst = await countDistinctInstitutions(pool, editionId, 'foreign_institution');
  const eligibleFirms = (await eligibleFirmIds(pool, editionId)).length;

  const out: Record<string, { counted: number; floor: number; meets: boolean }> = {};
  const put = (seg: string, counted: number, category: string) => {
    const floor = floorOf(category);
    out[seg] = { counted, floor, meets: counted >= floor };
  };
  put('firm', eligibleFirms, 'firm');
  put('retail', completedBySegment['retail'] ?? 0, 'retail');
  put('local_institution', localInst, 'local_institution');
  put('foreign_institution', foreignInst, 'foreign_institution');
  return out;
}
