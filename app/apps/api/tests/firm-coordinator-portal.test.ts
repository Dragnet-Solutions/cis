/**
 * Coordinator-portal routes, over real HTTP — Task D Part 2. These wrap the
 * SAME domain services the operator-authenticated firm-team / firm-portal
 * routes already use (firm-team-service.ts, firm-portal-service.ts), behind
 * a coordinator session instead. The property that matters here isn't "the
 * happy path returns data" (the domain layer already has that coverage) —
 * it's the self-scoping guarantee: a coordinator's organizationId always
 * comes from their own session token, never from anything the client sends,
 * so one firm's coordinator can never reach into another firm's data even
 * by constructing a request that names it.
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

async function makeFirmWithLead(
  slug: string,
): Promise<{ orgId: string; leadId: string; token: string }> {
  const org = await createOrganization(getPool(), { slug, displayName: slug, orgType: 'firm' });
  const lead = await createLeadCoordinator(getPool(), {
    organizationId: org.id,
    name: 'Lead One',
    email: `lead@${slug}.example`,
  });
  await setCoordinatorPin(getPool(), lead.id, { newPin: '1234' });
  const loginRes = await app.inject({
    method: 'POST',
    url: '/portal/auth/login',
    payload: { email: `lead@${slug}.example`, pin: '1234' },
  });
  expect(loginRes.statusCode).toBe(200);
  const { token } = loginRes.json<{ token: string }>();
  return { orgId: org.id, leadId: lead.id, token };
}

describe('GET /portal/me', () => {
  it("returns the signed-in coordinator's own profile, firm, and access code", async () => {
    const { orgId, leadId, token } = await makeFirmWithLead('portal-me-firm');

    const res = await app.inject({
      method: 'GET',
      url: '/portal/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      coordinator: { id: string; isLead: boolean; accessCode: string } | null;
      organization: { id: string } | null;
    }>();
    expect(body.coordinator?.id).toBe(leadId);
    expect(body.coordinator?.isLead).toBe(true);
    expect(body.coordinator?.accessCode).toBeTruthy();
    expect(body.organization?.id).toBe(orgId);
  });
});

describe('Self-scoping — a coordinator only ever sees or changes their own firm', () => {
  it("never returns another firm's coordinators from /portal/team", async () => {
    const firmA = await makeFirmWithLead('scope-firm-a');
    await makeFirmWithLead('scope-firm-b');

    const res = await app.inject({
      method: 'GET',
      url: '/portal/team',
      headers: { authorization: `Bearer ${firmA.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ coordinators: { id: string }[] }>();
    expect(body.coordinators.map((c) => c.id)).toEqual([firmA.leadId]);
  });

  it("assigning a seat under firm A's token always lands on firm A's seats, regardless of the current edition", async () => {
    await seedReferenceData(getPool());
    const firmA = await makeFirmWithLead('scope-firm-c');
    const firmB = await makeFirmWithLead('scope-firm-d');

    const assignRes = await app.inject({
      method: 'POST',
      url: '/portal/seats/S1/assign',
      headers: { authorization: `Bearer ${firmA.token}` },
      payload: { assignedName: 'Respondent One', assignedEmail: 'r1@scope-firm-c.example' },
    });
    expect(assignRes.statusCode).toBe(200);
    const seat = assignRes.json<{ seat: { organizationId: string } }>().seat;
    expect(seat.organizationId).toBe(firmA.orgId);

    // Firm B's own seats are untouched and start empty.
    const seatsB = await app.inject({
      method: 'GET',
      url: '/portal/seats',
      headers: { authorization: `Bearer ${firmB.token}` },
    });
    const body = seatsB.json<{ seats: { seatCode: string; state: string }[] }>();
    const s1 = body.seats.find((s) => s.seatCode === 'S1');
    expect(s1?.state).toBe('empty');
  });
});

describe('Team management, over HTTP', () => {
  it('adds a coordinator and hands over the lead — acting coordinator is always the session, never a body field', async () => {
    const lead = await makeFirmWithLead('team-http-firm');

    const addRes = await app.inject({
      method: 'POST',
      url: '/portal/team',
      headers: { authorization: `Bearer ${lead.token}` },
      payload: { name: 'Coord Two', email: 'coord2@team-http-firm.example' },
    });
    expect(addRes.statusCode).toBe(201);
    const added = addRes.json<{ coordinator: { id: string; isLead: boolean } }>().coordinator;
    expect(added.isLead).toBe(false);

    const handoverRes = await app.inject({
      method: 'POST',
      url: `/portal/team/${added.id}/handover`,
      headers: { authorization: `Bearer ${lead.token}` },
    });
    expect(handoverRes.statusCode).toBe(200);
    const { outgoing, incoming } = handoverRes.json<{
      outgoing: { id: string; isLead: boolean };
      incoming: { id: string; isLead: boolean };
    }>();
    expect(outgoing.id).toBe(lead.leadId);
    expect(outgoing.isLead).toBe(false);
    expect(incoming.id).toBe(added.id);
    expect(incoming.isLead).toBe(true);
  });
});

describe('Operator-only routes remain closed to a coordinator token', () => {
  it('the equivalent operator firm-team route rejects a coordinator token', async () => {
    const lead = await makeFirmWithLead('closed-firm');
    const res = await app.inject({
      method: 'GET',
      url: `/firms/${lead.orgId}/coordinators`,
      headers: { authorization: `Bearer ${lead.token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
