/**
 * The public respondent journey over real HTTP once collection has closed
 * (E2E 2026-10-09, D33) and for the regulator reviews (D1). The server is the
 * gate: every entry route is refused after the results lock, an in-progress
 * survey cannot be sent, and a regulator review cannot be started without
 * its issued link.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  getPool,
  createOrganization,
  upsertEditionParticipation,
  updateEditionStatus,
  getInstrumentItems,
  listInstitutions,
} from '@cis/db';
import {
  seedReferenceData,
  ensureOutreachLinks,
  getSeats,
  assignSeat,
  saveContact,
  issueSurveyLink,
} from '@cis/domain';
import { buildJourneySequence } from '@cis/survey';
import { validAnswerFor } from '../../../packages/domain/tests/helpers/answers';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

let app: FastifyInstance;
let editionId: string;
let firmId: string;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  const seed = await seedReferenceData(getPool());
  editionId = seed.editionId;
  await updateEditionStatus(getPool(), editionId, 'open');
  const org = await createOrganization(getPool(), {
    slug: 'closed-http-firm',
    displayName: 'Closed HTTP Firm',
    orgType: 'firm',
  });
  await upsertEditionParticipation(getPool(), {
    editionId,
    organizationId: org.id,
    status: 'active',
  });
  firmId = org.id;
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

const lock = () => updateEditionStatus(getPool(), editionId, 'locked');

describe('GET /journeys/context', () => {
  it('says whether the edition is still collecting', async () => {
    let ctx = (await app.inject({ method: 'GET', url: '/journeys/context' })).json();
    expect(ctx).toMatchObject({ editionId, editionStatus: 'open', collectionOpen: true });
    await lock();
    ctx = (await app.inject({ method: 'GET', url: '/journeys/context' })).json();
    expect(ctx).toMatchObject({ editionId, editionStatus: 'locked', collectionOpen: false });
  });
});

describe('After the results lock (D33)', () => {
  it('refuses a public start for every investor instrument, with or without a firm link', async () => {
    await lock();
    for (const payload of [
      { editionId, instrumentCode: 'S4' },
      { editionId, instrumentCode: 'S5a', institutionName: 'Acme Pension' },
      { editionId, instrumentCode: 'S5b', institutionName: 'Acme Abroad' },
      { editionId, instrumentCode: 'S4', recruitingFirmId: firmId },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/journeys', payload });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'CollectionClosedError' });
    }
  });

  it('refuses an outreach (?ref=) start: the link resolves, the start does not', async () => {
    const tokens: Record<string, string> = {
      individual: randomUUID(),
      local_institutional: randomUUID(),
      foreign_institutional: randomUUID(),
    };
    await ensureOutreachLinks(getPool(), editionId, firmId, (seg) => tokens[seg]!);
    await lock();
    const ctx = await app.inject({
      method: 'GET',
      url: `/outreach/${tokens['individual']}/context`,
    });
    expect(ctx.statusCode).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: '/journeys',
      payload: { editionId, instrumentCode: 'S4', recruitingFirmId: firmId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a firm seat start', async () => {
    await getSeats(getPool(), editionId, firmId);
    const seat = await assignSeat(getPool(), {
      editionId,
      organizationId: firmId,
      seatCode: 'S2',
      assignedName: 'Ola Ops',
      assignedEmail: 'ola@closed-http-firm.example',
    });
    await lock();
    const res = await app.inject({ method: 'POST', url: `/firm-seats/${seat.linkToken}/start` });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to send a survey that was in progress when the lock landed', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/journeys',
      payload: { editionId, instrumentCode: 'S4' },
    });
    const { respondentId } = start.json<{ respondentId: string }>();
    await app.inject({
      method: 'POST',
      url: `/journeys/${respondentId}/contact`,
      payload: { consentAccepted: true, channel: 'none' },
    });
    await app.inject({
      method: 'POST',
      url: `/journeys/${respondentId}/rated-firms`,
      payload: { firmIds: [firmId] },
    });
    const sequence = buildJourneySequence(await getInstrumentItems(getPool(), 'S4'), [firmId]);
    for (const s of sequence) {
      const r = await app.inject({
        method: 'PUT',
        url: `/journeys/${respondentId}/answers`,
        payload: {
          questionId: s.item.id,
          ratedFirmId: s.ratedFirmId,
          answer: validAnswerFor(s.item),
        },
      });
      expect(r.statusCode).toBe(200);
    }

    await lock();

    const submit = await app.inject({ method: 'POST', url: `/journeys/${respondentId}/submit` });
    expect(submit.statusCode).toBe(403);
    expect(submit.json<{ message: string }>().message).toMatch(/closed/i);
    const save = await app.inject({
      method: 'PUT',
      url: `/journeys/${respondentId}/answers`,
      payload: { questionId: 'S4-P1', ratedFirmId: null, answer: { a: 'x' } },
    });
    expect(save.statusCode).toBe(403);
  });

  it("turns a regulator's unfinished issued link into the closed state", async () => {
    const sec = (await listInstitutions(getPool())).find(
      (i) => i.name === 'Securities and Exchange Commission',
    )!.id;
    await saveContact(getPool(), editionId, sec, 'A', {
      who: 'Hauwa Ibrahim',
      role: 'Director, Market Supervision',
      email: 'h.ibrahim@sec.example',
      phone: '+234 803 221 4470',
      how: 'Introduced by the Registrar',
    });
    const view = await issueSurveyLink(getPool(), editionId, sec, 'A', { targetBy: '2026-11-01' });
    const token = view.surveyLink!.split('/').pop()!;

    const before = await app.inject({ method: 'GET', url: `/journeys/resume/${token}` });
    expect(before.json<{ kind: string }>().kind).toBe('resume');
    await lock();
    const after = await app.inject({ method: 'GET', url: `/journeys/resume/${token}` });
    expect(after.json()).toEqual({ kind: 'participation_closed' });
  });
});

describe('Regulator reviews have no public start (D1)', () => {
  it.each(['I-SEC', 'I-NGX', 'I-CSCS', 'I-DEP'])('POST /journeys refuses %s', async (code) => {
    const res = await app.inject({
      method: 'POST',
      url: '/journeys',
      payload: { editionId, instrumentCode: code, institutionName: 'SEC' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'RegulatorLinkRequiredError' });
  });

  it('POST /journeys/colleague-invite refuses a regulator review too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/journeys/colleague-invite',
      payload: { editionId, instrumentCode: 'I-SEC', institutionName: 'SEC' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /journeys/consent-content (D6)', () => {
  it('never sends the internal provisional / ownership note', async () => {
    const res = await app.inject({ method: 'GET', url: '/journeys/consent-content' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ consent: Record<string, unknown> }>();
    expect(Object.keys(body.consent).sort()).toEqual([
      'checkboxLabel',
      'expansion',
      'expansionTitle',
      'notice',
    ]);
  });
});
