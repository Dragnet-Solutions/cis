/**
 * The public S1/S2/S3 seat entry point, over real HTTP — Task D Part 6.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getPool, createOrganization } from '@cis/db';
import { getSeats, assignSeat, confirmSeatReplacement, seedReferenceData } from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

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

describe('The seat entry point, over HTTP', () => {
  it('resolves context, starts a journey, and completing it moves the seat to complete', async () => {
    const seed = await seedReferenceData(getPool());
    const org = await createOrganization(getPool(), {
      slug: 'http-seat-firm',
      displayName: 'HTTP Seat Firm',
      orgType: 'firm',
    });
    await getSeats(getPool(), seed.editionId, org.id);
    const seat = await assignSeat(getPool(), {
      editionId: seed.editionId,
      organizationId: org.id,
      seatCode: 'S1',
      assignedName: 'Jane MD',
      assignedEmail: 'jane@http-seat-firm.example',
    });

    const ctxRes = await app.inject({
      method: 'GET',
      url: `/firm-seats/${seat.linkToken}/context`,
    });
    expect(ctxRes.statusCode).toBe(200);
    expect(ctxRes.json<{ state: string; seatCode: string }>()).toMatchObject({
      state: 'invited',
      seatCode: 'S1',
    });

    const startRes = await app.inject({
      method: 'POST',
      url: `/firm-seats/${seat.linkToken}/start`,
    });
    expect(startRes.statusCode).toBe(201);
    const { respondentId } = startRes.json<{ respondentId: string }>();
    expect(respondentId).toBeTruthy();

    const midCtxRes = await app.inject({
      method: 'GET',
      url: `/firm-seats/${seat.linkToken}/context`,
    });
    expect(midCtxRes.json<{ state: string }>().state).toBe('started');

    const completeRes = await app.inject({
      method: 'POST',
      url: `/firm-seats/${seat.linkToken}/complete`,
    });
    expect(completeRes.statusCode).toBe(200);

    const finalCtxRes = await app.inject({
      method: 'GET',
      url: `/firm-seats/${seat.linkToken}/context`,
    });
    expect(finalCtxRes.json<{ state: string }>().state).toBe('complete');
  });

  // Regression (E2E, 2026-09-30): a seat holder who closed the browser
  // mid-survey was locked out — the link refused a started seat.
  it('lets the seat link resume a started, unfinished survey', async () => {
    const seed = await seedReferenceData(getPool());
    const org = await createOrganization(getPool(), {
      slug: 'resume-seat-firm',
      displayName: 'Resume Seat Firm',
      orgType: 'firm',
    });
    await getSeats(getPool(), seed.editionId, org.id);
    const seat = await assignSeat(getPool(), {
      editionId: seed.editionId,
      organizationId: org.id,
      seatCode: 'S3',
      assignedName: 'Ops Lead',
      assignedEmail: 'ops@resume-seat-firm.example',
    });

    const first = await app.inject({ method: 'POST', url: `/firm-seats/${seat.linkToken}/start` });
    const again = await app.inject({ method: 'POST', url: `/firm-seats/${seat.linkToken}/start` });
    expect(again.statusCode).toBe(201);
    expect(again.json<{ respondentId: string }>().respondentId).toBe(
      first.json<{ respondentId: string }>().respondentId,
    );

    await app.inject({ method: 'POST', url: `/firm-seats/${seat.linkToken}/complete` });
    const afterComplete = await app.inject({
      method: 'POST',
      url: `/firm-seats/${seat.linkToken}/start`,
    });
    expect(afterComplete.statusCode).toBe(400);
  });

  it('returns 404 for an unknown link token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/firm-seats/00000000-0000-0000-0000-000000000000/context`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('a stale link from before a reassignment no longer resolves', async () => {
    const seed = await seedReferenceData(getPool());
    const org = await createOrganization(getPool(), {
      slug: 'http-seat-firm-2',
      displayName: 'HTTP Seat Firm Two',
      orgType: 'firm',
    });
    await getSeats(getPool(), seed.editionId, org.id);
    const seat = await assignSeat(getPool(), {
      editionId: seed.editionId,
      organizationId: org.id,
      seatCode: 'S2',
      assignedName: 'Old Compliance',
      assignedEmail: 'old@http-seat-firm-2.example',
    });
    const oldToken = seat.linkToken;

    await confirmSeatReplacement(getPool(), seed.editionId, org.id, 'S2');
    await assignSeat(getPool(), {
      editionId: seed.editionId,
      organizationId: org.id,
      seatCode: 'S2',
      assignedName: 'New Compliance',
      assignedEmail: 'new@http-seat-firm-2.example',
    });

    const res = await app.inject({ method: 'GET', url: `/firm-seats/${oldToken}/context` });
    expect(res.statusCode).toBe(404);
  });
});
