/**
 * E02 (QA evidence pack, 25 Oct): resending many invitations at once — the
 * "send again" control fired for every pending firm in parallel — must not
 * fail with a bare 500. Different invitations all go through; the same
 * invitation sent again concurrently is safe (each send is queued once).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getPool, createOrganization, listEmailsFor } from '@cis/db';
import { seedReferenceData } from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';
const FIRMS = 81;

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

async function setUp(): Promise<{ token: string; ids: string[] }> {
  const seed = await seedReferenceData(getPool());
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'adaeze.okoro@cis.example', password: PASSWORD },
  });
  const token = login.json<{ token: string }>().token;
  const ids: string[] = [];
  for (let i = 0; i < FIRMS; i++) {
    const org = await createOrganization(getPool(), {
      slug: `resend-firm-${i}`,
      displayName: `Resend Firm ${i}`,
      orgType: 'firm',
    });
    const sent = await app.inject({
      method: 'POST',
      url: `/firms/${org.id}/invitations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { email: `md${i}@resendfirm.com`, editionId: seed.editionId },
    });
    expect(sent.statusCode).toBe(201);
    ids.push(sent.json<{ invitation: { id: string } }>().invitation.id);
  }
  return { token, ids };
}

const resend = (token: string, id: string) =>
  app.inject({
    method: 'POST',
    url: `/firm-invitations/${id}/resend`,
    headers: { authorization: `Bearer ${token}` },
  });

describe('resending invitations concurrently (E02)', () => {
  it(`${FIRMS} different invitations resent at once all succeed`, async () => {
    const { token, ids } = await setUp();
    const results = await Promise.all(ids.map((id) => resend(token, id)));
    const failed = results.filter((r) => r.statusCode !== 200);
    expect(failed.map((r) => `${r.statusCode} ${r.body}`)).toEqual([]);
    const emails = await listEmailsFor(getPool(), 'firm-invitation', ids);
    expect(emails).toHaveLength(FIRMS * 2);
  }, 120_000);

  it('the same invitation resent many times at once is safe', async () => {
    const { token, ids } = await setUp();
    const id = ids[0]!;
    const results = await Promise.all(Array.from({ length: 20 }, () => resend(token, id)));
    const failed = results.filter((r) => r.statusCode !== 200);
    expect(failed.map((r) => `${r.statusCode} ${r.body}`)).toEqual([]);
    const emails = await listEmailsFor(getPool(), 'firm-invitation', [id]);
    expect(emails).toHaveLength(21);
  }, 120_000);
});
