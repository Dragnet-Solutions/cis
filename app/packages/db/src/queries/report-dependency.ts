import { Pool } from 'pg';
import type { ReportDependency } from '@cis/shared-types';
import { query } from '../client';

interface RawDepRow {
  output_id: string;
  depends_on: string[];
  sufficiency_rule: string;
  enabled: boolean;
  required_instruments: string[] | null;
  updated_at: Date;
}

function mapDep(row: RawDepRow): ReportDependency {
  return {
    outputId: row.output_id,
    dependsOn: row.depends_on,
    sufficiencyRule: row.sufficiency_rule,
    enabled: row.enabled,
    requiredInstruments: row.required_instruments,
    updatedAt: row.updated_at,
  };
}

/** Runtime config the study team edits without a deploy. A firm-referencing
 *  output must declare `requiredInstruments` (UX-OPS-003 §B7). */
export async function upsertReportDependency(
  pool: Pool,
  data: {
    outputId: string;
    dependsOn: string[];
    sufficiencyRule: string;
    enabled?: boolean;
    requiredInstruments?: string[] | null;
  },
): Promise<ReportDependency> {
  const result = await query<RawDepRow>(
    pool,
    `INSERT INTO report_dependency (output_id, depends_on, sufficiency_rule, enabled, required_instruments)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (output_id) DO UPDATE
       SET depends_on = EXCLUDED.depends_on,
           sufficiency_rule = EXCLUDED.sufficiency_rule,
           enabled = EXCLUDED.enabled,
           required_instruments = EXCLUDED.required_instruments,
           updated_at = NOW()
     RETURNING *`,
    [
      data.outputId,
      JSON.stringify(data.dependsOn),
      data.sufficiencyRule,
      data.enabled ?? true,
      data.requiredInstruments === undefined || data.requiredInstruments === null
        ? null
        : JSON.stringify(data.requiredInstruments),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Report dependency upsert returned no rows');
  return mapDep(row);
}

export async function listReportDependencies(pool: Pool): Promise<ReportDependency[]> {
  const result = await query<RawDepRow>(pool, 'SELECT * FROM report_dependency ORDER BY output_id');
  return result.rows.map(mapDep);
}

export async function getReportDependency(
  pool: Pool,
  outputId: string,
): Promise<ReportDependency | null> {
  const result = await query<RawDepRow>(
    pool,
    'SELECT * FROM report_dependency WHERE output_id = $1',
    [outputId],
  );
  const row = result.rows[0];
  return row ? mapDep(row) : null;
}
