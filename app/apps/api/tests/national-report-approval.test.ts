/**
 * Approving the national report over HTTP (go-live blocker): there is no
 * approval without a pending request from a different person. The approve
 * route refuses with 409 when nothing has been requested, 403 when the
 * requester tries to approve their own request, and 409 until the approver
 * has opened the draft themselves. Identities come from the session.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  getPool,
  createCalculationRun,
  getNationalReport,
  listFindingsForReport,
} from '@cis/db';
import {
  seedReferenceData,
  generateNationalReport,
  saveNationalDraft,
  runChecker,
  runAdversaryHealth,
  disposeFinding,
  requestSignoff,
  approveSignoff,
} from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';
import { approveMethodologyForTests } from '../../../packages/db/tests/methodology-approval';

const PASSWORD = 'ChangeMe!2026';
const MAKER = 'adaeze.okoro@cis.example';
const CHECKER = 'segun.oyegbesan@dragnet.example';

let app: FastifyInstance;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  await approveMethodologyForTests(getTestPool());
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

const post = (url: string, token: string, payload?: object) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

/** A national report with every approval precondition met except opening. */
async function readyReport(): Promise<string> {
  const pool = getPool();
  const seed = await seedReferenceData(pool);
  const run = await createCalculationRun(pool, {
    editionId: seed.editionId,
    runType: 'scoring',
    datasetHash: 'ds-national-approval',
    status: 'complete',
  });
  const so = await requestSignoff(pool, {
    editionId: seed.editionId,
    calculationRunId: run.id,
    requestedBy: 'maker',
    checkedAccount: {
      populationCountsReviewed: true,
      floorStatusReviewed: true,
      dataQualityFlagsReviewed: true,
    },
  });
  await approveSignoff(pool, { signoffId: so.id, approvedBy: 'checker' });
  const { report } = await generateNationalReport(pool, {
    editionId: seed.editionId,
    scoringRunId: run.id,
    context: {
      segments: {
        retail: { meets: true, thin: false },
        local_institution: { meets: true, thin: false },
        foreign_institution: { meets: true, thin: false },
      },
      regulatorsEngaged: 3,
    },
  });
  await saveNationalDraft(pool, report.id, [
    { ordinal: 1, text: 'The weakest performers are the smaller firms.', factIds: [] },
  ]);
  await runChecker(pool, report.id, []);
  await runAdversaryHealth(pool, report.id, [
    { sentence: { ordinal: 1, text: 'No basis.', factIds: [] }, facts: [] },
  ]);
  const findings = await listFindingsForReport(pool, report.id);
  await disposeFinding(pool, {
    findingId: findings[0]!.id,
    disposition: 'SUPPRESS_CLAIM',
    disposedBy: 'reviewer',
  });
  return report.id;
}

describe('POST /national-reports/:id/approve — maker-checker only', () => {
  it('refuses with 409 when no approval has been requested', async () => {
    const reportId = await readyReport();
    const checker = await login(CHECKER);
    expect((await post(`/national-reports/${reportId}/open`, checker)).statusCode).toBe(200);

    const res = await post(`/national-reports/${reportId}/approve`, checker, {});
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/no pending request/i);
    expect((await getNationalReport(getPool(), reportId))?.status).not.toBe('approved');
  });

  it('request → maker refused (403) → checker refused until opened (409) → checker approves', async () => {
    const reportId = await readyReport();
    const maker = await login(MAKER);
    const checker = await login(CHECKER);

    expect((await post(`/national-reports/${reportId}/open`, maker)).statusCode).toBe(200);
    const req = await post(`/national-reports/${reportId}/request-approval`, maker, {
      reason: 'Read all ten sections and decided the finding.',
    });
    expect(req.statusCode).toBe(200);
    expect(req.json<{ criticalActionId: string }>().criticalActionId).toBeTruthy();

    const detail = await app.inject({
      method: 'GET',
      url: `/national-reports/${reportId}`,
      headers: { authorization: `Bearer ${checker}` },
    });
    const body = detail.json<{ pendingApproval: { id: string } | null; openedByYou: boolean }>();
    expect(body.pendingApproval?.id).toBe(
      req.json<{ criticalActionId: string }>().criticalActionId,
    );
    expect(body.openedByYou).toBe(false);

    const own = await post(`/national-reports/${reportId}/approve`, maker, {});
    expect(own.statusCode).toBe(403);

    const unopened = await post(`/national-reports/${reportId}/approve`, checker, {});
    expect(unopened.statusCode).toBe(409);
    expect(unopened.json<{ message: string }>().message).toMatch(/open the draft/i);

    expect((await post(`/national-reports/${reportId}/open`, checker)).statusCode).toBe(200);
    const approved = await post(`/national-reports/${reportId}/approve`, checker, {});
    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ status: string }>().status).toBe('approved');
    const report = await getNationalReport(getPool(), reportId);
    expect(report?.approvedBy).toBe(CHECKER);
    expect(report?.requestedBy).toBe(MAKER);
  });
});
