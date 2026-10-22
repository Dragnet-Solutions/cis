/**
 * D-03 — reminders send automatically. The hourly scheduler and the "Send
 * reminders now" button both call `runReminderPass`; these tests drive it with
 * an injected clock (`asOf`) instead of waiting.
 *  - A response idle for 2 days gets exactly one reminder email, however many
 *    times the pass runs; at 7 days a second one, now with the STOP link
 *    (DEC-012: never on the first).
 *  - Completed, opted-out (STOP) and withdrawn respondents get none; the
 *    3-days-before-close step fires; the cap holds; a person overdue for
 *    every step gets them a day apart, not all at once.
 *  - Only collecting (open) editions, and nothing after the close date.
 *  - One pass at a time across pods (advisory lock), and the ledger's unique
 *    (edition, response, step) keeps concurrent runs from double-sending.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createRespondent,
  setRespondentContact,
  markRespondentSubmitted,
  markRespondentWithdrawn,
  optOutReminders,
  upsertDraft,
  listReminderSends,
} from '@cis/db';
import {
  seedReferenceData,
  runReminderPass,
  runEditionReminders,
  setReminderSchedule,
  setReminderCap,
  REMINDER_PASS_LOCK_KEY,
  RESPONDENT_REMINDER_EMAIL_KIND,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

const PORTAL = 'https://cis.example';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let pool: Pool;
let editionId: string;
let now: Date;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  editionId = (await seedReferenceData(pool)).editionId;
  now = new Date();
  // Collecting, closing well after every relative step.
  await pool.query(`UPDATE editions SET status = 'open', survey_close_at = $2 WHERE id = $1`, [
    editionId,
    new Date(now.getTime() + 30 * DAY),
  ]);
  await setReminderSchedule(pool, {
    steps: [
      { step: 1, kind: 'relative', days: 2, enabled: true },
      { step: 2, kind: 'relative', days: 7, enabled: true },
      { step: 3, kind: 'before_close', beforeCloseDays: 3, enabled: true },
    ],
  });
  await setReminderCap(pool, 3);
});
afterAll(async () => {
  await closeTestPool();
});

let tokenSeq = 0;

/** An S4 investor who answered one question `idleMs` before `now`. */
async function idleInvestor(
  idleMs: number,
  opts: { email?: string; channel?: 'email' | 'text' | 'both' } = {},
): Promise<string> {
  const r = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
  tokenSeq++;
  const channel = opts.channel ?? 'email';
  await setRespondentContact(pool, r.id, {
    channel,
    ...(channel === 'text' ? { phone: '+2348000000000' } : {}),
    ...(channel !== 'text' ? { email: opts.email ?? `p${tokenSeq}@x.example` } : {}),
    recoveryToken: `00000000-0000-4000-8000-${String(tokenSeq).padStart(12, '0')}`,
  });
  await upsertDraft(pool, {
    respondentId: r.id,
    questionId: 'S4-Q1',
    scope: 'shared',
    ratedFirmId: null,
    answer: { a: '5' },
  });
  await pool.query(`UPDATE respondent_drafts SET updated_at = $2 WHERE respondent_id = $1`, [
    r.id,
    new Date(now.getTime() - idleMs),
  ]);
  return r.id;
}

/** Every respondent-reminder email in the outbox, oldest first. */
async function reminderEmails(): Promise<{ to: string; body: string }[]> {
  const res = await pool.query<{ to_address: string; body_text: string }>(
    `SELECT to_address, body_text FROM email_outbox WHERE kind = $1 ORDER BY created_at`,
    [RESPONDENT_REMINDER_EMAIL_KIND],
  );
  return res.rows.map((r) => ({ to: r.to_address, body: r.body_text }));
}

const tick = (asOf: Date) => runReminderPass(pool, { asOf, portalUrl: PORTAL });

describe('A response idle for 2 days gets exactly one reminder, with nobody pressing anything', () => {
  it('sends one email at 2 days + 1 hour, however many times the pass runs', async () => {
    await idleInvestor(2 * DAY + HOUR, { email: 'idle@x.example' });

    const first = await tick(now);
    const second = await tick(now);
    expect(first.ran).toBe(true);
    expect(first.editions[0]).toMatchObject({ editionId, collecting: true, emailed: 1 });
    expect(second.editions[0]).toMatchObject({ emailed: 0, notDue: 1 });

    const emails = await reminderEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toBe('idle@x.example');
    expect(emails[0]!.body).toContain(`${PORTAL}/survey?resume=`);
    // DEC-012: no STOP on a first reminder.
    expect(emails[0]!.body).not.toContain('/survey?stop=');
  });

  it('is not yet due at 1 day 23 hours', async () => {
    await idleInvestor(2 * DAY - HOUR);
    const res = await tick(now);
    expect(res.editions[0]).toMatchObject({ emailed: 0, notDue: 1 });
    expect(await reminderEmails()).toHaveLength(0);
  });

  it('sends the second reminder at 7 days, now with the STOP link — once', async () => {
    const id = await idleInvestor(2 * DAY + HOUR);
    await tick(now); // step 1
    // Five days later the same response has been idle 7 days + 1 hour.
    const later = new Date(now.getTime() + 5 * DAY);
    await tick(later);
    await tick(later);

    const emails = await reminderEmails();
    expect(emails).toHaveLength(2);
    expect(emails[1]!.body).toContain(`${PORTAL}/survey?stop=`);
    const sends = await listReminderSends(pool, editionId);
    expect(sends.map((s) => [s.responseId, s.step, s.carriesStop])).toEqual([
      [id, 1, false],
      [id, 2, true],
    ]);
  });

  it('never reminds a completed, opted-out (STOP) or withdrawn respondent', async () => {
    const done = await idleInvestor(3 * DAY);
    await markRespondentSubmitted(pool, done);
    const stopped = await idleInvestor(3 * DAY);
    await optOutReminders(pool, stopped);
    const gone = await idleInvestor(3 * DAY);
    await markRespondentWithdrawn(pool, gone);

    const res = await tick(now);
    expect(res.editions[0]!.sends).toHaveLength(0);
    expect(await reminderEmails()).toHaveLength(0);
  });

  it('stops after a respondent submits between two reminders', async () => {
    const id = await idleInvestor(2 * DAY + HOUR);
    await tick(now);
    await markRespondentSubmitted(pool, id);
    await tick(new Date(now.getTime() + 5 * DAY));
    expect(await reminderEmails()).toHaveLength(1);
  });

  it('sends the closing reminder 3 days before close, once', async () => {
    // Close in 2 days: close − 3 days is already past. Idle only 1 hour, so
    // neither relative step is due — the closing step is this person's first.
    await pool.query(`UPDATE editions SET survey_close_at = $2 WHERE id = $1`, [
      editionId,
      new Date(now.getTime() + 2 * DAY),
    ]);
    await idleInvestor(HOUR);
    await tick(now);
    await tick(now);
    const sends = await listReminderSends(pool, editionId);
    expect(sends.map((s) => [s.step, s.carriesStop])).toEqual([[3, false]]);
    expect(await reminderEmails()).toHaveLength(1);
  });

  it('respects the cap', async () => {
    await setReminderCap(pool, 1);
    await idleInvestor(2 * DAY + HOUR);
    await tick(now);
    await tick(new Date(now.getTime() + 5 * DAY)); // step 2 due, but capped
    await tick(new Date(now.getTime() + 28 * DAY)); // closing step due, but capped
    expect(await reminderEmails()).toHaveLength(1);
  });

  it('spaces out the steps for someone overdue for all of them', async () => {
    await idleInvestor(20 * DAY); // overdue for steps 1 and 2 at once
    await tick(now);
    await tick(new Date(now.getTime() + HOUR)); // too soon for the next
    expect(await reminderEmails()).toHaveLength(1);
    await tick(new Date(now.getTime() + DAY + HOUR));
    expect(await reminderEmails()).toHaveLength(2);
  });

  it('records a reminder for a text-only respondent without emailing (no text service)', async () => {
    await idleInvestor(2 * DAY + HOUR, { channel: 'text' });
    const res = await tick(now);
    expect(res.editions[0]).toMatchObject({ emailed: 0, skipped: { notEmail: 1 } });
    expect(res.editions[0]!.sends).toHaveLength(1);
    expect(await reminderEmails()).toHaveLength(0);
  });

  it('runs only for collecting editions, and not after the close date', async () => {
    await idleInvestor(2 * DAY + HOUR);
    await pool.query(`UPDATE editions SET status = 'locked' WHERE id = $1`, [editionId]);
    const locked = await tick(now);
    expect(locked.editions).toHaveLength(0);
    const named = await runReminderPass(pool, {
      asOf: now,
      portalUrl: PORTAL,
      editionIds: [editionId],
    });
    expect(named.editions[0]).toMatchObject({ collecting: false, emailed: 0 });

    await pool.query(`UPDATE editions SET status = 'open', survey_close_at = $2 WHERE id = $1`, [
      editionId,
      new Date(now.getTime() - HOUR),
    ]);
    const closed = await tick(now);
    expect(closed.editions[0]).toMatchObject({ collecting: false, emailed: 0 });
    expect(await reminderEmails()).toHaveLength(0);
  });
});

describe('One pass at a time, and never a double send', () => {
  it('a pass does nothing while another holds the advisory lock', async () => {
    await idleInvestor(2 * DAY + HOUR);
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [REMINDER_PASS_LOCK_KEY]);
      const blocked = await tick(now);
      expect(blocked).toEqual({ ran: false, editions: [] });
      expect(await reminderEmails()).toHaveLength(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [REMINDER_PASS_LOCK_KEY]);
      holder.release();
    }
    expect((await tick(now)).ran).toBe(true);
    expect(await reminderEmails()).toHaveLength(1);
  });

  it('two concurrent passes send each reminder once', async () => {
    for (let i = 0; i < 5; i++) await idleInvestor(2 * DAY + HOUR);
    const results = await Promise.all([tick(now), tick(now)]);
    // At least one ran; the other either found the lock held or found nothing due.
    expect(results.some((r) => r.ran)).toBe(true);
    expect(await reminderEmails()).toHaveLength(5);
    expect(await listReminderSends(pool, editionId)).toHaveLength(5);
  });

  it('the ledger alone stops a double send when runs bypass the lock', async () => {
    for (let i = 0; i < 4; i++) await idleInvestor(2 * DAY + HOUR);
    const runs = await Promise.all(
      Array.from({ length: 3 }, () =>
        runEditionReminders(pool, editionId, now, { portalUrl: PORTAL }),
      ),
    );
    expect(runs.reduce((n, r) => n + r.emailed, 0)).toBe(4);
    expect(await reminderEmails()).toHaveLength(4);
    expect(await listReminderSends(pool, editionId)).toHaveLength(4);
  });
});
