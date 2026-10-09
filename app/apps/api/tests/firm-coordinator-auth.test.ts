/**
 * Coordinator sign-in and PIN rotation, over real HTTP — Task D Part 1.
 * The critical property under test isn't just "login works": it's that a
 * coordinator token and an operator token are structurally separate claim
 * spaces, so one can never be used where the other is required.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getPool, createOrganization } from '@cis/db';
import { createLeadCoordinator, setCoordinatorPin, seedReferenceData } from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const OPERATOR_PASSWORD = 'ChangeMe!2026';

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

async function operatorLogin(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: OPERATOR_PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

describe('POST /portal/auth/login', () => {
  it('signs a coordinator in with email + PIN and returns a usable token', async () => {
    const org = await createOrganization(getPool(), {
      slug: 'http-firm',
      displayName: 'HTTP Firm',
      orgType: 'firm',
    });
    const lead = await createLeadCoordinator(getPool(), {
      organizationId: org.id,
      name: 'Lead One',
      email: 'lead1@httpfirm.example',
    });
    await setCoordinatorPin(getPool(), lead.id, { newPin: '1234' });

    const res = await app.inject({
      method: 'POST',
      url: '/portal/auth/login',
      payload: { email: 'lead1@httpfirm.example', pin: '1234' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; coordinator: { id: string; isLead: boolean } }>();
    expect(body.coordinator.id).toBe(lead.id);
    expect(body.coordinator.isLead).toBe(true);

    // The token authenticates a coordinator-only route...
    const pinRes = await app.inject({
      method: 'POST',
      url: '/portal/auth/pin',
      headers: { authorization: `Bearer ${body.token}` },
      payload: { newPin: '5678', currentPin: '1234' },
    });
    expect(pinRes.statusCode).toBe(200);

    // ...but is refused on an operator-only route, even though it verifies fine.
    const operatorRes = await app.inject({
      method: 'GET',
      url: '/firms',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(operatorRes.statusCode).toBe(401);
  });

  it('refuses a wrong PIN with a generic 401', async () => {
    const org = await createOrganization(getPool(), {
      slug: 'http-firm-2',
      displayName: 'HTTP Firm Two',
      orgType: 'firm',
    });
    const lead = await createLeadCoordinator(getPool(), {
      organizationId: org.id,
      name: 'Lead One',
      email: 'lead1@httpfirm2.example',
    });
    await setCoordinatorPin(getPool(), lead.id, { newPin: '1234' });

    const res = await app.inject({
      method: 'POST',
      url: '/portal/auth/login',
      payload: { email: 'lead1@httpfirm2.example', pin: '0000' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('An operator token can never be used as coordinator access', () => {
  it('is refused on /portal/auth/pin, even though it verifies fine', async () => {
    const seed = await seedReferenceData(getPool());
    void seed;
    const operatorToken = await operatorLogin('adaeze.okoro@cis.example');

    const res = await app.inject({
      method: 'POST',
      url: '/portal/auth/pin',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { newPin: '1234' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('PIN rotation persists', () => {
  it('a changed PIN works on the next login and the old PIN no longer does', async () => {
    const org = await createOrganization(getPool(), {
      slug: 'http-firm-3',
      displayName: 'HTTP Firm Three',
      orgType: 'firm',
    });
    const lead = await createLeadCoordinator(getPool(), {
      organizationId: org.id,
      name: 'Lead One',
      email: 'lead1@httpfirm3.example',
    });
    await setCoordinatorPin(getPool(), lead.id, { newPin: '1234' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/portal/auth/login',
      payload: { email: 'lead1@httpfirm3.example', pin: '1234' },
    });
    const { token } = loginRes.json<{ token: string }>();

    const rotateRes = await app.inject({
      method: 'POST',
      url: '/portal/auth/pin',
      headers: { authorization: `Bearer ${token}` },
      payload: { newPin: '9999', currentPin: '1234' },
    });
    expect(rotateRes.statusCode).toBe(200);

    const oldPinRes = await app.inject({
      method: 'POST',
      url: '/portal/auth/login',
      payload: { email: 'lead1@httpfirm3.example', pin: '1234' },
    });
    expect(oldPinRes.statusCode).toBe(401);

    const newPinRes = await app.inject({
      method: 'POST',
      url: '/portal/auth/login',
      payload: { email: 'lead1@httpfirm3.example', pin: '9999' },
    });
    expect(newPinRes.statusCode).toBe(200);
  });
});
