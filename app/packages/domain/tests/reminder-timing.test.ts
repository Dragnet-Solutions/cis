/**
 * UX-OPS-004 Reminder timing — Phase 13 DoD, STOP-flag rule reverted to
 * original per Phase 21 / DEC-012.
 *  - Relative timing: fires at last_activity_at + N days, independent of calendar.
 *  - STOP flag: the respondent's FIRST scheduled reminder carries no STOP; every
 *    one after it does (DEC-012, reaffirmed 2026-08-20 estate reconciliation).
 *    Phase 17 previously "corrected" this to STOP-on-every-reminder based on a
 *    misreading of the artefact — that was the defect, not this rule.
 *  - Configurable cap bounds total reminders.
 *  - Closing-week reminder is a LIVE reference to the edition close date.
 *  - Unreachable participants excluded and counted; firm-side seat responses
 *    excluded; completed responses never reminded.
 *  - Drop-off histogram by last answered question.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createRespondent,
  setRespondentContact,
  markRespondentSubmitted,
  upsertDraft,
  listReminderSends,
} from '@cis/db';
import {
  seedReferenceData,
  nextDueReminder,
  triggerTimeFor,
  scheduleDueReminders,
  getUnfinishedStats,
  getDropoffHistogram,
  setReminderSchedule,
  setReminderCap,
  type ReminderSchedule,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

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

const DAY = 86_400_000;
const SCHEDULE: ReminderSchedule = {
  steps: [
    { step: 1, kind: 'relative', days: 2, enabled: true },
    { step: 2, kind: 'relative', days: 7, enabled: true },
    { step: 3, kind: 'before_close', beforeCloseDays: 3, enabled: true },
  ],
};

// ─── Pure timing ────────────────────────────────────────────────────────────

describe('Relative timing, STOP flag, cap (pure)', () => {
  const last = new Date('2026-06-01T00:00:00Z');

  it('fires each step at last_activity_at + N days, not before', () => {
    const base = {
      schedule: SCHEDULE,
      cap: 3,
      sentSteps: [] as number[],
      lastActivityAt: last,
      closeAt: null,
    };
    expect(nextDueReminder({ ...base, asOf: new Date(last.getTime() + 1 * DAY) })).toBeNull();
    const due = nextDueReminder({ ...base, asOf: new Date(last.getTime() + 2 * DAY) });
    expect(due?.step).toBe(1);
    // DEC-012: a respondent's first-ever reminder from this cadence carries no
    // STOP. STOP on a first message asks someone to decide about future
    // messages before they know whether any will come.
    expect(due?.carriesStop).toBe(false);
  });

  it('carries STOP on the second reminder onward, not the first', () => {
    const due = nextDueReminder({
      schedule: SCHEDULE,
      cap: 3,
      sentSteps: [1],
      lastActivityAt: last,
      closeAt: null,
      asOf: new Date(last.getTime() + 8 * DAY),
    });
    expect(due?.step).toBe(2);
    // DEC-012: the asymmetry is deliberate — a second message carrying STOP is
    // a small annoyance; a first message carrying STOP permanently removes
    // people who would have completed.
    expect(due?.carriesStop).toBe(true);
  });

  it('never exceeds the cap', () => {
    const due = nextDueReminder({
      schedule: SCHEDULE,
      cap: 3,
      sentSteps: [1, 2, 3],
      lastActivityAt: last,
      closeAt: new Date('2026-07-01T00:00:00Z'),
      asOf: new Date('2026-08-01T00:00:00Z'),
    });
    expect(due).toBeNull();
  });

  it('skips a disabled step', () => {
    const sched: ReminderSchedule = {
      steps: [
        { step: 1, kind: 'relative', days: 2, enabled: true },
        { step: 2, kind: 'relative', days: 7, enabled: false },
      ],
    };
    const due = nextDueReminder({
      schedule: sched,
      cap: 3,
      sentSteps: [1],
      lastActivityAt: last,
      closeAt: null,
      asOf: new Date(last.getTime() + 30 * DAY),
    });
    expect(due).toBeNull(); // step 1 sent, step 2 disabled → nothing due
  });

  it('the closing-week step is a LIVE reference to the close date', () => {
    const step = { step: 3, kind: 'before_close' as const, beforeCloseDays: 3, enabled: true };
    const closeA = new Date('2026-07-10T00:00:00Z');
    const closeB = new Date('2026-07-20T00:00:00Z');
    expect(triggerTimeFor(step, last, closeA)!.toISOString()).toBe('2026-07-07T00:00:00.000Z');
    expect(triggerTimeFor(step, last, closeB)!.toISOString()).toBe('2026-07-17T00:00:00.000Z');
    expect(triggerTimeFor(step, last, null)).toBeNull();
  });
});

// ─── Integration: eligibility & the send ledger ──────────────────────────────

async function investor(email: string | null, lastQuestion = 'S4-Q6'): Promise<string> {
  const r = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
  if (email) await setRespondentContact(pool, r.id, { channel: 'email', email });
  await upsertDraft(pool, {
    respondentId: r.id,
    questionId: lastQuestion,
    scope: 'shared',
    ratedFirmId: null,
    answer: { a: '5' },
  });
  return r.id;
}

describe('Eligibility — investor-side, reachable, not completed', () => {
  it('reminds a reachable investor and excludes firm-side, unreachable and completed', async () => {
    await setReminderSchedule(pool, SCHEDULE);
    await setReminderCap(pool, 3);

    const reachable = await investor('a@x.example');
    await investor(null); // unreachable — no contact
    // Firm-side seat response (S1) with a draft + contact — must never be reminded.
    const firmResp = await createRespondent(pool, { editionId, instrumentCode: 'S1' });
    await setRespondentContact(pool, firmResp.id, { channel: 'email', email: 'firm@x.example' });
    await upsertDraft(pool, {
      respondentId: firmResp.id,
      questionId: 'S1-Q3',
      scope: 'shared',
      ratedFirmId: null,
      answer: { a: '5' },
    });
    // Completed investor — submitted, so never reminded.
    const doneResp = await investor('done@x.example');
    await markRespondentSubmitted(pool, doneResp);

    const asOf = new Date(Date.now() + 3 * DAY); // past the 2-day step
    const sent = await scheduleDueReminders(pool, editionId, asOf);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.responseId).toBe(reachable);
    expect(sent[0]!.step).toBe(1);
    // DEC-012: this respondent's first reminder — no STOP.
    expect(sent[0]!.carriesStop).toBe(false);
  });
});

describe('Sequence — STOP from the second reminder onward, cap enforced across runs', () => {
  it('the first send carries no STOP, the second does, and the cap holds', async () => {
    // Two relative steps, cap 2.
    await setReminderSchedule(pool, {
      steps: [
        { step: 1, kind: 'relative', days: 2, enabled: true },
        { step: 2, kind: 'relative', days: 7, enabled: true },
      ],
    });
    await setReminderCap(pool, 2);
    await investor('b@x.example');

    await scheduleDueReminders(pool, editionId, new Date(Date.now() + 3 * DAY)); // step 1
    await scheduleDueReminders(pool, editionId, new Date(Date.now() + 8 * DAY)); // step 2
    await scheduleDueReminders(pool, editionId, new Date(Date.now() + 30 * DAY)); // capped

    const all = await listReminderSends(pool, editionId);
    expect(all).toHaveLength(2); // cap 2 — no third send
    const s1 = all.find((s) => s.step === 1)!;
    const s2 = all.find((s) => s.step === 2)!;
    // DEC-012: first reminder no STOP, every one after it does.
    expect(s1.carriesStop).toBe(false);
    expect(s2.carriesStop).toBe(true);
  });
});

describe('Live close-date reference (§C6)', () => {
  it('moving the edition close date moves the closing-week reminder without re-saving the schedule', async () => {
    await setReminderSchedule(pool, {
      steps: [{ step: 3, kind: 'before_close', beforeCloseDays: 3, enabled: true }],
    });
    await setReminderCap(pool, 3);
    const now = Date.now();

    // Close in 2 days → trigger = close − 3 days = yesterday → due now.
    await pool.query(`UPDATE editions SET status='open', survey_close_at=$2 WHERE id=$1`, [
      editionId,
      new Date(now + 2 * DAY),
    ]);
    await investor('c@x.example');
    const near = await scheduleDueReminders(pool, editionId, new Date(now));
    expect(near).toHaveLength(1);

    // A fresh participant; move the close far out → trigger in the future → not due.
    await investor('d@x.example');
    await pool.query(`UPDATE editions SET survey_close_at=$2 WHERE id=$1`, [
      editionId,
      new Date(now + 10 * DAY),
    ]);
    const far = await scheduleDueReminders(pool, editionId, new Date(now));
    // No NEW send for the fresh participant (their step 3 now triggers in +7 days).
    expect(far).toHaveLength(0);
  });
});

describe('Unreachable cohort and drop-off histogram', () => {
  it('counts the unreachable ceiling and clusters drop-off by last question', async () => {
    await investor('e@x.example', 'S4-Q6');
    await investor('f@x.example', 'S4-Q6');
    await investor('g@x.example', 'S4-Q6');
    await investor('h@x.example', 'S4-Q1');
    await investor(null, 'S4-Q6'); // unreachable

    const stats = await getUnfinishedStats(pool, editionId);
    expect(stats.unfinished).toBe(5);
    expect(stats.reachable).toBe(4);
    expect(stats.unreachable).toBe(1); // a real ceiling, surfaced not hidden

    const hist = await getDropoffHistogram(pool, editionId);
    const peak = hist.find((b) => b.peak)!;
    expect(peak.questionId).toBe('S4-Q6');
    expect(peak.count).toBe(4);
    expect(hist.find((b) => b.questionId === 'S4-Q1')!.count).toBe(1);
  });
});
