/**
 * Releasing the firm reports over HTTP — the maker-checker routes, and the
 * firm directory import route. Identities come from the signed-in session,
 * never the body; the old one-click approve route is gone.
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
  getFirmReport,
  createUser,
  listOrganizations,
} from '@cis/db';
import { hashPassword } from '@cis/auth';
import {
  seedReferenceData,
  requestSignoff,
  approveSignoff,
  generateFirmReports,
} from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

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

async function setUp() {
  const pool = getPool();
  const seed = await seedReferenceData(pool);
  const org = await createOrganization(pool, {
    slug: 'http-release-firm',
    displayName: 'HTTP Release Firm',
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
    datasetHash: 'ds-release-http',
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
  const gen = await generateFirmReports(pool, { editionId: seed.editionId, scoringRunId: run.id });
  const nr = await createNationalReport(pool, { editionId: seed.editionId, scoringRunId: run.id });
  await approveNationalReport(pool, nr.id, 'checker');
  return { editionId: seed.editionId, reportId: gen.reports[0]!.id };
}

describe('Firm report release — maker-checker over HTTP', () => {
  it('the one-click approve route no longer exists', async () => {
    const { reportId } = await setUp();
    const res = await post(`/firm-reports/${reportId}/approve`, await login(MAKER));
    expect(res.statusCode).toBe(404);
    expect((await getFirmReport(getPool(), reportId))?.approvalState).toBe('pending');
  });

  it('request → maker refused → checker refused until opened → checker approves and releases', async () => {
    const { editionId, reportId } = await setUp();
    const makerToken = await login(MAKER);
    const checkerToken = await login(CHECKER);

    // A request needs a reason.
    const noReason = await post(`/editions/${editionId}/firm-reports/release/request`, makerToken, {
      reason: '',
    });
    expect(noReason.statusCode).toBe(400);

    const req = await post(`/editions/${editionId}/firm-reports/release/request`, makerToken, {
      reason: 'All reports read against the signed run',
    });
    expect(req.statusCode).toBe(201);
    const { criticalActionId } = req.json<{ criticalActionId: string }>();

    // The list shows the pending request, with who asked (from the session).
    const list = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/firm-reports`,
      headers: { authorization: `Bearer ${makerToken}` },
    });
    const pending = list.json<{
      pendingRelease: { id: string; requestedBy: { displayName: string }; reportIds: string[] };
    }>().pendingRelease;
    expect(pending.id).toBe(criticalActionId);
    expect(pending.requestedBy.displayName).toBe('Adaeze Okoro');
    expect(pending.reportIds).toEqual([reportId]);

    const decideUrl = `/editions/${editionId}/firm-reports/release/${criticalActionId}/decide`;
    // The maker cannot approve their own request.
    const own = await post(decideUrl, makerToken, { approved: true });
    expect(own.statusCode).toBe(403);

    // Nobody has opened the report yet.
    const unopened = await post(decideUrl, checkerToken, { approved: true });
    expect(unopened.statusCode).toBe(409);
    expect(unopened.json<{ message: string }>().message).toMatch(/not been opened/);

    // The checker opens it, then approves; approving releases.
    expect((await post(`/firm-reports/${reportId}/open`, checkerToken)).statusCode).toBe(200);
    const approved = await post(decideUrl, checkerToken, { approved: true });
    expect(approved.statusCode).toBe(200);
    const body = approved.json<{
      status: string;
      released: string[];
      held: Array<{ reason: string }>;
    }>();
    expect(body.status).toBe('approved');
    const report = await getFirmReport(getPool(), reportId);
    expect(report?.approvalState).toBe('approved');
    // Approving runs the release. Without an AI model configured here the
    // written analysis cannot be drafted, so the report is held (not lost)
    // until "Release again" — the release path's existing rule.
    if (report?.releaseState === 'released') {
      expect(body.released).toHaveLength(1);
    } else {
      expect(report?.releaseState).toBe('held');
      expect(body.held[0]?.reason).toMatch(/written analysis/);
    }
  });
});

describe('Firm directory import over HTTP', () => {
  it('previews, imports, and refuses someone without the setup right', async () => {
    await setUp();
    const token = await login(MAKER);
    const csv = 'name\nImported Alpha\nImported Beta\nHTTP Release Firm\n';

    const preview = await post('/firms/import', token, { csv, dryRun: true });
    expect(preview.statusCode).toBe(200);
    const plan = preview.json<{ toAdd: unknown[]; duplicates: unknown[]; added: number }>();
    expect(plan.toAdd).toHaveLength(2);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.added).toBe(0);

    const done = await post('/firms/import', token, { csv, dryRun: false });
    expect(done.statusCode).toBe(201);
    expect(done.json<{ added: number }>().added).toBe(2);
    const firms = (await listOrganizations(getPool())).filter((o) => o.orgType === 'firm');
    expect(firms.map((f) => f.displayName).sort()).toEqual([
      'HTTP Release Firm',
      'Imported Alpha',
      'Imported Beta',
    ]);

    // Someone who can sign in but does not hold "Change the setup".
    await createUser(getPool(), {
      email: 'viewer@cis.example',
      passwordHash: await hashPassword(PASSWORD),
      displayName: 'View Only',
      organization: 'CIS',
    });
    const viewer = await login('viewer@cis.example');
    const refused = await post('/firms/import', viewer, { csv: 'name\nSneaky\n', dryRun: false });
    expect(refused.statusCode).toBe(403);
    const after = (await listOrganizations(getPool())).filter((o) => o.orgType === 'firm');
    expect(after).toHaveLength(3);
  });
});
