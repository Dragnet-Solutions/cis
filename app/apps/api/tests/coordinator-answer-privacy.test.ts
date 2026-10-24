/**
 * D-24 over real HTTP: a coordinator (firm portal user) can never see a
 * respondent's answers — not once the survey is sent, and not while it is
 * still in progress.
 *
 * What protects it:
 *  - an unsent response's saved answers are reachable only through its own
 *    handles: the respondent id (`GET /journeys/:id/resume`) and the seat's
 *    link (`/firm-seats/:token/start`, which resumes a started seat);
 *  - the portal never hands a coordinator either handle for anyone else's
 *    seat: no respondent id anywhere, and a seat link only on their own seat;
 *  - once sent, the link resolves to "complete" (it cannot be resumed) and the
 *    resume state by id carries no answers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  getPool,
  createOrganization,
  upsertEditionParticipation,
  updateEditionStatus,
  getInstrumentItems,
  listSeats,
} from '@cis/db';
import { createLeadCoordinator, setCoordinatorPin, seedReferenceData } from '@cis/domain';
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
let orgId: string;
let token: string;
const LEAD_EMAIL = 'lead@privacy-firm.example';

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  editionId = (await seedReferenceData(getPool())).editionId;
  await updateEditionStatus(getPool(), editionId, 'open');
  const org = await createOrganization(getPool(), {
    slug: 'privacy-firm',
    displayName: 'Privacy Firm',
    orgType: 'firm',
  });
  orgId = org.id;
  await upsertEditionParticipation(getPool(), {
    editionId,
    organizationId: orgId,
    status: 'active',
  });
  const lead = await createLeadCoordinator(getPool(), {
    organizationId: orgId,
    name: 'Lead One',
    email: LEAD_EMAIL,
  });
  await setCoordinatorPin(getPool(), lead.id, { newPin: '1234' });
  const login = await app.inject({
    method: 'POST',
    url: '/portal/auth/login',
    payload: { email: LEAD_EMAIL, pin: '1234' },
  });
  token = login.json<{ token: string }>().token;
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

const auth = () => ({ authorization: `Bearer ${token}` });

/** Every portal read a coordinator can make, as raw text. */
async function everythingTheCoordinatorCanRead(): Promise<string> {
  const urls = [
    '/portal/me',
    '/portal/team',
    '/portal/seats',
    '/portal/seat-status',
    '/portal/can-invite',
    '/portal/investor-categories',
    '/portal/outreach',
    `/portal/editions/${editionId}/report`,
  ];
  const bodies: string[] = [];
  for (const url of urls) {
    const res = await app.inject({ method: 'GET', url, headers: auth() });
    bodies.push(res.body);
  }
  return bodies.join('\n');
}

/** The seat holder (not the coordinator) starts S2 from their own link and
 *  saves some answers, leaving it in progress. */
async function seatHolderAnswersSome(linkToken: string, count: number) {
  const start = await app.inject({ method: 'POST', url: `/firm-seats/${linkToken}/start` });
  const { respondentId } = start.json<{ respondentId: string }>();
  const steps = buildJourneySequence(await getInstrumentItems(getPool(), 'S2'), []);
  for (const s of steps.slice(0, count)) {
    const r = await app.inject({
      method: 'PUT',
      url: `/journeys/${respondentId}/answers`,
      payload: { questionId: s.item.id, ratedFirmId: null, answer: validAnswerFor(s.item) },
    });
    expect(r.statusCode).toBe(200);
  }
  return { respondentId, steps };
}

describe('A coordinator never sees a respondent’s answers (D-24)', () => {
  it('in progress: no portal endpoint hands over the respondent id or their link', async () => {
    const assigned = await app.inject({
      method: 'POST',
      url: '/portal/seats/S2/assign',
      headers: auth(),
      payload: { assignedName: 'Chidi Compliance', assignedEmail: 'chidi@privacy-firm.example' },
    });
    expect(assigned.statusCode).toBe(200);
    const seatView = assigned.json<{ seat: Record<string, unknown> }>().seat;
    expect(seatView).not.toHaveProperty('respondentId');
    expect(seatView['linkToken']).toBeNull();

    // The link exists only in the seat holder's email (read here from the DB).
    const s2 = (await listSeats(getPool(), editionId, orgId)).find((s) => s.seatCode === 'S2')!;
    const { respondentId } = await seatHolderAnswersSome(s2.linkToken, 3);
    const seats = await app.inject({ method: 'GET', url: '/portal/seats', headers: auth() });
    expect(
      seats
        .json<{ seats: Array<{ seatCode: string; state: string }> }>()
        .seats.find((s) => s.seatCode === 'S2')!.state,
    ).toBe('started');

    const everything = await everythingTheCoordinatorCanRead();
    expect(everything).not.toContain(respondentId);
    expect(everything).not.toContain(s2.linkToken);
  });

  it('the coordinator’s own seat keeps its link — and only that one', async () => {
    await app.inject({
      method: 'POST',
      url: '/portal/seats/S1/assign',
      headers: auth(),
      payload: { assignedName: 'Lead One', assignedEmail: LEAD_EMAIL, isSelf: true },
    });
    await app.inject({
      method: 'POST',
      url: '/portal/seats/S3/assign',
      headers: auth(),
      payload: { assignedName: 'Ola Ops', assignedEmail: 'ola@privacy-firm.example' },
    });
    const seats = (
      await app.inject({ method: 'GET', url: '/portal/seats', headers: auth() })
    ).json<{ seats: Array<{ seatCode: string; linkToken: string | null }> }>().seats;
    const db = await listSeats(getPool(), editionId, orgId);
    expect(seats.find((s) => s.seatCode === 'S1')!.linkToken).toBe(
      db.find((s) => s.seatCode === 'S1')!.linkToken,
    );
    expect(seats.find((s) => s.seatCode === 'S3')!.linkToken).toBeNull();
    for (const s of seats) expect(s).not.toHaveProperty('respondentId');
  });

  it('sent: the link no longer opens the survey, and the resume state carries no answers', async () => {
    await app.inject({
      method: 'POST',
      url: '/portal/seats/S2/assign',
      headers: auth(),
      payload: { assignedName: 'Chidi Compliance', assignedEmail: 'chidi@privacy-firm.example' },
    });
    const s2 = (await listSeats(getPool(), editionId, orgId)).find((s) => s.seatCode === 'S2')!;
    const { respondentId, steps } = await seatHolderAnswersSome(s2.linkToken, Infinity);
    expect(steps.length).toBeGreaterThan(0);
    const submit = await app.inject({ method: 'POST', url: `/journeys/${respondentId}/submit` });
    expect(submit.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/firm-seats/${s2.linkToken}/complete` });

    const ctx = await app.inject({ method: 'GET', url: `/firm-seats/${s2.linkToken}/context` });
    expect(ctx.json<{ state: string }>().state).toBe('complete');
    const reopen = await app.inject({ method: 'POST', url: `/firm-seats/${s2.linkToken}/start` });
    expect(reopen.statusCode).toBeGreaterThanOrEqual(400);
    const resume = await app.inject({ method: 'GET', url: `/journeys/${respondentId}/resume` });
    expect(resume.json<{ drafts: unknown[] }>().drafts).toEqual([]);

    expect(await everythingTheCoordinatorCanRead()).not.toContain(respondentId);
  });
});
