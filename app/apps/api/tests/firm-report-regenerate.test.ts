/**
 * Firm-report regeneration (Part 2b) — HTTP-layer tests for the new
 * POST /firm-reports/:id/regenerate route. Domain-level coverage (retry
 * recorded in release history, released-report immutability) already lives
 * in packages/domain/tests/firm-report.test.ts; this checks the route itself.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  getPool,
  createOrganization,
  ensureSeats,
  setSeatState,
  createCalculationRun,
  createNationalReport,
  approveNationalReport,
} from '@cis/db';
import {
  seedReferenceData,
  requestSignoff,
  approveSignoff,
  generateFirmReports,
  approveFirmReport,
  releaseFirmReports,
} from '@cis/domain';
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

async function setUp(): Promise<{ editionId: string; scoringRunId: string; firmId: string }> {
  const pool = getPool();
  const seed = await seedReferenceData(pool);
  const org = await createOrganization(pool, {
    slug: 'http-retry-firm',
    displayName: 'HTTP Retry Firm',
    orgType: 'firm',
  });
  await ensureSeats(pool, seed.editionId, org.id);
  await setSeatState(pool, {
    editionId: seed.editionId,
    organizationId: org.id,
    seatCode: 'S1',
    state: 'complete',
  });
  const run = await createCalculationRun(pool, {
    editionId: seed.editionId,
    runType: 'scoring',
    datasetHash: 'ds-regen-http',
    status: 'complete',
  });
  const signoff = await requestSignoff(pool, {
    editionId: seed.editionId,
    calculationRunId: run.id,
    requestedBy: 'maker',
    checkedAccount: {
      populationCountsReviewed: true,
      floorStatusReviewed: true,
      dataQualityFlagsReviewed: true,
    },
  });
  await approveSignoff(pool, { signoffId: signoff.id, approvedBy: 'checker' });
  return { editionId: seed.editionId, scoringRunId: run.id, firmId: org.id };
}

describe('POST /firm-reports/:id/regenerate', () => {
  it('retries a failed report back to generated, over real HTTP', async () => {
    const { editionId, scoringRunId, firmId } = await setUp();
    const gen = await generateFirmReports(getPool(), {
      editionId,
      scoringRunId,
      failFor: [firmId],
    });
    const report = gen.reports.find((r) => r.organizationId === firmId)!;
    expect(report.generationState).toBe('failed');

    const token = await login('adaeze.okoro@cis.example');
    const res = await app.inject({
      method: 'POST',
      url: `/firm-reports/${report.id}/regenerate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ report: { generationState: string } }>().report.generationState).toBe(
      'generated',
    );
  });

  it('refuses to regenerate an already-released report over HTTP', async () => {
    const { editionId, scoringRunId, firmId } = await setUp();
    const gen = await generateFirmReports(getPool(), { editionId, scoringRunId });
    const report = gen.reports.find((r) => r.organizationId === firmId)!;
    await approveFirmReport(getPool(), report.id);
    const nr = await createNationalReport(getPool(), { editionId, scoringRunId });
    await approveNationalReport(getPool(), nr.id, 'checker');
    await releaseFirmReports(getPool(), editionId);

    const token = await login('adaeze.okoro@cis.example');
    const res = await app.inject({
      method: 'POST',
      url: `/firm-reports/${report.id}/regenerate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/immutable/);
  });
});
