import { Pool } from 'pg';
import type { EditionSampleFloor, SampleFloorCategory } from '@cis/shared-types';
import { query } from '../client';

interface RawFloorRow {
  id: string;
  edition_id: string;
  category: string;
  floor_value: number;
  created_at: Date;
  updated_at: Date;
}

function mapFloor(row: RawFloorRow): EditionSampleFloor {
  return {
    id: row.id,
    editionId: row.edition_id,
    category: row.category as SampleFloorCategory,
    floorValue: row.floor_value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSampleFloors(
  pool: Pool,
  editionId: string,
): Promise<EditionSampleFloor[]> {
  const result = await query<RawFloorRow>(
    pool,
    `SELECT * FROM edition_sample_floors WHERE edition_id = $1 ORDER BY category`,
    [editionId],
  );
  return result.rows.map(mapFloor);
}

export async function getSampleFloor(
  pool: Pool,
  editionId: string,
  category: SampleFloorCategory,
): Promise<EditionSampleFloor | null> {
  const result = await query<RawFloorRow>(
    pool,
    `SELECT * FROM edition_sample_floors WHERE edition_id = $1 AND category = $2`,
    [editionId, category],
  );
  const row = result.rows[0];
  return row ? mapFloor(row) : null;
}

/**
 * Upsert one category's floor for an edition. Editability (draft-only) is
 * enforced by the edition service before this is called; this function only
 * writes.
 */
export async function upsertSampleFloor(
  pool: Pool,
  data: { editionId: string; category: SampleFloorCategory; floorValue: number },
): Promise<EditionSampleFloor> {
  const result = await query<RawFloorRow>(
    pool,
    `INSERT INTO edition_sample_floors (edition_id, category, floor_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (edition_id, category)
       DO UPDATE SET floor_value = EXCLUDED.floor_value, updated_at = NOW()
     RETURNING *`,
    [data.editionId, data.category, data.floorValue],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Sample floor upsert returned no rows');
  return mapFloor(row);
}
