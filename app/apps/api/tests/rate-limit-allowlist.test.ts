/**
 * RATE_LIMIT_ALLOWLIST (dev/test only): a listed address skips every rate
 * limit — the global one and the per-route login limit — so the respondent
 * robot can play many respondents and coordinators from one machine. Any
 * other address is still limited exactly as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool } from '@cis/db';
import { buildServer } from '../src/server';
import { rateLimitAllowList } from '../src/plugins/security';
import { runMigrations, closeTestPool } from '../../../packages/db/tests/setup';

const AUTH_MAX = 2;
const ROBOT_IP = '203.0.113.7';

describe('rate-limit allow list', () => {
  let app: FastifyInstance;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ['RATE_LIMIT_ALLOWLIST', 'RATE_LIMIT_AUTH_MAX', 'REDIS_URL', 'REDIS_HOST']) {
      saved[key] = process.env[key];
    }
    delete process.env['REDIS_URL'];
    delete process.env['REDIS_HOST'];
    process.env['RATE_LIMIT_ALLOWLIST'] = ` ${ROBOT_IP} , `;
    process.env['RATE_LIMIT_AUTH_MAX'] = String(AUTH_MAX);
    await runMigrations();
    initializePool();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closeTestPool();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const login = (ip: string) =>
    app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: ip,
      payload: { email: 'nobody@cis.example', password: 'wrong-password' },
    });

  it('parses a comma-separated list, ignoring blanks', () => {
    expect(rateLimitAllowList(' 10.0.0.1, ,10.0.0.2 ')).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(rateLimitAllowList(undefined)).toEqual([]);
  });

  it('exempts a listed address from the login limit', async () => {
    for (let i = 0; i < AUTH_MAX + 3; i++) {
      expect((await login(ROBOT_IP)).statusCode).not.toBe(429);
    }
  });

  it('still limits every other address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_MAX + 1; i++) statuses.push((await login('198.51.100.20')).statusCode);
    expect(statuses.at(-1)).toBe(429);
  });
});
