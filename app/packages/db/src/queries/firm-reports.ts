import { Pool } from 'pg';
import type {
  FirmReport,
  FirmReportCutState,
  FirmReportGenerationState,
  FirmReportApprovalState,
  FirmReportReleaseState,
  FirmReportReleaseHistory,
} from '@cis/shared-types';
import { query } from '../client';

interface RawFirmReportRow {
  id: string;
  edition_id: string;
  organization_id: string;
  scoring_run_id: string;
  version: number;
  retail_n: number;
  cut_state: FirmReportCutState;
  generation_state: FirmReportGenerationState;
  approval_state: FirmReportApprovalState;
  release_state: FirmReportReleaseState;
  held_reason: string | null;
  released_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapFirmReport(r: RawFirmReportRow): FirmReport {
  return {
    id: r.id,
    editionId: r.edition_id,
    organizationId: r.organization_id,
    scoringRunId: r.scoring_run_id,
    version: r.version,
    retailN: r.retail_n,
    cutState: r.cut_state,
    generationState: r.generation_state,
    approvalState: r.approval_state,
    releaseState: r.release_state,
    heldReason: r.held_reason,
    releasedAt: r.released_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createFirmReport(
  pool: Pool,
  data: {
    editionId: string;
    organizationId: string;
    scoringRunId: string;
    version?: number;
    retailN: number;
    cutState: FirmReportCutState;
    generationState?: FirmReportGenerationState;
  },
): Promise<FirmReport> {
  const res = await query<RawFirmReportRow>(
    pool,
    `INSERT INTO firm_reports
       (edition_id, organization_id, scoring_run_id, version, retail_n, cut_state, generation_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      data.editionId,
      data.organizationId,
      data.scoringRunId,
      data.version ?? 1,
      data.retailN,
      data.cutState,
      data.generationState ?? 'pending',
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Firm report insert returned no rows');
  return mapFirmReport(row);
}

export async function getFirmReport(pool: Pool, id: string): Promise<FirmReport | null> {
  const res = await query<RawFirmReportRow>(pool, 'SELECT * FROM firm_reports WHERE id = $1', [id]);
  const row = res.rows[0];
  return row ? mapFirmReport(row) : null;
}

/** The latest-version firm reports for an edition (one row per firm). */
export async function listFirmReports(pool: Pool, editionId: string): Promise<FirmReport[]> {
  const res = await query<RawFirmReportRow>(
    pool,
    `SELECT DISTINCT ON (organization_id) *
       FROM firm_reports
      WHERE edition_id = $1
      ORDER BY organization_id, version DESC`,
    [editionId],
  );
  return res.rows.map(mapFirmReport);
}

export async function latestVersionFor(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<number> {
  const res = await query<{ v: number | null }>(
    pool,
    `SELECT MAX(version) AS v FROM firm_reports WHERE edition_id = $1 AND organization_id = $2`,
    [editionId, organizationId],
  );
  return res.rows[0]?.v ?? 0;
}

export async function setGenerationState(
  pool: Pool,
  id: string,
  state: FirmReportGenerationState,
): Promise<FirmReport> {
  const res = await query<RawFirmReportRow>(
    pool,
    `UPDATE firm_reports SET generation_state = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, state],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`Firm report ${id} not found`);
  return mapFirmReport(row);
}

export async function setApprovalState(
  pool: Pool,
  id: string,
  state: FirmReportApprovalState,
): Promise<FirmReport> {
  const res = await query<RawFirmReportRow>(
    pool,
    `UPDATE firm_reports SET approval_state = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, state],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`Firm report ${id} not found`);
  return mapFirmReport(row);
}

/** Move a report's release state. The DB trigger blocks any change to a row that
 *  is ALREADY released — corrections are a new version, never an edit. */
export async function setReleaseState(
  pool: Pool,
  id: string,
  state: FirmReportReleaseState,
  heldReason?: string | null,
): Promise<FirmReport> {
  const res = await query<RawFirmReportRow>(
    pool,
    `UPDATE firm_reports
        SET release_state = $2,
            held_reason = $3,
            released_at = CASE WHEN $2 = 'released' THEN NOW() ELSE released_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, state, heldReason ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`Firm report ${id} not found`);
  return mapFirmReport(row);
}

// ─── release history (append-only) ─────────────────────────────────────────────

interface RawHistoryRow {
  id: string;
  firm_report_id: string;
  edition_id: string;
  organization_id: string;
  action: 'released' | 'held' | 'regenerated';
  reason: string | null;
  occurred_at: Date;
}

function mapHistory(r: RawHistoryRow): FirmReportReleaseHistory {
  return {
    id: r.id,
    firmReportId: r.firm_report_id,
    editionId: r.edition_id,
    organizationId: r.organization_id,
    action: r.action,
    reason: r.reason,
    occurredAt: r.occurred_at,
  };
}

export async function insertReleaseHistory(
  pool: Pool,
  data: {
    firmReportId: string;
    editionId: string;
    organizationId: string;
    action: 'released' | 'held' | 'regenerated';
    reason?: string | null;
  },
): Promise<FirmReportReleaseHistory> {
  const res = await query<RawHistoryRow>(
    pool,
    `INSERT INTO firm_report_release_history
       (firm_report_id, edition_id, organization_id, action, reason)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.firmReportId, data.editionId, data.organizationId, data.action, data.reason ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Release history insert returned no rows');
  return mapHistory(row);
}

export async function listReleaseHistory(
  pool: Pool,
  editionId: string,
): Promise<FirmReportReleaseHistory[]> {
  const res = await query<RawHistoryRow>(
    pool,
    'SELECT * FROM firm_report_release_history WHERE edition_id = $1 ORDER BY occurred_at',
    [editionId],
  );
  return res.rows.map(mapHistory);
}

/** Whether any version of this firm's report for the edition has been released. */
export async function hasReleasedFirmReport(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<boolean> {
  const res = await query<{ released: boolean }>(
    pool,
    `SELECT EXISTS (
       SELECT 1 FROM firm_reports
        WHERE edition_id = $1 AND organization_id = $2 AND release_state = 'released'
     ) AS released`,
    [editionId, organizationId],
  );
  return res.rows[0]?.released ?? false;
}

// ─── openings (who has read a report before it is approved) ─────────────────────

/** Record that an operator opened a report. The first opening is kept; a later
 *  one changes nothing. */
export async function recordFirmReportOpening(
  pool: Pool,
  firmReportId: string,
  userId: string,
): Promise<void> {
  await query(
    pool,
    `INSERT INTO firm_report_openings (firm_report_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (firm_report_id, user_id) DO NOTHING`,
    [firmReportId, userId],
  );
}

export interface FirmReportOpening {
  firmReportId: string;
  userId: string;
  firstOpenedAt: Date;
}

/** Every recorded opening of the given reports. */
export async function listFirmReportOpenings(
  pool: Pool,
  firmReportIds: string[],
): Promise<FirmReportOpening[]> {
  if (firmReportIds.length === 0) return [];
  const res = await query<{ firm_report_id: string; user_id: string; first_opened_at: Date }>(
    pool,
    `SELECT firm_report_id, user_id, first_opened_at
       FROM firm_report_openings
      WHERE firm_report_id = ANY($1::uuid[])
      ORDER BY first_opened_at`,
    [firmReportIds],
  );
  return res.rows.map((r) => ({
    firmReportId: r.firm_report_id,
    userId: r.user_id,
    firstOpenedAt: r.first_opened_at,
  }));
}
