/**
 * Developer fix list, 27 Oct 2026 — governance and hardening, over real HTTP.
 *
 *  - BUG-01: the "Market institutions" right (access:regs) is enforced on
 *    every market-institution endpoint, read and write, as the Dragnet right
 *    is: without it, 403.
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
