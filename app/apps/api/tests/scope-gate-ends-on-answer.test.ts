/**
 * D-21 over real HTTP: on I-LCFE, I-NASD and I-FMDQ, answering the Q0 scope
 * gate "Rare" or "Effectively none" ends the survey on the answer itself.
 *
 *  - the autosave of that answer sends the response (`submitted: true`), so
 *    the renderer goes straight to the thank-you — never to Q1, where every
 *    save used to come back "Not saved";
 *  - reopening the link lands on the neutral thank-you, not on Q1;
 *  - the response counts as finished: confirmed, thanked once with the
 *    neutral I-04 (never "declined"), and neither the I-02 reminder nor the
 *    scheduled reminder pass will chase it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  getPool,
  updateEditionStatus,
  listInstitutions,
  getRespondentById,
} from '@cis/db';
import {
  seedReferenceData,
  saveContact,
  issueSurveyLink,
  getRegulator,
  sendReminder,
  runReminderPass,
  SUBMISSION_CONFIRMATION_EMAIL_KIND,
} from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

let app: FastifyInstance;
let editionId: string;
let ids: Record<string, string>;

const INSTITUTIONS: Array<[code: string, name: string]> = [
  ['I-LCFE', 'Lagos Commodities and Futures Exchange'],
  ['I-NASD', 'NASD OTC Securities Exchange'],
  ['I-FMDQ', 'FMDQ Group'],
];
const CLOSING = ['Rare', 'Effectively none'];

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
  ids = Object.fromEntries((await listInstitutions(getPool())).map((i) => [i.name, i.id]));
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

/** Issue the institution's link and return its recovery token. */
async function issue(name: string): Promise<string> {
  await saveContact(getPool(), editionId, ids[name]!, 'B', {
    who: 'Amaka Eze',
    role: 'Head, Market Operations',
    email: 'a.eze@institution.cis-mailtest.ng',
    phone: '+234 803 555 0101',
    how: 'Introduced through the CIS courtesy approach',
  });
  const view = await issueSurveyLink(getPool(), editionId, ids[name]!, 'B', {
    targetBy: '2026-11-15',
    portalUrl: 'https://survey.example',
  });
  // The stored link is `/journeys/resume/<token>`.
  return view.surveyLink!.split('/').pop()!;
}

describe('Q0 "Rare" / "Effectively none" ends the institution survey on the answer', () => {
  for (const [code, name] of INSTITUTIONS) {
    for (const answer of CLOSING) {
      it(`${code}: "${answer}" goes straight to the thank-you, finished and never reminded`, async () => {
        const token = await issue(name);
        const opened = await app.inject({
          method: 'GET',
          url: `/journeys/resume/${encodeURIComponent(token)}`,
        });
        expect(opened.json()).toMatchObject({ kind: 'resume', closedByScopeGate: false });
        const respondentId = opened.json<{ respondent: { id: string } }>().respondent.id;

        // The answer itself finishes the survey.
        const saved = await app.inject({
          method: 'PUT',
          url: `/journeys/${respondentId}/answers`,
          payload: { questionId: `${code}-Q0`, ratedFirmId: null, answer: { a: answer }, step: 0 },
        });
        expect(saved.statusCode).toBe(200);
        expect(saved.json()).toMatchObject({ submitted: true, closedByScopeGate: true });
        expect((await getRespondentById(getPool(), respondentId))!.submittedAt).not.toBeNull();

        // The renderer's own submit afterwards is a clean "already sent".
        const submit = await app.inject({
          method: 'POST',
          url: `/journeys/${respondentId}/submit`,
        });
        expect(submit.statusCode).toBe(409);
        expect(submit.json()).toMatchObject({ code: 'ALREADY_SUBMITTED' });

        // Reopening the link: the neutral thank-you, not Q1.
        const again = await app.inject({
          method: 'GET',
          url: `/journeys/resume/${encodeURIComponent(token)}`,
        });
        expect(again.json()).toEqual({ kind: 'already_submitted', closedByScopeGate: true });
        const byId = await app.inject({ method: 'GET', url: `/journeys/${respondentId}/resume` });
        expect(byId.json()).toMatchObject({ closedByScopeGate: true, drafts: [] });

        // Counted as responded, with no attributed passage; never "declined".
        const view = await getRegulator(getPool(), editionId, ids[name]!, 'B');
        expect(view.state).toBe('confirmed');
        expect(view.closedByScopeGate).toBe(true);

        // Thanked once, neutrally.
        const { rows } = await getPool().query<{ subject: string; body_text: string }>(
          'SELECT subject, body_text FROM email_outbox WHERE kind = $1 AND ref_id = $2',
          [SUBMISSION_CONFIRMATION_EMAIL_KIND, respondentId],
        );
        expect(rows).toHaveLength(1);
        expect(`${rows[0]!.subject} ${rows[0]!.body_text}`).not.toMatch(/declin/i);
        expect(rows[0]!.body_text).toMatch(/Thank you/);

        // No reminder: the I-02 reminder has no open link to chase...
        await expect(sendReminder(getPool(), editionId, ids[name]!, 'B')).rejects.toMatchObject({
          code: 'NO_ACTIVE_LINK',
        });
        // ...and the scheduled pass sends this respondent nothing.
        const pass = await runReminderPass(getPool(), {
          asOf: new Date(Date.now() + 30 * 86_400_000),
          portalUrl: 'https://survey.example',
        });
        expect(pass.editions.flatMap((e) => e.sends).map((s) => s.responseId)).not.toContain(
          respondentId,
        );
      });
    }
  }

  it('a non-closing Q0 answer leaves the survey open on Q1', async () => {
    const token = await issue('FMDQ Group');
    const opened = await app.inject({
      method: 'GET',
      url: `/journeys/resume/${encodeURIComponent(token)}`,
    });
    const respondentId = opened.json<{ respondent: { id: string } }>().respondent.id;
    const saved = await app.inject({
      method: 'PUT',
      url: `/journeys/${respondentId}/answers`,
      payload: { questionId: 'I-FMDQ-Q0', ratedFirmId: null, answer: { a: 'Occasional' } },
    });
    expect(saved.json()).toMatchObject({ submitted: false, closedByScopeGate: false });
    expect((await getRespondentById(getPool(), respondentId))!.submittedAt).toBeNull();
  });
});
