/**
 * Design Reconciliation Audit, Batch 1 — ADM-005 live-wiring fix. Before this,
 * `apps/admin`'s NationalReportPage had no way to discover the current report
 * for an edition on a fresh page load (the only lookup was by report id, and
 * the frontend has no durable place to remember one across sessions). This
 * closes that gap: `getLatestNationalReportForEdition` (packages/db) backs a
 * new `GET /editions/:id/national-report` route, tested here over real HTTP.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getPool } from '@cis/db';
import {
  seedReferenceData,
  generateNationalReport,
  requestSignoff,
  approveSignoff,
} from '@cis/domain';
import { createCalculationRun } from '@cis/db';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';

let app: FastifyInstance;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

describe('GET /editions/:id/national-report', () => {
  it('returns null before any report has been generated, and the real report after', async () => {
    const seed = await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    const auth = { authorization: `Bearer ${token}` };

    const before = await app.inject({
      method: 'GET',
      url: `/editions/${seed.editionId}/national-report`,
      headers: auth,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json<{ report: unknown }>().report).toBeNull();

    const run = await createCalculationRun(getPool(), {
      editionId: seed.editionId,
      runType: 'scoring',
      datasetHash: 'ds-http-test',
      status: 'complete',
    });
    const signoff = await requestSignoff(getPool(), {
      editionId: seed.editionId,
      calculationRunId: run.id,
      requestedBy: 'maker',
      checkedAccount: {
        populationCountsReviewed: true,
        floorStatusReviewed: true,
        dataQualityFlagsReviewed: true,
      },
    });
    await approveSignoff(getPool(), { signoffId: signoff.id, approvedBy: 'checker' });
    const { report } = await generateNationalReport(getPool(), {
      editionId: seed.editionId,
      scoringRunId: run.id,
      context: { segments: {}, regulatorsEngaged: 0 },
    });

    const after = await app.inject({
      method: 'GET',
      url: `/editions/${seed.editionId}/national-report`,
      headers: auth,
    });
    expect(after.statusCode).toBe(200);
    expect(after.json<{ report: { id: string } | null }>().report?.id).toBe(report.id);
  });
});
