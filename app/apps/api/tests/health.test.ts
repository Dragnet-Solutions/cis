/**
 * GET /health and GET /ready — the container probes — and TRUST_PROXY
 * parsing, which decides whether request.ip (and every per-IP rate limit)
 * comes from X-Forwarded-For behind the ingress + nginx proxy chain.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool } from '@cis/db';
import { buildServer } from '../src/server';
import { parseTrustProxy } from '../src/plugins/trust-proxy';
import { runMigrations, closeTestPool } from '../../../packages/db/tests/setup';

let app: FastifyInstance;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

describe('GET /health', () => {
  it('answers 200 without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('is exempt from the global rate limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});

describe('GET /ready', () => {
  it('answers 200 when the database is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('parseTrustProxy', () => {
  it('defaults to not trusting any proxy', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('accepts true, a hop count, or an address list', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual(['10.0.0.0/8', '127.0.0.1']);
  });
});

describe('trustProxy with two hops (ingress-nginx → cis-admin nginx → API)', () => {
  it('resolves request.ip to the real client, not a proxy', async () => {
    const previous = process.env['TRUST_PROXY'];
    process.env['TRUST_PROXY'] = '2';
    const proxied = await buildServer();
    try {
      proxied.get('/__test/ip', async (request) => ({ ip: request.ip }));
      await proxied.ready();
      // A spoofed leading entry, then the client as seen by ingress, then the
      // ingress pod as seen by cis-admin's nginx; the socket is cis-admin.
      const res = await proxied.inject({
        method: 'GET',
        url: '/__test/ip',
        remoteAddress: '10.244.0.20',
        headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 10.244.0.10' },
      });
      expect(res.json()).toEqual({ ip: '203.0.113.7' });
    } finally {
      await proxied.close();
      if (previous === undefined) delete process.env['TRUST_PROXY'];
      else process.env['TRUST_PROXY'] = previous;
    }
  });
});
