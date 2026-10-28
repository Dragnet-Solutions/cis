/**
 * Developer fix list, 27 Oct 2026 — governance and hardening, over real HTTP.
 *
 *  - BUG-01: the "Market institutions" right (access:regs) is enforced on
 *    every market-institution endpoint, read and write, as the Dragnet right
 *    is: without it, 403.
 *  - BUG-07: an edition that does not exist is a 404 on edition-scoped
 *    routes, not 200 with empty data — and still 401 when not signed in.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getPool } from '@cis/db';
import { seedReferenceData } from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';
/** Seeded with access:regs. */
const MAKER = 'adaeze.okoro@cis.example';
/** Seeded without access:regs. */
const CHECKER = 'segun.oyegbesan@dragnet.example';

let app: FastifyInstance;
let editionId: string;
let savedAuthMax: string | undefined;

beforeAll(async () => {
  savedAuthMax = process.env['RATE_LIMIT_AUTH_MAX'];
  process.env['RATE_LIMIT_AUTH_MAX'] = '1000';
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  editionId = (await seedReferenceData(getPool())).editionId;
});

afterAll(async () => {
  if (savedAuthMax === undefined) delete process.env['RATE_LIMIT_AUTH_MAX'];
  else process.env['RATE_LIMIT_AUTH_MAX'] = savedAuthMax;
  await app.close();
  await closeTestPool();
});

async function signIn(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ token: string; user: Record<string, unknown> }>();
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('BUG-01: the Market institutions right is enforced', () => {
  it('without access:regs every market-institution read and write is refused', async () => {
    const { token, user } = await signIn(CHECKER);
    expect(user['hasRegulatorsRight']).toBe(false);
    const holder = await signIn(MAKER);
    expect(holder.user['hasRegulatorsRight']).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/regulators`,
      headers: auth(holder.token),
    });
    expect(list.statusCode).toBe(200);
    const [role] = list.json<{
      regulators: Array<{ institutionId: string; familyCode: string }>;
    }>().regulators;
    expect(role).toBeDefined();
    const one = `/editions/${editionId}/regulators/${role!.institutionId}/${role!.familyCode}`;

    const calls: Array<{ method: 'GET' | 'PUT' | 'POST'; url: string; payload?: object }> = [
      { method: 'GET', url: `/editions/${editionId}/regulators` },
      { method: 'GET', url: one },
      { method: 'GET', url: '/institutions' },
      {
        method: 'PUT',
        url: `${one}/contact`,
        payload: {
          who: 'Someone',
          role: 'Head',
          email: 'someone@sec.example',
          phone: '',
          how: 'email',
        },
      },
      { method: 'POST', url: `${one}/issue-link`, payload: { targetBy: '2099-01-01' } },
      { method: 'POST', url: `${one}/reminder` },
      { method: 'POST', url: `${one}/text-reminder` },
      { method: 'POST', url: `${one}/decline` },
      { method: 'POST', url: `${one}/reopen` },
      { method: 'POST', url: `${one}/submitted` },
      { method: 'POST', url: `${one}/history`, payload: { entry: 'A note' } },
    ];
    for (const c of calls) {
      const res = await app.inject({ ...c, headers: auth(token) });
      expect(res.statusCode, `${c.method} ${c.url}: ${res.body}`).toBe(403);
    }
    // The holder still reads the roster.
    const roster = await app.inject({
      method: 'GET',
      url: '/institutions',
      headers: auth(holder.token),
    });
    expect(roster.statusCode).toBe(200);
  });
});

describe('BUG-07: an unknown edition is a 404', () => {
  const NOPE = '00000000-0000-4000-8000-000000000000';

  it('edition-scoped routes answer 404 for an edition that does not exist', async () => {
    const { token } = await signIn(MAKER);
    for (const url of [
      `/editions/${NOPE}`,
      `/editions/${NOPE}/regulators`,
      `/editions/${NOPE}/firm-invitations`,
      `/editions/${NOPE}/mission-board`,
      `/editions/${NOPE}/dragnet/maturity`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth(token) });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
      expect(res.json<{ message: string }>().message).toMatch(
        /edition not found|edition was not found/i,
      );
    }
    // The public, unauthenticated surfaces too.
    const pub = await app.inject({
      method: 'GET',
      url: `/journeys/editions/${NOPE}/participating-firms`,
    });
    expect(pub.statusCode).toBe(404);
    // A real edition still answers.
    const real = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/regulators`,
      headers: auth(token),
    });
    expect(real.statusCode).toBe(200);
  });

  it('not signed in is still 401, whether or not the edition exists', async () => {
    for (const id of [NOPE, editionId]) {
      const res = await app.inject({ method: 'GET', url: `/editions/${id}/regulators` });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('BUG-05: "engaged" is counted in market institutions', () => {
  it('the national-report form gets both counts without the Market institutions right', async () => {
    const { token } = await signIn(CHECKER);
    const res = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/sufficiency`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const { marketInstitutions } = res.json<{
      marketInstitutions: { engaged: number; total: number };
    }>();
    // Every market institution taking part, each once (six today, D-22).
    expect(marketInstitutions.total).toBe(6);
    expect(marketInstitutions.engaged).toBe(0);
  });

  it('refuses more institutions engaged than take part', async () => {
    const { token } = await signIn(MAKER);
    const res = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/national-report`,
      headers: auth(token),
      payload: {
        scoringRunId: '00000000-0000-4000-8000-000000000001',
        context: { segments: {}, regulatorsEngaged: 7 },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/more than the 6 taking part/);
  });
});
