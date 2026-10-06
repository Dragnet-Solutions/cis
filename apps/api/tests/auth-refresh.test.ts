/**
 * POST /auth/refresh — the sliding-session renewal behind QA F9 (a session
 * expiring mid-work). A valid operator token is swapped for a fresh one; a
 * request without a token is refused.
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
const EMAIL = 'adaeze.okoro@cis.example';

let app: FastifyInstance;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  await seedReferenceData(getPool());
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

describe('POST /auth/refresh', () => {
  it('swaps a valid operator token for a fresh, working one', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json<{ token: string }>().token;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const fresh = res.json<{ token: string }>().token;

    const decoded = app.jwt.decode<{ email: string; kind: string }>(fresh);
    expect(decoded?.email).toBe(EMAIL);
    expect(decoded?.kind).toBe('operator');

    const editions = await app.inject({
      method: 'GET',
      url: '/editions',
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(editions.statusCode).toBe(200);
  });

  it('refuses a request with no token', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/refresh' });
    expect(res.statusCode).toBe(401);
  });
});
