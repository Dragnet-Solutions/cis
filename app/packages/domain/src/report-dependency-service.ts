import { Pool } from 'pg';
import { listReportDependencies, upsertReportDependency } from '@cis/db';
import type { ReportDependency } from '@cis/shared-types';
import { currentSegmentSufficiency } from './eligibility-service';

/**
 * Report-dependency configuration and evaluation. A report section's viability is
 * known DURING collection (with time to fix it), not discovered missing at
 * publication. The configuration table is study-team editable without a deploy;
 * this evaluates each output's rule against live segment sufficiency.
 *
 * Supported `sufficiency_rule` values (a small, explicit vocabulary rather than
 * an open expression evaluator):
 *   'all_sufficient' — every depended-on segment meets its floor
 *   'any_sufficient' — at least one depended-on segment meets its floor
 */
export type SufficiencyRule = 'all_sufficient' | 'any_sufficient';

export async function setReportDependency(
  pool: Pool,
  data: {
    outputId: string;
    dependsOn: string[];
    sufficiencyRule: SufficiencyRule;
    enabled?: boolean;
  },
): Promise<ReportDependency> {
  return upsertReportDependency(pool, data);
}

export interface DependencyEvaluation {
  outputId: string;
  enabled: boolean;
  rule: string;
  dependsOn: string[];
  segmentStates: Record<string, { counted: number; floor: number; meets: boolean }>;
  viable: boolean;
}

/**
 * Evaluate every configured report dependency against the current per-segment
 * sufficiency state for an edition.
 */
export async function evaluateReportDependencies(
  pool: Pool,
  editionId: string,
): Promise<DependencyEvaluation[]> {
  const deps = await listReportDependencies(pool);
  const sufficiency = await currentSegmentSufficiency(pool, editionId);

  return deps.map((dep) => {
    const segmentStates: Record<string, { counted: number; floor: number; meets: boolean }> = {};
    for (const seg of dep.dependsOn) {
      segmentStates[seg] = sufficiency[seg] ?? { counted: 0, floor: 0, meets: false };
    }
    const meets = dep.dependsOn.map((s) => segmentStates[s]?.meets ?? false);
    let viable: boolean;
    if (dep.sufficiencyRule === 'any_sufficient') {
      viable = meets.some(Boolean);
    } else {
      // Default and 'all_sufficient': every depended-on segment must meet floor.
      viable = meets.length > 0 && meets.every(Boolean);
    }
    if (!dep.enabled) viable = false;
    return {
      outputId: dep.outputId,
      enabled: dep.enabled,
      rule: dep.sufficiencyRule,
      dependsOn: dep.dependsOn,
      segmentStates,
      viable,
    };
  });
}
