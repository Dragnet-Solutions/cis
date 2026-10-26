/**
 * E02 root cause, reproduced: when every database connection is busy, a
 * request waits for one. If the wait runs out, the caller used to get a bare
 * "Internal server error" (the 9–21% of failures seen when 81 invitations
 * were resent at once against the remote database). A one-connection pool with a 5 ms
 * wait forces the same exhaustion locally: the answer must be a clear 503 with
 * Retry-After — never a 500 — and nothing half-written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

let app: FastifyInstance;
let token: string;
const ids: string[] = [];

beforeAll(async () => {
  await runMigrations();
  // Fewer connections than concurrent requests, and almost no patience.
  initializePool({ max: 1, connectionTimeoutMillis: 5 });
  // Open the one connection first (connecting can itself take over 5 ms); it
  // then stays open, so setup below runs one query at a time without waiting.
  for (let tries = 0; ; tries++) {
    try {
      await getPool().query('SELECT 1');
      break;
    } catch (err) {
      if (tries > 50) throw err;
    }
  }
  app = await buildServer();
  await app.ready();
  await truncateAllTables(getTestPool());
  const seed = await seedReferenceData(getTestPool());
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'adaeze.okoro@cis.example', password: 'ChangeMe!2026' },
  });
  expect(login.statusCode, login.body).toBe(200);
  token = login.json<{ token: string }>().token;
  for (let i = 0; i < 30; i++) {
    const org = await createOrganization(getTestPool(), {
      slug: `busy-firm-${i}`,
      displayName: `Busy Firm ${i}`,
      orgType: 'firm',
    });
    const sent = await app.inject({
      method: 'POST',
      url: `/firms/${org.id}/invitations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { email: `md${i}@busyfirm.com`, editionId: seed.editionId },
    });
    expect(sent.statusCode).toBe(201);
    ids.push(sent.json<{ invitation: { id: string } }>().invitation.id);
  }
}, 120_000);

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

describe('database pool exhausted (E02)', () => {
  it('a request that cannot get a connection gets a clear 503, never a bare 500', async () => {
    const results = await Promise.all(
      ids.map((id) =>
        app.inject({
          method: 'POST',
          url: `/firm-invitations/${id}/resend`,
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes).not.toContain(500);
    const busy = results.filter((r) => r.statusCode === 503);
    // The exhaustion really happened (or the test proves nothing).
    expect(busy.length).toBeGreaterThan(0);
    for (const r of busy) {
      expect(r.json<{ message: string }>().message).toMatch(/busy.*try again/i);
      expect(r.headers['retry-after']).toBeDefined();
    }
    // Each resend either fully happened (email queued) or did not happen at all.
    const ok = results.filter((r) => r.statusCode === 200).length;
    const emails = await listEmailsFor(getTestPool(), 'firm-invitation', ids);
    expect(emails).toHaveLength(ids.length + ok);
  }, 120_000);
});
