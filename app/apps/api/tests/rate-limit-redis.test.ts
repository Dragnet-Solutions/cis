/**
 * Rate limits shared through Redis: two separate API instances (standing in
 * for two replicas) must count against ONE login limit, not one each.
 *
 * Needs a real Redis, so it only runs when TEST_REDIS_URL is set (CI provides
 * one; locally: `docker compose up -d redis` and
 * TEST_REDIS_URL=redis://localhost:6379). Other test files never see Redis.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { initializePool } from '@cis/db';
import { buildServer } from '../src/server';
import { runMigrations, closeTestPool } from '../../../packages/db/tests/setup';

const TEST_REDIS_URL = process.env['TEST_REDIS_URL'];
const AUTH_MAX = 3;

describe.skipIf(!TEST_REDIS_URL)('rate limits shared through Redis', () => {
  let replicaA: FastifyInstance;
  let replicaB: FastifyInstance;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ['REDIS_URL', 'RATE_LIMIT_AUTH_MAX']) saved[key] = process.env[key];
    process.env['REDIS_URL'] = TEST_REDIS_URL;
    process.env['RATE_LIMIT_AUTH_MAX'] = String(AUTH_MAX);

    const redis = new Redis(TEST_REDIS_URL!);
    const keys = await redis.keys('cis-ratelimit-*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();

    await runMigrations();
    initializePool();
    replicaA = await buildServer();
    replicaB = await buildServer();
    await Promise.all([replicaA.ready(), replicaB.ready()]);
  });

  afterAll(async () => {
    await replicaA?.close();
    await replicaB?.close();
    await closeTestPool();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('counts login attempts across replicas against a single limit', async () => {
    const attempt = (app: FastifyInstance) =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        remoteAddress: '198.51.100.9',
        payload: { email: 'nobody@cis.example', password: 'wrong-password' },
      });

    // Alternate replicas: in-memory limits would allow AUTH_MAX per replica.
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_MAX; i++) {
      statuses.push((await attempt(i % 2 === 0 ? replicaA : replicaB)).statusCode);
    }
    expect(statuses).not.toContain(429);

    const overLimitA = await attempt(replicaA);
    const overLimitB = await attempt(replicaB);
    expect(overLimitA.statusCode).toBe(429);
    expect(overLimitB.statusCode).toBe(429);
  });
});
