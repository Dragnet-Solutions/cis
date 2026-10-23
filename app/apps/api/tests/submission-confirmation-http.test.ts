/**
 * D-02 over real HTTP: submitting a survey queues its confirmation, a second
 * submit request queues nothing more, and the confirmation's opt-out link
 * (POST /journeys/report-opt-out/:token) clears the report choice.
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
import { seedReferenceData, SUBMISSION_CONFIRMATION_EMAIL_KIND } from '@cis/domain';
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
  editionId = (await seedReferenceData(getPool())).editionId;
  await updateEditionStatus(getPool(), editionId, 'open');
  const org = await createOrganization(getPool(), {
    slug: 'confirm-http-firm',
    displayName: 'Confirm HTTP Firm',
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

async function confirmations(respondentId: string) {
  const { rows } = await getPool().query(
    'SELECT to_address FROM email_outbox WHERE kind = $1 AND ref_id = $2',
    [SUBMISSION_CONFIRMATION_EMAIL_KIND, respondentId],
  );
  return rows as Array<{ to_address: string }>;
}

describe('POST /journeys/:id/submit — submission confirmation', () => {
  it('queues exactly one confirmation, even when the submit is repeated', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/journeys',
      payload: { editionId, instrumentCode: 'S4' },
    });
    const { respondentId } = start.json<{ respondentId: string }>();
    await app.inject({
      method: 'POST',
      url: `/journeys/${respondentId}/contact`,
      payload: { consentAccepted: true, channel: 'email', email: 'http@inbox.cis-mailtest.ng' },
    });
    await app.inject({
      method: 'POST',
      url: `/journeys/${respondentId}/rated-firms`,
      payload: { firmIds: [firmId] },
    });
    const items = await getInstrumentItems(getPool(), 'S4');
    for (const s of buildJourneySequence(items, [firmId])) {
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

    const res = await app.inject({ method: 'POST', url: `/journeys/${respondentId}/submit` });
    expect(res.statusCode).toBe(200);
    expect(await confirmations(respondentId)).toEqual([
      { to_address: 'http@inbox.cis-mailtest.ng' },
    ]);

    // A repeated submit is a clean 409 — never a 500 — and sends nothing more.
    const again = await app.inject({ method: 'POST', url: `/journeys/${respondentId}/submit` });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ statusCode: 409, code: 'ALREADY_SUBMITTED' });
    expect(await confirmations(respondentId)).toHaveLength(1);

    // The opt-out link in the email.
    const token = (await getRespondentById(getPool(), respondentId))!.recoveryToken!;
    const out = await app.inject({
      method: 'POST',
      url: `/journeys/report-opt-out/${encodeURIComponent(token)}`,
    });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ kind: 'report_opted_out' });
    expect((await getRespondentById(getPool(), respondentId))!.reportDelivery).toBe('none');
  });

  it('the opt-out route answers 404 for an unknown link', async () => {
    const res = await app.inject({ method: 'POST', url: '/journeys/report-opt-out/nope' });
    expect(res.statusCode).toBe(404);
  });
});
