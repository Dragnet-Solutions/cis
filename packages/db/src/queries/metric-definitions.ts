import { Pool } from 'pg';
import type { MetricDefinition } from '@cis/shared-types';
import { query } from '../client';

interface RawMetricRow {
  id: string;
  metric_code: string;
  version: number;
  config: MetricDefinition['config'];
  is_provisional: boolean;
  is_active: boolean;
  description: string | null;
  created_at: Date;
}

function mapMetric(row: RawMetricRow): MetricDefinition {
  return {
    id: row.id,
    metricCode: row.metric_code,
    version: row.version,
    config: row.config,
    isProvisional: row.is_provisional,
    isActive: row.is_active,
    description: row.description,
    createdAt: row.created_at,
  };
}

/** The five top-level indices. Sub-components may be added as further rows. */
export const INDEX_CODES = ['OMI', 'DMI', 'IEI', 'ICI', 'SEI'] as const;

/**
 * The per-index POPULATION predicate — which firms/respondents an index is
 * computed over. This is configuration, not code: an index gated on a
 * population it does not need withholds a measure the data supports, so each
 * index states its own. Stored inside metric_definitions.config.population.
 *
 * `firm_seats_complete` counts firms whose named seats are ALL complete:
 *   - OMI needs S1, S2 AND S3 (a fully-responding firm).
 *   - DMI needs S1 and S3 only — S2 (compliance) is irrelevant to digital
 *     maturity and must not be required.
 * `investor_responses` / `matched_pairs` are investor-side and the artefact does
 * not specify their exact predicate — they are marked `gap: true` so the surface
 * shows them as an unresolved methodology item rather than inventing a rule.
 * These are DISTINCT from the general ≥1-seat study-participation eligibility
 * used for the 80-firm floor (see eligibility-service) — never reuse that set.
 */
export type IndexPopulationPredicate =
  | { kind: 'firm_seats_complete'; seats: Array<'S1' | 'S2' | 'S3'>; gap?: false; note?: string }
  | { kind: 'investor_responses'; gap: true; note: string }
  | { kind: 'matched_pairs'; gap: true; note: string };

const INDEX_POPULATION: Record<(typeof INDEX_CODES)[number], IndexPopulationPredicate> = {
  OMI: { kind: 'firm_seats_complete', seats: ['S1', 'S2', 'S3'] },
  DMI: { kind: 'firm_seats_complete', seats: ['S1', 'S3'] },
  IEI: {
    kind: 'investor_responses',
    gap: true,
    note: 'Investor-side population predicate not yet specified by the scoring design — pending methodology.',
  },
  ICI: {
    kind: 'investor_responses',
    gap: true,
    note: 'Investor-side population predicate not yet specified by the scoring design — pending methodology.',
  },
  SEI: {
    kind: 'matched_pairs',
    gap: true,
    note: 'Service-excellence gap is measured across matched firm/investor pairs; predicate pending methodology (flagged).',
  },
};

export async function insertMetricDefinition(
  pool: Pool,
  data: {
    metricCode: string;
    version: number;
    config: MetricDefinition['config'];
    isProvisional?: boolean;
    isActive?: boolean;
    description?: string | null;
  },
): Promise<MetricDefinition> {
  const result = await query<RawMetricRow>(
    pool,
    `INSERT INTO metric_definitions
       (metric_code, version, config, is_provisional, is_active, description)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      data.metricCode,
      data.version,
      JSON.stringify(data.config),
      data.isProvisional ?? true,
      data.isActive ?? true,
      data.description ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Metric definition insert returned no rows');
  return mapMetric(row);
}

/** The active configuration for each metric (highest active version wins). */
export async function getActiveMetricDefinitions(pool: Pool): Promise<MetricDefinition[]> {
  const result = await query<RawMetricRow>(
    pool,
    `SELECT DISTINCT ON (metric_code) *
       FROM metric_definitions
      WHERE is_active = TRUE
      ORDER BY metric_code, version DESC`,
  );
  return result.rows.map(mapMetric);
}

export async function getMetricDefinitionsByVersion(
  pool: Pool,
  version: number,
): Promise<MetricDefinition[]> {
  const result = await query<RawMetricRow>(
    pool,
    'SELECT * FROM metric_definitions WHERE version = $1 ORDER BY metric_code',
    [version],
  );
  return result.rows.map(mapMetric);
}

/**
 * Seed a PROVISIONAL, clearly-marked placeholder configuration for the five
 * indices: equal weighting, no settled question mapping. This exists so the
 * framework runs end-to-end; it is NOT Dragnet's validated methodology and must
 * be replaced (a new version row) once that is approved — no code deploy needed.
 */
export async function seedProvisionalMetricDefinitions(pool: Pool): Promise<void> {
  for (const code of INDEX_CODES) {
    await query(
      pool,
      `INSERT INTO metric_definitions (metric_code, version, config, is_provisional, is_active, description)
       VALUES ($1, 1, $2, TRUE, TRUE, $3)
       ON CONFLICT (metric_code, version) DO NOTHING`,
      [
        code,
        JSON.stringify({
          questionIds: [],
          aggregation: 'equal_weight_mean',
          provisional: true,
          // Per-index population predicate (Phase 7) — configuration, not code.
          population: INDEX_POPULATION[code],
          note: 'PLACEHOLDER — equal weighting, no settled question mapping. Replace with Dragnet validated methodology (new version).',
        }),
        `PROVISIONAL placeholder for ${code} — pending Dragnet validated weighting.`,
      ],
    );
  }
}
