import { Pool } from 'pg';
import type { ScoringSignoff, ScoringSignoffState, ScoringCheckedAccount } from '@cis/shared-types';
import { query } from '../client';

/**
 * scoring_signoffs — the record that designates which scoring run is
 * authoritative. Write paths are narrow: create a request, approve it, or mark
 * it superseded. Rows are never deleted (the scoring history is permanent), so
 * a superseded run's who/when stays queryable indefinitely.
 */

interface RawSignoffRow {
  id: string;
  edition_id: string;
  calculation_run_id: string;
  state: ScoringSignoffState;
  checked_account: ScoringCheckedAccount;
  requested_by: string;
  requested_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  superseded_by: string | null;
  superseded_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapSignoff(r: RawSignoffRow): ScoringSignoff {
  return {
    id: r.id,
    editionId: r.edition_id,
    calculationRunId: r.calculation_run_id,
    state: r.state,
    checkedAccount: r.checked_account,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    supersededBy: r.superseded_by,
    supersededAt: r.superseded_at,
    rejectedBy: r.rejected_by,
    rejectedAt: r.rejected_at,
    rejectionReason: r.rejection_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createSignoff(
  pool: Pool,
  data: {
    editionId: string;
    calculationRunId: string;
    requestedBy: string;
    checkedAccount: ScoringCheckedAccount;
  },
): Promise<ScoringSignoff> {
  const res = await query<RawSignoffRow>(
    pool,
    `INSERT INTO scoring_signoffs
       (edition_id, calculation_run_id, requested_by, checked_account)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [data.editionId, data.calculationRunId, data.requestedBy, JSON.stringify(data.checkedAccount)],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Scoring sign-off insert returned no rows');
  return mapSignoff(row);
}

export async function getSignoff(pool: Pool, id: string): Promise<ScoringSignoff | null> {
  const res = await query<RawSignoffRow>(pool, 'SELECT * FROM scoring_signoffs WHERE id = $1', [
    id,
  ]);
  const row = res.rows[0];
  return row ? mapSignoff(row) : null;
}

/** The live (requested or signed_off) sign-off for a run, if any. */
export async function getLiveSignoffForRun(
  pool: Pool,
  calculationRunId: string,
): Promise<ScoringSignoff | null> {
  const res = await query<RawSignoffRow>(
    pool,
    `SELECT * FROM scoring_signoffs
      WHERE calculation_run_id = $1 AND state IN ('requested','signed_off')
      LIMIT 1`,
    [calculationRunId],
  );
  const row = res.rows[0];
  return row ? mapSignoff(row) : null;
}

/**
 * Approve a requested sign-off. Guarded so it fires exactly once, only from
 * `requested`, and only by someone other than the requester (the DB CHECK is
 * the backstop; this WHERE clause turns a violation into a clean no-row result).
 */
export async function approveSignoffRow(
  pool: Pool,
  id: string,
  approvedBy: string,
): Promise<ScoringSignoff | null> {
  const res = await query<RawSignoffRow>(
    pool,
    `UPDATE scoring_signoffs
        SET state = 'signed_off', approved_by = $2, approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND state = 'requested' AND requested_by <> $2
      RETURNING *`,
    [id, approvedBy],
  );
  const row = res.rows[0];
  return row ? mapSignoff(row) : null;
}

/**
 * Reject a requested sign-off. Guarded so it fires exactly once, only from
 * `requested`, and only by someone other than the requester (the DB CHECK is
 * the backstop; this WHERE clause turns a violation into a clean no-row
 * result) — same shape as `approveSignoffRow`. A rejected row is not "live",
 * so the run remains free for a fresh sign-off request afterwards.
 */
export async function rejectSignoffRow(
  pool: Pool,
  id: string,
  rejectedBy: string,
  reason: string,
): Promise<ScoringSignoff | null> {
  const res = await query<RawSignoffRow>(
    pool,
    `UPDATE scoring_signoffs
        SET state = 'rejected', rejected_by = $2, rejected_at = NOW(),
            rejection_reason = $3, updated_at = NOW()
      WHERE id = $1 AND state = 'requested' AND requested_by <> $2
      RETURNING *`,
    [id, rejectedBy, reason],
  );
  const row = res.rows[0];
  return row ? mapSignoff(row) : null;
}

/**
 * Mark every currently-signed-off sign-off for an edition as superseded by a
 * newer one — EXCEPT the new one itself. Called only at the moment a later run
 * is signed off, never merely when it is run.
 */
export async function supersedePriorSignoffs(
  pool: Pool,
  editionId: string,
  newSignoffId: string,
): Promise<number> {
  const res = await query(
    pool,
    `UPDATE scoring_signoffs
        SET state = 'superseded', superseded_by = $2, superseded_at = NOW(), updated_at = NOW()
      WHERE edition_id = $1 AND state = 'signed_off' AND id <> $2`,
    [editionId, newSignoffId],
  );
  return res.rowCount ?? 0;
}

/** Whether a specific run has a genuine `signed_off` record. The real check
 *  Phase 6's report-approval preconditions gate on (replacing the old
 *  completed-status proxy). */
export async function hasSignedOffRun(pool: Pool, calculationRunId: string): Promise<boolean> {
  const res = await query<{ n: string }>(
    pool,
    `SELECT COUNT(*)::text AS n FROM scoring_signoffs
      WHERE calculation_run_id = $1 AND state = 'signed_off'`,
    [calculationRunId],
  );
  return parseInt(res.rows[0]?.n ?? '0', 10) > 0;
}

/** The current authoritative (signed_off, not superseded) sign-off for an
 *  edition, if one exists. */
export async function getAuthoritativeSignoff(
  pool: Pool,
  editionId: string,
): Promise<ScoringSignoff | null> {
  const res = await query<RawSignoffRow>(
    pool,
    `SELECT * FROM scoring_signoffs
      WHERE edition_id = $1 AND state = 'signed_off'
      ORDER BY approved_at DESC
      LIMIT 1`,
    [editionId],
  );
  const row = res.rows[0];
  return row ? mapSignoff(row) : null;
}

/** Full sign-off history for an edition — newest first, superseded rows kept. */
export async function listSignoffs(pool: Pool, editionId: string): Promise<ScoringSignoff[]> {
  const res = await query<RawSignoffRow>(
    pool,
    'SELECT * FROM scoring_signoffs WHERE edition_id = $1 ORDER BY requested_at DESC',
    [editionId],
  );
  return res.rows.map(mapSignoff);
}
