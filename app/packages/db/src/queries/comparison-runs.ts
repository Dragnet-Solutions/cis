import { Pool } from 'pg';
import { query } from '../client';

/**
 * comparison_runs — like-for-like cross-edition recalculation
 * (LIKE_FOR_LIKE_RECALCULATED). References two prior signed runs, restates both
 * on the common reportable segment set, preserves both original headlines.
 * Immutable (DB trigger); never mutates a source run.
 */

export interface ComparisonRun {
  id: string;
  editionAId: string;
  editionBId: string;
  runAId: string;
  runBId: string;
  metricCode: string;
  methodologyVersion: string;
  commonSegments: string[];
  label: 'LIKE_FOR_LIKE_RECALCULATED';
  originalHeadlineA: number | null;
  originalHeadlineB: number | null;
  recalculatedA: number | null;
  recalculatedB: number | null;
  createdAt: Date;
}

interface RawRow {
  id: string;
  edition_a_id: string;
  edition_b_id: string;
  run_a_id: string;
  run_b_id: string;
  metric_code: string;
  methodology_version: string;
  common_segments: string[];
  label: 'LIKE_FOR_LIKE_RECALCULATED';
  original_headline_a: string | null;
  original_headline_b: string | null;
  recalculated_a: string | null;
  recalculated_b: string | null;
  created_at: Date;
}

function map(r: RawRow): ComparisonRun {
  const num = (v: string | null) => (v === null ? null : Number(v));
  return {
    id: r.id,
    editionAId: r.edition_a_id,
    editionBId: r.edition_b_id,
    runAId: r.run_a_id,
    runBId: r.run_b_id,
    metricCode: r.metric_code,
    methodologyVersion: r.methodology_version,
    commonSegments: r.common_segments,
    label: r.label,
    originalHeadlineA: num(r.original_headline_a),
    originalHeadlineB: num(r.original_headline_b),
    recalculatedA: num(r.recalculated_a),
    recalculatedB: num(r.recalculated_b),
    createdAt: r.created_at,
  };
}

export async function createComparisonRun(
  pool: Pool,
  data: {
    editionAId: string;
    editionBId: string;
    runAId: string;
    runBId: string;
    metricCode: string;
    methodologyVersion: string;
    commonSegments: string[];
    originalHeadlineA: number | null;
    originalHeadlineB: number | null;
    recalculatedA: number | null;
    recalculatedB: number | null;
  },
): Promise<ComparisonRun> {
  const res = await query<RawRow>(
    pool,
    `INSERT INTO comparison_runs
       (edition_a_id, edition_b_id, run_a_id, run_b_id, metric_code, methodology_version,
        common_segments, original_headline_a, original_headline_b, recalculated_a, recalculated_b)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      data.editionAId,
      data.editionBId,
      data.runAId,
      data.runBId,
      data.metricCode,
      data.methodologyVersion,
      JSON.stringify(data.commonSegments),
      data.originalHeadlineA,
      data.originalHeadlineB,
      data.recalculatedA,
      data.recalculatedB,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Comparison run insert returned no rows');
  return map(row);
}

export async function getComparisonRun(pool: Pool, id: string): Promise<ComparisonRun | null> {
  const res = await query<RawRow>(pool, 'SELECT * FROM comparison_runs WHERE id = $1', [id]);
  const row = res.rows[0];
  return row ? map(row) : null;
}
