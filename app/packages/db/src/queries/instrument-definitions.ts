import { Pool } from 'pg';
import type {
  InstrumentDefinition,
  InstrumentDefinitionVersion,
  EditionInstrumentSnapshot,
  InstrumentType,
} from '@cis/shared-types';
import { query } from '../client';

// ─── Row mappers ──────────────────────────────────────────────────────────────

interface RawInstrumentDefRow {
  id: string;
  code: string;
  name: string;
  instrument_type: string;
  scored: boolean;
  created_at: Date;
}

interface RawInstrumentDefVersionRow {
  id: string;
  instrument_definition_id: string;
  version_number: number;
  schema_snapshot: Record<string, unknown>;
  is_frozen: boolean;
  created_at: Date;
  created_by: string | null;
  frozen_at: Date | null;
  frozen_by: string | null;
}

interface RawSnapshotRow {
  id: string;
  edition_id: string;
  instrument_definition_version_id: string;
  frozen_at: Date;
  frozen_by: string | null;
}

function mapDef(row: RawInstrumentDefRow): InstrumentDefinition {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    instrumentType: row.instrument_type as InstrumentType,
    scored: row.scored,
    createdAt: row.created_at,
  };
}

function mapVersion(row: RawInstrumentDefVersionRow): InstrumentDefinitionVersion {
  return {
    id: row.id,
    instrumentDefinitionId: row.instrument_definition_id,
    versionNumber: row.version_number,
    schemaSnapshot: row.schema_snapshot,
    isFrozen: row.is_frozen,
    createdAt: row.created_at,
    createdBy: row.created_by,
    frozenAt: row.frozen_at,
    frozenBy: row.frozen_by,
  };
}

function mapSnapshot(row: RawSnapshotRow): EditionInstrumentSnapshot {
  return {
    id: row.id,
    editionId: row.edition_id,
    instrumentDefinitionVersionId: row.instrument_definition_version_id,
    frozenAt: row.frozen_at,
    frozenBy: row.frozen_by,
  };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function createInstrumentDefinition(
  pool: Pool,
  data: { code: string; name: string; instrumentType?: InstrumentType; scored?: boolean },
): Promise<InstrumentDefinition> {
  const result = await query<RawInstrumentDefRow>(
    pool,
    `INSERT INTO instrument_definitions (code, name, instrument_type, scored)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.code, data.name, data.instrumentType ?? 'survey', data.scored ?? true],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Instrument definition insert returned no rows');
  return mapDef(row);
}

export async function listInstrumentDefinitions(pool: Pool): Promise<InstrumentDefinition[]> {
  const result = await query<RawInstrumentDefRow>(
    pool,
    'SELECT * FROM instrument_definitions ORDER BY code',
  );
  return result.rows.map(mapDef);
}

/** Latest (highest version_number) version for an instrument definition. */
export async function getLatestInstrumentVersion(
  pool: Pool,
  instrumentDefinitionId: string,
): Promise<InstrumentDefinitionVersion | null> {
  const result = await query<RawInstrumentDefVersionRow>(
    pool,
    `SELECT * FROM instrument_definition_versions
     WHERE instrument_definition_id = $1
     ORDER BY version_number DESC
     LIMIT 1`,
    [instrumentDefinitionId],
  );
  const row = result.rows[0];
  return row ? mapVersion(row) : null;
}

export async function createInstrumentDefinitionVersion(
  pool: Pool,
  data: {
    instrumentDefinitionId: string;
    versionNumber: number;
    schemaSnapshot?: Record<string, unknown>;
    createdBy?: string;
  },
): Promise<InstrumentDefinitionVersion> {
  const result = await query<RawInstrumentDefVersionRow>(
    pool,
    `INSERT INTO instrument_definition_versions
       (instrument_definition_id, version_number, schema_snapshot, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      data.instrumentDefinitionId,
      data.versionNumber,
      JSON.stringify(data.schemaSnapshot ?? {}),
      data.createdBy ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Instrument definition version insert returned no rows');
  return mapVersion(row);
}

export async function freezeInstrumentDefinitionVersion(
  pool: Pool,
  versionId: string,
  frozenBy: string | null,
): Promise<InstrumentDefinitionVersion> {
  const result = await query<RawInstrumentDefVersionRow>(
    pool,
    `UPDATE instrument_definition_versions
     SET is_frozen = TRUE, frozen_at = NOW(), frozen_by = $1
     WHERE id = $2 AND is_frozen = FALSE
     RETURNING *`,
    [frozenBy, versionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Version ${versionId} not found or already frozen`);
  return mapVersion(row);
}

export async function createEditionInstrumentSnapshot(
  pool: Pool,
  data: {
    editionId: string;
    instrumentDefinitionVersionId: string;
    frozenBy: string | null;
  },
): Promise<EditionInstrumentSnapshot> {
  const result = await query<RawSnapshotRow>(
    pool,
    `INSERT INTO edition_instrument_snapshots
       (edition_id, instrument_definition_version_id, frozen_by)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [data.editionId, data.instrumentDefinitionVersionId, data.frozenBy],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Edition instrument snapshot insert returned no rows');
  return mapSnapshot(row);
}

export async function getEditionInstrumentSnapshots(
  pool: Pool,
  editionId: string,
): Promise<EditionInstrumentSnapshot[]> {
  const result = await query<RawSnapshotRow>(
    pool,
    `SELECT eis.* FROM edition_instrument_snapshots eis
       JOIN instrument_definition_versions idv
         ON idv.id = eis.instrument_definition_version_id
       JOIN instrument_definitions d ON d.id = idv.instrument_definition_id
      WHERE eis.edition_id = $1 AND d.retired_at IS NULL`,
    [editionId],
  );
  return result.rows.map(mapSnapshot);
}

/**
 * The single authoritative answer to "is this edition's survey set frozen?".
 *
 * Frozen means the edition's instrument set has been frozen: it holds
 * snapshot rows (the first freeze snapshots every instrument in one
 * transaction). Only instruments already part of the edition count, so an
 * instrument registered afterwards does not unfreeze an open, collecting
 * edition; it is pending for this edition until its own maker-checker freeze
 * adds it (instrument-service). A derived query, not a mutable flag.
 */
export async function isEditionInstrumentSetFrozen(
  pool: Pool,
  editionId: string,
): Promise<boolean> {
  // The edition's instrument set is the instruments frozen into it. Once the
  // first freeze is approved the edition is frozen for good: an instrument
  // registered later (e.g. I-LCFE) is PENDING for this edition — listed by
  // `listInstrumentsNotFrozenForEdition` and added by its own maker-checker
  // freeze — and never makes an open, collecting edition read as unfrozen.
  const result = await query<{ frozen: boolean }>(
    pool,
    `SELECT EXISTS (
       SELECT 1 FROM edition_instrument_snapshots eis
         JOIN instrument_definition_versions idv
           ON idv.id = eis.instrument_definition_version_id
         JOIN instrument_definitions d ON d.id = idv.instrument_definition_id
        WHERE eis.edition_id = $1 AND d.retired_at IS NULL
     ) AS frozen`,
    [editionId],
  );
  return result.rows[0]?.frozen === true;
}

/** Instrument codes with no snapshot in this edition, in code order: every
 *  instrument before the first freeze; afterwards, only ones registered since. */
export async function listInstrumentsNotFrozenForEdition(
  db: Pick<Pool, 'query'>,
  editionId: string,
): Promise<string[]> {
  const result = await db.query<{ code: string }>(
    `SELECT d.code FROM instrument_definitions d
      WHERE d.retired_at IS NULL
        AND NOT EXISTS (
        SELECT 1 FROM edition_instrument_snapshots eis
          JOIN instrument_definition_versions idv
            ON idv.id = eis.instrument_definition_version_id
         WHERE eis.edition_id = $1 AND idv.instrument_definition_id = d.id)
      ORDER BY d.code`,
    [editionId],
  );
  return result.rows.map((r) => r.code);
}

/** Whether this instrument has a snapshot in this edition. */
export async function isInstrumentFrozenForEdition(
  pool: Pool,
  editionId: string,
  instrumentCode: string,
): Promise<boolean> {
  const result = await query<{ frozen: boolean }>(
    pool,
    `SELECT EXISTS (
       SELECT 1 FROM edition_instrument_snapshots eis
         JOIN instrument_definition_versions idv
           ON idv.id = eis.instrument_definition_version_id
         JOIN instrument_definitions d ON d.id = idv.instrument_definition_id
        WHERE eis.edition_id = $1 AND d.code = $2 AND d.retired_at IS NULL
     ) AS frozen`,
    [editionId, instrumentCode],
  );
  return result.rows[0]?.frozen === true;
}

/**
 * Instruments as shown on the Survey setup surface for an edition: definition
 * metadata plus whether that instrument is frozen into this edition. Question
 * text is not returned here (that is Phase 2 runtime).
 */
export interface EditionInstrumentView {
  definition: InstrumentDefinition;
  frozen: boolean;
  questionCount: number;
  /** Latest version's schema snapshot — carries display metadata (feeds, respondent). */
  meta: Record<string, unknown>;
}

export async function getEditionInstrumentViews(
  pool: Pool,
  editionId: string,
): Promise<EditionInstrumentView[]> {
  const result = await query<
    RawInstrumentDefRow & {
      frozen: boolean;
      question_count: string;
      meta: Record<string, unknown> | null;
    }
  >(
    pool,
    `SELECT d.*,
            EXISTS (
              SELECT 1 FROM edition_instrument_snapshots eis
              JOIN instrument_definition_versions idv
                ON idv.id = eis.instrument_definition_version_id
              WHERE eis.edition_id = $1
                AND idv.instrument_definition_id = d.id
            ) AS frozen,
            (SELECT COUNT(*) FROM instrument_questions q
              WHERE q.instrument_definition_id = d.id)::text AS question_count,
            (SELECT idv.schema_snapshot FROM instrument_definition_versions idv
              WHERE idv.instrument_definition_id = d.id
              ORDER BY idv.version_number DESC LIMIT 1) AS meta
       FROM instrument_definitions d
      WHERE d.retired_at IS NULL
      ORDER BY d.code`,
    [editionId],
  );
  return result.rows.map((row) => ({
    definition: mapDef(row),
    frozen: row.frozen,
    questionCount: parseInt(row.question_count, 10),
    meta: row.meta ?? {},
  }));
}
