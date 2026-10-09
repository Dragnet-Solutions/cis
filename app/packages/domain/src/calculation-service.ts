import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import {
  getActiveMetricDefinitions,
  createCalculationRun,
  insertCalculatedResult,
  countRespondentsRatingFirm,
  getNumericAnswersForFirm,
  getEditionResponseIds,
  withTransaction,
} from '@cis/db';
import type { CalculationRun, CalculatedResult, MetricDefinition } from '@cis/shared-types';
import { eligibleFirmIds } from './eligibility-service';
import { computeSufficiency } from './sufficiency-service';

/**
 * The scoring pass. It runs whatever methodology `metric_definitions` describes;
 * it never hardcodes a weighting. The seeded configuration is a PROVISIONAL
 * equal-weight placeholder — the value it computes is a mean over the configured
 * question IDs, and with the placeholder's empty question set the value is simply
 * null until Dragnet's validated methodology (a new metric_definitions version)
 * supplies the mapping. Runs are immutable; a correction is a new run. Two
 * methodology versions can run against the same frozen dataset and BOTH result
 * sets are retained (AT-02).
 */

/** A deterministic fingerprint of the frozen response set for an edition. */
export async function datasetHashFor(pool: Pool, editionId: string): Promise<string> {
  const ids = await getEditionResponseIds(pool, editionId);
  return createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 32);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface ScoringRunResult {
  run: CalculationRun;
  results: CalculatedResult[];
}

/**
 * Score every eligible firm against each metric definition. Eligibility is read
 * (already computed in its own step), never recomputed inside the scoring pass.
 */
export async function runScoring(
  pool: Pool,
  input: {
    editionId: string;
    methodologyVersion?: string;
    metricDefinitions?: MetricDefinition[];
    datasetHash?: string;
  },
): Promise<ScoringRunResult> {
  const metrics = input.metricDefinitions ?? (await getActiveMetricDefinitions(pool));
  const firms = await eligibleFirmIds(pool, input.editionId);
  const datasetHash = input.datasetHash ?? (await datasetHashFor(pool, input.editionId));
  const methodologyVersion =
    input.methodologyVersion ??
    `v:${metrics
      .map((m) => `${m.metricCode}@${m.version}`)
      .sort()
      .join(',')}`;

  // Pre-compute the scoring inputs OUTSIDE the write transaction.
  const rows: Array<{
    subjectId: string;
    metricCode: string;
    value: number | null;
    n: number;
  }> = [];
  for (const firmId of firms) {
    const n = await countRespondentsRatingFirm(pool, input.editionId, firmId);
    for (const metric of metrics) {
      const values = await getNumericAnswersForFirm(
        pool,
        input.editionId,
        firmId,
        metric.config.questionIds ?? [],
      );
      rows.push({ subjectId: firmId, metricCode: metric.metricCode, value: mean(values), n });
    }
  }

  return withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const run = await createCalculationRun(c, {
      editionId: input.editionId,
      runType: 'scoring',
      methodologyVersion,
      datasetHash,
    });
    const results: CalculatedResult[] = [];
    for (const r of rows) {
      const sufficiency = computeSufficiency(r.n);
      // A suppressed result never carries its underlying value.
      const value = sufficiency === 'SUPPRESSED' ? null : r.value;
      results.push(
        await insertCalculatedResult(c, {
          calculationRunId: run.id,
          subjectType: 'firm',
          subjectId: r.subjectId,
          metricCode: r.metricCode,
          value,
          n: r.n,
          denominator: r.n,
          sufficiencyState: sufficiency,
          ...(sufficiency === 'SUPPRESSED' ? { reason: `n=${r.n} below reporting floor` } : {}),
        }),
      );
    }
    return { run, results };
  });
}
