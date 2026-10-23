/**
 * D-02 — a submission is confirmed by email (when an address is known), and
 * the email says what happens next. One per survey type: an investor (retail
 * S4, institutional S5a / S5b), a firm seat (S1 / S2 / S3) with its
 * coordinator's progress notice, and a market institution (I-*), including
 * the Q0-closed variant. Queued in the submission's own transaction, exactly
 * once, never carrying an answer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  getInstrumentItems,
  getRespondentById,
  getSeat,
  listInstitutions,
  updateClosingDate,
  upsertEditionParticipation,
} from '@cis/db';
import type { SurveyItem } from '@cis/survey';
import {
  seedReferenceData,
  startJourney,
  registerContact,
  setRatedFirms,
  submitJourney,
  saveDraftAnswer,
  getResumeByToken,
  saveContact,
  issueSurveyLink,
  getSeats,
  assignSeat,
  startSeatEntry,
  createLeadCoordinator,
  optOutOfReport,
  SUBMISSION_CONFIRMATION_EMAIL_KIND,
  FIRM_SEAT_PROGRESS_EMAIL_KIND,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';
import { answerAll } from './helpers/answers';

const PORTAL = 'https://cis.example.ng';

let pool: Pool;
let editionId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  editionId = (await seedReferenceData(pool)).editionId;
});
afterAll(async () => {
  await closeTestPool();
});

interface OutboxRow {
  kind: string;
  ref_id: string | null;
  to_address: string;
  subject: string;
  body_text: string;
  body_html: string | null;
}

async function outbox(kinds = [SUBMISSION_CONFIRMATION_EMAIL_KIND, FIRM_SEAT_PROGRESS_EMAIL_KIND]) {
  const { rows } = await pool.query<OutboxRow>(
    `SELECT kind, ref_id, to_address, subject, body_text, body_html
       FROM email_outbox WHERE kind = ANY($1) ORDER BY created_at, kind`,
    [kinds],
  );
  return rows;
}

async function activeFirm(slug: string, name = slug.toUpperCase()) {
  const org = await createOrganization(pool, { slug, displayName: name, orgType: 'firm' });
  await upsertEditionParticipation(pool, { editionId, organizationId: org.id, status: 'active' });
  return org;
}

/** No answer the respondent gave appears anywhere in the email. */
async function expectNoAnswers(respondentId: string, row: OutboxRow) {
  const { rows } = await pool.query<{ answer: { a: unknown; c?: string } }>(
    'SELECT answer FROM responses WHERE respondent_id = $1',
    [respondentId],
  );
  expect(rows.length).toBeGreaterThan(0);
  const body = `${row.subject}\n${row.body_text}\n${row.body_html ?? ''}`;
  for (const { answer } of rows) {
    const values = (typeof answer.a === 'string' ? [answer.a] : []).concat(
      answer.c ? [answer.c] : [],
    );
    for (const v of values) {
      // Short option words ("No", "Rare") could appear in ordinary prose;
      // only distinctive free text is a meaningful leak check.
      if (v.length >= 12) expect(body).not.toContain(v);
    }
  }
  expect(body).not.toContain('A written answer.');
}

async function investor(
  code: 'S4' | 'S5a' | 'S5b',
  contact: Parameters<typeof registerContact>[2],
) {
  const firm = await activeFirm(`rated-${code.toLowerCase()}`);
  const r = await startJourney(pool, {
    editionId,
    instrumentCode: code,
    ...(code === 'S4' ? {} : { institutionName: 'Harbour Pension Fund' }),
  });
  await registerContact(pool, r.id, contact);
  await setRatedFirms(pool, r.id, [firm.id]);
  await answerAll(pool, r.id, await getInstrumentItems(pool, code), [firm.id]);
  return r.id;
}

describe('Investors — retail S4 and institutional S5a / S5b', () => {
  it('retail: one confirmation saying which report, how, when (from the edition) and how to opt out', async () => {
    await updateClosingDate(pool, editionId, new Date('2026-11-30T12:00:00Z'));
    const id = await investor('S4', {
      consentAccepted: true,
      channel: 'email',
      email: 'ngozi.retail@inbox.cis-mailtest.ng',
    });
    await submitJourney(pool, id, { portalUrl: PORTAL });

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    const [m] = rows as [OutboxRow];
    expect(m).toMatchObject({
      kind: SUBMISSION_CONFIRMATION_EMAIL_KIND,
      ref_id: id,
      to_address: 'ngozi.retail@inbox.cis-mailtest.ng',
    });
    // P-04: what they will receive, when (from the edition) and where.
    expect(m.subject).toBe('Thank you for taking part');
    expect(m.body_text).toContain('What you will receive: The published industry report');
    expect(m.body_text).toContain('Sent to: This email address');
    expect(m.body_text).not.toContain('on behalf of');
    expect(m.body_text).toContain('30 November 2026');
    const token = (await getRespondentById(pool, id))!.recoveryToken!;
    expect(m.body_text).toContain(`${PORTAL}/survey?noReport=${token}`);
    await expectNoAnswers(id, m);

    // The opt-out link clears the report choice and stops further contact.
    expect(await optOutOfReport(pool, token)).toBe(true);
    const after = await getRespondentById(pool, id);
    expect(after!.reportDelivery).toBe('none');
    const { rows: flag } = await pool.query(
      'SELECT reminders_opted_out FROM respondents WHERE id = $1',
      [id],
    );
    expect(flag[0].reminders_opted_out).toBe(true);
    expect(await optOutOfReport(pool, 'not-a-token')).toBe(false);
  });

  it('never invents a report date the edition does not hold', async () => {
    await pool.query(
      'UPDATE editions SET survey_close_at = NULL, results_published_at = NULL WHERE id = $1',
      [editionId],
    );
    const id = await investor('S4', {
      consentAccepted: true,
      channel: 'both',
      email: 'b@inbox.cis-mailtest.ng',
      phone: '+234 803 555 0199',
    });
    await submitJourney(pool, id, { portalUrl: PORTAL });
    const [m] = (await outbox()) as [OutboxRow];
    expect(m.body_text).not.toMatch(/closes on|published on/);
    expect(m.body_text).toContain('once the survey has closed');
  });

  for (const code of ['S5a', 'S5b'] as const) {
    it(`institutional ${code}: one confirmation, naming the institution`, async () => {
      const id = await investor(code, {
        consentAccepted: true,
        channel: 'email',
        email: `${code.toLowerCase()}@harbour.cis-mailtest.ng`,
      });
      await submitJourney(pool, id, { portalUrl: PORTAL });
      const rows = await outbox();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: SUBMISSION_CONFIRMATION_EMAIL_KIND,
        ref_id: id,
        to_address: `${code.toLowerCase()}@harbour.cis-mailtest.ng`,
      });
      expect(rows[0]!.subject).toBe('Thank you for taking part');
      expect(rows[0]!.body_text).toContain('investor survey on behalf of Harbour Pension Fund.');
      expect(rows[0]!.body_text).toContain('The published industry report');
      expect(rows[0]!.body_text).toContain('noReport=');
      await expectNoAnswers(id, rows[0]!);
    });
  }

  it('no address given (text only, or no contact): no email', async () => {
    const a = await investor('S4', {
      consentAccepted: true,
      channel: 'text',
      phone: '+234 803 555 0100',
    });
    await submitJourney(pool, a, { portalUrl: PORTAL });
    const b = await investor('S5a', { consentAccepted: true, channel: 'none' });
    await submitJourney(pool, b, { portalUrl: PORTAL });
    expect(await outbox()).toHaveLength(0);
  });

  it('a repeated submit queues nothing extra', async () => {
    const id = await investor('S4', {
      consentAccepted: true,
      channel: 'email',
      email: 'twice@inbox.cis-mailtest.ng',
    });
    await submitJourney(pool, id, { portalUrl: PORTAL });
    await submitJourney(pool, id, { portalUrl: PORTAL }).catch(() => undefined);
    expect(await outbox()).toHaveLength(1);
  });
});

describe('Firm seats — S1, S2, S3', () => {
  async function firmWithSeats() {
    const org = await activeFirm('seat-firm', 'Harbour Securities');
    await getSeats(pool, editionId, org.id);
    await createLeadCoordinator(pool, {
      organizationId: org.id,
      name: 'Tolu Lead',
      email: 'tolu.lead@harbour.cis-mailtest.ng',
    });
    return org;
  }

  async function submitSeat(orgId: string, seatCode: 'S1' | 'S2' | 'S3', email: string) {
    const seat = await assignSeat(pool, {
      editionId,
      organizationId: orgId,
      seatCode,
      assignedName: `${seatCode} Holder`,
      assignedEmail: email,
    });
    const { respondentId } = await startSeatEntry(pool, seat.linkToken);
    await answerAll(pool, respondentId, await getInstrumentItems(pool, seatCode), []);
    await submitJourney(pool, respondentId, { portalUrl: PORTAL });
    return respondentId;
  }

  it('confirms to the seat holder and tells the lead coordinator "N of 3 surveys complete"', async () => {
    const org = await firmWithSeats();
    const first = await submitSeat(org.id, 'S1', 's1@harbour.cis-mailtest.ng');
    let rows = await outbox();
    expect(rows).toHaveLength(2);
    const mine = rows.find((r) => r.kind === SUBMISSION_CONFIRMATION_EMAIL_KIND)!;
    const coord = rows.find((r) => r.kind === FIRM_SEAT_PROGRESS_EMAIL_KIND)!;
    expect(mine).toMatchObject({ ref_id: first, to_address: 's1@harbour.cis-mailtest.ng' });
    // F-08, to the seat holder with the coordinator copied.
    expect(mine.subject).toBe('Received: S1 MD or Chief Executive survey for Harbour Securities');
    expect(mine.body_text).toContain('Dear S1 Holder,');
    expect(coord).toMatchObject({ ref_id: first, to_address: 'tolu.lead@harbour.cis-mailtest.ng' });
    expect(coord.subject).toBe(mine.subject);
    expect(coord.body_text).toContain('Firm progress: 1 of 3 surveys complete');
    // Only the coordinator's copy lists what is still to come.
    expect(coord.body_text).toContain('Still to come: Compliance (S2), Operations (S3).');
    expect(mine.body_text).not.toContain('Still to come');
    await expectNoAnswers(first, mine);
    await expectNoAnswers(first, coord);
    // The seat is marked complete with the submission itself.
    expect((await getSeat(pool, editionId, org.id, 'S1'))!.state).toBe('complete');

    const second = await submitSeat(org.id, 'S2', 's2@harbour.cis-mailtest.ng');
    rows = await outbox();
    expect(rows).toHaveLength(4);
    const coord2 = rows.find(
      (r) => r.kind === FIRM_SEAT_PROGRESS_EMAIL_KIND && r.ref_id === second,
    )!;
    expect(coord2.subject).toBe('Received: S2 Compliance survey for Harbour Securities');
    expect(coord2.body_text).toContain('2 of 3 surveys complete');

    // A repeated submit queues nothing extra.
    await submitJourney(pool, second, { portalUrl: PORTAL }).catch(() => undefined);
    expect(await outbox()).toHaveLength(4);

    await submitSeat(org.id, 'S3', 's3@harbour.cis-mailtest.ng');
    const last = (await outbox()).filter((r) => r.kind === FIRM_SEAT_PROGRESS_EMAIL_KIND).pop()!;
    expect(last.body_text).toContain('3 of 3 surveys complete');
    expect(last.body_text).toContain('There is nothing more you need to do.');
  });

  it('a coordinator answering a seat themselves gets one email, with the progress in it', async () => {
    const org = await firmWithSeats();
    await submitSeat(org.id, 'S1', 'Tolu.Lead@harbour.cis-mailtest.ng');
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe(SUBMISSION_CONFIRMATION_EMAIL_KIND);
    expect(rows[0]!.body_text).toContain('1 of 3 surveys complete');
  });
});

describe('Market institutions — I-*', () => {
  const CONTACT = {
    who: 'Amaka Eze',
    role: 'Head, Market Operations',
    email: 'a.eze@institution.cis-mailtest.ng',
    phone: '+234 803 555 0101',
    how: 'Introduced through the CIS courtesy approach',
  };

  async function openLink(name: string, family: 'A' | 'B') {
    const ids = Object.fromEntries((await listInstitutions(pool)).map((i) => [i.name, i.id]));
    await saveContact(pool, editionId, ids[name]!, family, CONTACT);
    const view = await issueSurveyLink(pool, editionId, ids[name]!, family, {
      targetBy: '2026-11-15',
    });
    const resume = (await getResumeByToken(pool, view.surveyLink!.split('/').pop()!))!;
    return { respondentId: resume.respondent.id, items: resume.items };
  }

  it('thanks the contact and explains the passage approval before release', async () => {
    const { respondentId, items } = await openLink('Securities and Exchange Commission', 'A');
    await answerAll(pool, respondentId, items, []);
    await submitJourney(pool, respondentId, { portalUrl: PORTAL });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: SUBMISSION_CONFIRMATION_EMAIL_KIND,
      ref_id: respondentId,
      to_address: CONTACT.email,
    });
    expect(rows[0]!.subject).toContain('Securities and Exchange Commission');
    expect(rows[0]!.body_text).toContain('passage attributed to');
    expect(rows[0]!.body_text).toContain('for approval');
    await expectNoAnswers(respondentId, rows[0]!);

    await submitJourney(pool, respondentId, { portalUrl: PORTAL }).catch(() => undefined);
    expect(await outbox()).toHaveLength(1);
  });

  it('Q0 closed: still thanked, never "declined", and no passage promised', async () => {
    const { respondentId, items } = await openLink('Lagos Commodities and Futures Exchange', 'B');
    const gate = items.find((i: SurveyItem) => i.scopeGate)!;
    await saveDraftAnswer(pool, respondentId, {
      questionId: gate.id,
      ratedFirmId: null,
      answer: { a: 'Rare' },
    });
    await submitJourney(pool, respondentId, { portalUrl: PORTAL });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    const body = `${rows[0]!.subject}\n${rows[0]!.body_text}\n${rows[0]!.body_html}`;
    expect(body).toContain('Thank you');
    expect(body.toLowerCase()).not.toContain('declin');
    expect(body.toLowerCase()).not.toContain('passage');
    expect(body.toLowerCase()).not.toContain('approval');
  });
});
