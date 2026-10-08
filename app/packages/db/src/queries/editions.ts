import { Pool } from 'pg';
import type { Edition, EditionStatus } from '@cis/shared-types';
import { query } from '../client';

// ─── Row mapper ───────────────────────────────────────────────────────────────

interface RawEditionRow {
  id: string;
  label: string;
  status: string;
  survey_open_at: Date | null;
  planned_open_at: Date | null;
  survey_close_at: Date | null;
  results_published_at: Date | null;
  prior_edition_id: string | null;
  locked_at: Date | null;
  locked_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapEdition(row: RawEditionRow): Edition {
  return {
    id: row.id,
    label: row.label,
    status: row.status as EditionStatus,
    surveyOpenAt: row.survey_open_at,
    plannedOpenAt: row.planned_open_at,
    surveyCloseAt: row.survey_close_at,
    resultsPublishedAt: row.results_published_at,
    priorEditionId: row.prior_edition_id,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function createEdition(
  pool: Pool,
  data: { label: string; priorEditionId?: string | null },
): Promise<Edition> {
  const result = await query<RawEditionRow>(
    pool,
    `INSERT INTO editions (label, prior_edition_id)
     VALUES ($1, $2)
     RETURNING *`,
    [data.label, data.priorEditionId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Edition insert returned no rows');
  return mapEdition(row);
}

export async function getEditionById(pool: Pool, id: string): Promise<Edition | null> {
  const result = await query<RawEditionRow>(pool, 'SELECT * FROM editions WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? mapEdition(row) : null;
}

export async function getEditionByLabel(pool: Pool, label: string): Promise<Edition | null> {
  const result = await query<RawEditionRow>(pool, 'SELECT * FROM editions WHERE label = $1', [
    label,
  ]);
  const row = result.rows[0];
  return row ? mapEdition(row) : null;
}

export async function listEditions(pool: Pool): Promise<Edition[]> {
  const result = await query<RawEditionRow>(
    pool,
    'SELECT * FROM editions ORDER BY created_at DESC',
  );
  return result.rows.map(mapEdition);
}

export async function updateEditionStatus(
  pool: Pool,
  id: string,
  status: EditionStatus,
): Promise<Edition> {
  const result = await query<RawEditionRow>(
    pool,
    `UPDATE editions
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [status, id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Edition ${id} not found`);
  return mapEdition(row);
}

/**
 * Set the "last day for returns" date. Callers (the edition service) enforce
 * the editability rule; this function only writes.
 */
export async function updateClosingDate(pool: Pool, id: string, closesAt: Date): Promise<Edition> {
  const result = await query<RawEditionRow>(
    pool,
    `UPDATE editions
     SET survey_close_at = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [closesAt, id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Edition ${id} not found`);
  return mapEdition(row);
}

/**
 * Set the study-team-configured launch instant (Phase 19, item 2). Callers
 * (the edition service) enforce the editability rule; this function only
 * writes. `null` clears a previously-set plan.
 */
export async function updatePlannedOpenAt(
  pool: Pool,
  id: string,
  plannedOpenAt: Date | null,
): Promise<Edition> {
  const result = await query<RawEditionRow>(
    pool,
    `UPDATE editions
     SET planned_open_at = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [plannedOpenAt, id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Edition ${id} not found`);
  return mapEdition(row);
}

/**
 * Transition draft → open. Guarded to fire only from draft, so the transition
 * can happen exactly once. Callers must have already verified the instrument
 * set is frozen (see the edition service's markOpened).
 */
export async function openEditionFromDraft(pool: Pool, id: string): Promise<Edition> {
  const result = await query<RawEditionRow>(
    pool,
    `UPDATE editions
     SET status = 'open', survey_open_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'draft'
     RETURNING *`,
    [id],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Edition ${id} could not be opened (not found or not in draft)`);
  }
  return mapEdition(row);
}

export async function lockEdition(pool: Pool, id: string, lockedBy: string): Promise<Edition> {
  const result = await query<RawEditionRow>(
    pool,
    `UPDATE editions
     SET status = 'locked', locked_at = NOW(), locked_by = $1, updated_at = NOW()
     WHERE id = $2 AND status != 'locked'
     RETURNING *`,
    [lockedBy, id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Edition ${id} not found or is already locked`);
  return mapEdition(row);
}
