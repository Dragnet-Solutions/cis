/**
 * The public outreach-link consumption routes, over real HTTP — Task E. The
 * other half of `ensureOutreachLinks`/`getOutreachVolumes`, which create and
 * read links but had no real consumer anywhere: a real investor could follow
 * a real firm's outreach link, complete the entire survey, and the link's
 * counts would stay at zero forever.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getPool, createOrganization } from '@cis/db';
import {
  ensureOutreachLinks,
  getOutreachVolumes,
  seedReferenceData,
  createLeadCoordinator,
  setCoordinatorPin,
} from '@cis/domain';
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

async function seedOutreachLinks(editionId: string, organizationId: string) {
  const tokens: Record<string, string> = {
    individual: randomUUID(),
    local_institutional: randomUUID(),
    foreign_institutional: randomUUID(),
  };
  await ensureOutreachLinks(getPool(), editionId, organizationId, (seg) => tokens[seg]!);
  return tokens;
}

describe('GET /outreach/:token/context', () => {
  it('resolves a real token to edition/firm/segment only', async () => {
    const seed = await seedReferenceData(getPool());
    const org = await createOrganization(getPool(), {
      slug: 'http-outreach-firm',
      displayName: 'HTTP Outreach Firm',
      orgType: 'firm',
    });
    const tokens = await seedOutreachLinks(seed.editionId, org.id);

    const res = await app.inject({
      method: 'GET',
      url: `/outreach/${tokens['individual']}/context`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      editionId: seed.editionId,
      organizationId: org.id,
      segment: 'individual',
    });
  });

  it('returns 404 for an unknown token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/outreach/${'00000000-0000-0000-0000-000000000000'}/context`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /outreach/:token/event', () => {
  it('a real opens/starts/finishes sequence increments the real counters, visible on reload via the firm-facing read', async () => {
    const seed = await seedReferenceData(getPool());
    const org = await createOrganization(getPool(), {
      slug: 'http-outreach-firm-2',
      displayName: 'HTTP Outreach Firm Two',
      orgType: 'firm',
    });
    const tokens = await seedOutreachLinks(seed.editionId, org.id);

    for (const event of ['opens', 'opens', 'starts', 'finishes'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/outreach/${tokens['individual']}/event`,
        payload: { event },
      });
      expect(res.statusCode).toBe(200);
    }

    const volumes = await getOutreachVolumes(getPool(), seed.editionId, org.id);
    const individual = volumes.find((v) => v.segment === 'individual');
    expect(individual).toMatchObject({ opens: 2, starts: 1, finishes: 1 });

    // Untouched segments are unaffected.
    const local = volumes.find((v) => v.segment === 'local_institutional');
    expect(local).toMatchObject({ opens: 0, starts: 0, finishes: 0 });
  });

  it('silently succeeds for an unknown token — never blocks the respondent it would otherwise interrupt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/outreach/${'00000000-0000-0000-0000-000000000000'}/event`,
      payload: { event: 'opens' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("A firm's own coordinator-authenticated read carries the real token", () => {
  it('GET /portal/outreach returns the real token per segment, not fabricated ones', async () => {
    await seedReferenceData(getPool());
    const org = await createOrganization(getPool(), {
      slug: 'http-outreach-firm-3',
      displayName: 'HTTP Outreach Firm Three',
      orgType: 'firm',
    });
    const lead = await createLeadCoordinator(getPool(), {
      organizationId: org.id,
      name: 'Lead One',
      email: 'lead@http-outreach-firm-3.example',
    });
    await setCoordinatorPin(getPool(), lead.id, { newPin: '1234' });
    const loginRes = await app.inject({
      method: 'POST',
      url: '/portal/auth/login',
      payload: { email: 'lead@http-outreach-firm-3.example', pin: '1234' },
    });
    const { token: coordinatorToken } = loginRes.json<{ token: string }>();

    const res = await app.inject({
      method: 'GET',
      url: '/portal/outreach',
      headers: { authorization: `Bearer ${coordinatorToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ links: Array<{ token: string; segment: string }> }>();
    expect(body.links).toHaveLength(3);
    for (const link of body.links) {
      expect(link.token).toBeTruthy();
      // The token this route returns must be the SAME one the public
      // context route resolves — proving the "real link" the coordinator
      // sees is the one a respondent following it actually reaches.
      const ctxRes = await app.inject({ method: 'GET', url: `/outreach/${link.token}/context` });
      expect(ctxRes.statusCode).toBe(200);
      expect(ctxRes.json<{ organizationId: string }>().organizationId).toBe(org.id);
    }
  });
});
