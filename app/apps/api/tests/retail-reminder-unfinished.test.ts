/**
 * D-03 over real HTTP: the manual "Retail survey reminder" on the Invitations
 * page goes only to retail respondents who have NOT finished (never to anyone
 * who submitted), each linked back into their own survey, and the audience
 * picker and the send result both say how many that is.
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
  getRespondentById,
} from '@cis/db';
import { seedReferenceData, INVITATION_BATCH_EMAIL_KIND } from '@cis/domain';
import { buildJourneySequence } from '@cis/survey';
import { validAnswerFor } from '../../../packages/domain/tests/helpers/answers';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';

let app: FastifyInstance;
let editionId: string;
let firmId: string;
let token: string;

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
    slug: 'reminder-firm',
    displayName: 'Reminder Firm',
    orgType: 'firm',
  });
  firmId = org.id;
  await upsertEditionParticipation(getPool(), {
    editionId,
    organizationId: firmId,
    status: 'active',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'adaeze.okoro@cis.example', password: PASSWORD },
  });
  token = login.json<{ token: string }>().token;
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

const auth = () => ({ authorization: `Bearer ${token}` });

/** A retail (S4) respondent who started, answering everything when `finish`. */
async function retail(
  contact: { channel: 'email' | 'none' | 'text'; email?: string; phone?: string },
  finish: boolean,
): Promise<string> {
  const start = await app.inject({
    method: 'POST',
    url: '/journeys',
    payload: { editionId, instrumentCode: 'S4' },
  });
  const { respondentId } = start.json<{ respondentId: string }>();
  await app.inject({
    method: 'POST',
    url: `/journeys/${respondentId}/contact`,
    payload: { consentAccepted: true, ...contact },
  });
  await app.inject({
    method: 'POST',
    url: `/journeys/${respondentId}/rated-firms`,
    payload: { firmIds: [firmId] },
  });
  const steps = buildJourneySequence(await getInstrumentItems(getPool(), 'S4'), [firmId]);
  for (const s of finish ? steps : steps.slice(0, 1)) {
    await app.inject({
      method: 'PUT',
      url: `/journeys/${respondentId}/answers`,
      payload: {
        questionId: s.item.id,
        ratedFirmId: s.ratedFirmId,
        answer: validAnswerFor(s.item),
      },
    });
  }
  if (finish) {
    const res = await app.inject({ method: 'POST', url: `/journeys/${respondentId}/submit` });
    expect(res.statusCode).toBe(200);
  }
  return respondentId;
}

describe('The manual retail survey reminder (D-03)', () => {
  it('reaches only unfinished respondents, with their own link, and says how many', async () => {
    await retail({ channel: 'email', email: 'done@inbox.cis-mailtest.ng' }, true);
    const pending = await retail(
      { channel: 'email', email: 'pending@inbox.cis-mailtest.ng' },
      false,
    );
    await retail({ channel: 'none' }, false); // unfinished, but no way to email them
    await retail({ channel: 'text', phone: '+234 803 555 0199' }, false); // text only

    const audiences = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/invitations/audiences`,
      headers: auth(),
    });
    const categories = audiences.json<{
      audiences: Array<{
        key: string;
        audiences: Array<{ id: string; count: number | null; unfinishedCount?: number }>;
      }>;
    }>().audiences;
    const retailAudience = categories
      .find((c) => c.key === 'parts')!
      .audiences.find((a) => a.id === 'retail')!;
    expect(retailAudience.unfinishedCount).toBe(1);

    const templates = await app.inject({
      method: 'GET',
      url: `/editions/${editionId}/invitations/templates`,
      headers: auth(),
    });
    const list = templates.json<{ templates: Array<{ id: string; name: string }> }>().templates;
    const reminder = list.find((t) => t.name === 'Retail survey reminder')!;

    const sent = await app.inject({
      method: 'POST',
      url: `/editions/${editionId}/invitations/send`,
      headers: auth(),
      payload: { templateId: reminder.id, audienceId: 'retail' },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ attempted: 1, sent: 1, notSent: 0 });

    const { rows } = await getPool().query<{ to_address: string; body_text: string }>(
      'SELECT to_address, body_text FROM email_outbox WHERE kind = $1',
      [INVITATION_BATCH_EMAIL_KIND],
    );
    expect(rows.map((r) => r.to_address)).toEqual(['pending@inbox.cis-mailtest.ng']);
    // The link goes back into their own survey, not the public start page.
    const recovery = (await getRespondentById(getPool(), pending))!.recoveryToken!;
    expect(rows[0]!.body_text).toContain(recovery);
  });
});
