import { Pool } from 'pg';
import type {
  CalculationRun,
  CalculationRunType,
  CalculationRunStatus,
  CalculatedResult,
  CalculatedResultComposition,
  EligibilityResult,
  SubjectType,
  SufficiencyState,
} from '@cis/shared-types';
import { query } from '../client';

// ─── calculation_runs ──────────────────────────────────────────────────────────

interface RawRunRow {
  id: string;
  edition_id: string;
  run_type: CalculationRunType;
  methodology_version: string | null;
  dataset_hash: string;
  status: CalculationRunStatus;
  methodology_status: 'TEST_UNAPPROVED' | 'APPROVED' | null;
  started_at: Date;
  finished_at: Date | null;
  created_at: Date;
}

function mapRun(row: RawRunRow): CalculationRun {
  return {
    id: row.id,
    editionId: row.edition_id,
    runType: row.run_type,
    methodologyVersion: row.methodology_version,
    datasetHash: row.dataset_hash,
    status: row.status,
    methodologyStatus: row.methodology_status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

/** A run may back official output only when it was NOT produced under a
 *  TEST_UNAPPROVED methodology (build note §2). NULL status = legacy/normal run. */
export function isRunOfficialUsable(run: CalculationRun): boolean {
  return run.methodologyStatus !== 'TEST_UNAPPROVED';
}

/** Insert a run record. Runs are immutable — insert it already in its final
 *  state (the service computes everything, then records the run + results in one
 *  transaction). */
export async function createCalculationRun(
  pool: Pool,
  data: {
    editionId: string;
    runType: CalculationRunType;
    methodologyVersion?: string | null;
    datasetHash: string;
    status?: CalculationRunStatus;
    methodologyStatus?: 'TEST_UNAPPROVED' | 'APPROVED' | null;
  },
): Promise<CalculationRun> {
  const result = await query<RawRunRow>(
    pool,
    `INSERT INTO calculation_runs
       (edition_id, run_type, methodology_version, dataset_hash, status, methodology_status, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6, NOW())
     RETURNING *`,
    [
      data.editionId,
      data.runType,
      data.methodologyVersion ?? null,
      data.datasetHash,
      data.status ?? 'complete',
      data.methodologyStatus ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Calculation run insert returned no rows');
  return mapRun(row);
}

export async function getCalculationRun(pool: Pool, id: string): Promise<CalculationRun | null> {
  const result = await query<RawRunRow>(pool, 'SELECT * FROM calculation_runs WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

export async function listCalculationRuns(
  pool: Pool,
  editionId: string,
  runType?: CalculationRunType,
): Promise<CalculationRun[]> {
  const result = await query<RawRunRow>(
    pool,
    runType
      ? `SELECT * FROM calculation_runs WHERE edition_id = $1 AND run_type = $2 ORDER BY created_at DESC`
      : `SELECT * FROM calculation_runs WHERE edition_id = $1 ORDER BY created_at DESC`,
    runType ? [editionId, runType] : [editionId],
  );
  return result.rows.map(mapRun);
}

// ─── calculated_results ────────────────────────────────────────────────────────

interface RawResultRow {
  id: string;
  calculation_run_id: string;
  subject_type: SubjectType;
  subject_id: string;
  metric_code: string;
  value: string | null;
  band: string | null;
  n: number;
  denominator: number;
  sufficiency_state: SufficiencyState;
  reason: string | null;
  composition: CalculatedResultComposition[] | null;
  created_at: Date;
}

function mapResult(row: RawResultRow): CalculatedResult {
  return {
    id: row.id,
    calculationRunId: row.calculation_run_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    metricCode: row.metric_code,
    value: row.value === null ? null : Number(row.value),
    band: row.band,
    n: row.n,
    denominator: row.denominator,
    sufficiencyState: row.sufficiency_state,
    reason: row.reason,
    composition: row.composition,
    createdAt: row.created_at,
  };
}

export async function insertCalculatedResult(
  pool: Pool,
  data: {
    calculationRunId: string;
    subjectType: SubjectType;
    subjectId: string;
    metricCode: string;
    value?: number | null;
    band?: string | null;
    n: number;
    denominator: number;
    sufficiencyState: SufficiencyState;
    reason?: string | null;
    composition?: CalculatedResultComposition[] | null;
  },
): Promise<CalculatedResult> {
  const result = await query<RawResultRow>(
    pool,
    `INSERT INTO calculated_results
       (calculation_run_id, subject_type, subject_id, metric_code, value, band, n, denominator, sufficiency_state, reason, composition)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.calculationRunId,
      data.subjectType,
      data.subjectId,
      data.metricCode,
      data.value ?? null,
      data.band ?? null,
      data.n,
      data.denominator,
      data.sufficiencyState,
      data.reason ?? null,
      data.composition !== undefined ? JSON.stringify(data.composition) : null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Calculated result insert returned no rows');
  return mapResult(row);
}

export async function getCalculatedResult(
  pool: Pool,
  id: string,
): Promise<CalculatedResult | null> {
  const result = await query<RawResultRow>(pool, 'SELECT * FROM calculated_results WHERE id = $1', [
    id,
  ]);
  const row = result.rows[0];
  return row ? mapResult(row) : null;
}

export async function listCalculatedResults(
  pool: Pool,
  calculationRunId: string,
): Promise<CalculatedResult[]> {
  const result = await query<RawResultRow>(
    pool,
    'SELECT * FROM calculated_results WHERE calculation_run_id = $1 ORDER BY subject_type, subject_id, metric_code',
    [calculationRunId],
  );
  return result.rows.map(mapResult);
}

// ─── eligibility_results ───────────────────────────────────────────────────────

interface RawEligibilityRow {
  id: string;
  calculation_run_id: string;
  subject_type: 'firm' | 'segment';
  subject_id: string;
  segment: string | null;
  counted: number;
  floor: number;
  eligible: boolean;
  created_at: Date;
}

function mapEligibility(row: RawEligibilityRow): EligibilityResult {
  return {
    id: row.id,
    calculationRunId: row.calculation_run_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    segment: row.segment,
    counted: row.counted,
    floor: row.floor,
    eligible: row.eligible,
    createdAt: row.created_at,
  };
}

export async function insertEligibilityResult(
  pool: Pool,
  data: {
    calculationRunId: string;
    subjectType: 'firm' | 'segment';
    subjectId: string;
    segment?: string | null;
    counted: number;
    floor: number;
    eligible: boolean;
  },
): Promise<EligibilityResult> {
  const result = await query<RawEligibilityRow>(
    pool,
    `INSERT INTO eligibility_results
       (calculation_run_id, subject_type, subject_id, segment, counted, floor, eligible)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      data.calculationRunId,
      data.subjectType,
      data.subjectId,
      data.segment ?? null,
      data.counted,
      data.floor,
      data.eligible,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Eligibility result insert returned no rows');
  return mapEligibility(row);
}

export async function listEligibilityResults(
  pool: Pool,
  calculationRunId: string,
): Promise<EligibilityResult[]> {
  const result = await query<RawEligibilityRow>(
    pool,
    'SELECT * FROM eligibility_results WHERE calculation_run_id = $1 ORDER BY subject_type, subject_id',
    [calculationRunId],
  );
  return result.rows.map(mapEligibility);
}
