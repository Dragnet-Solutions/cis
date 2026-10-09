/**
 * UX-RET-007 v2.3 — Phase 17 DoD tests.
 *
 * Seven gates:
 *  1. STOP-language verification (DEC-012, Phase 21 revert): a respondent's
 *     FIRST scheduled reminder carries no STOP; every one after it does. The
 *     separate initial link delivery is not in this cadence and never carries
 *     STOP either way. (Phase 17 wrongly put STOP on every reminder including
 *     the first, believing Phase 13's original exemption was a bug — it was
 *     not; DEC-012 reaffirms the original rule.)
 *  2. SMS-length: reminder body + representative URL ≤ 160 chars.
 *  3. Progress-wording: two respondents at different positions get different phrasing.
 *  4. Channel-inheritance: reminder delivery channel matches UX-RET-001 preference.
 *  5. Non-withdrawal: STOP sets reminders_opted_out without altering consent or
 *     participation-status fields; a stopped respondent can still complete.
 *  6. Already-submitted: a token tap after completion returns 'already_submitted'.
 *  7. Unreachable-cohort regression: opted-out participants excluded from sends.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createRespondent,
  setRespondentContact,
  upsertDraft,
  markRespondentSubmitted,
  optOutReminders,
  isReminderOptedOut,
  getRespondentProgress,
  getRespondentByRecoveryToken,
  getLiveContent,
} from '@cis/db';
import {
  seedReferenceData,
  computeProgressWording,
  scheduleDueReminders,
  setReminderSchedule,
  setReminderCap,
  nextDueReminder,
  assembleReminderText,
  assembleReminderEmail,
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

async function investor(
  email: string | null,
  answeredCount = 3,
): Promise<{ respondentId: string }> {
  const r = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
  if (email) await setRespondentContact(pool, r.id, { channel: 'email', email });
  for (let i = 0; i < answeredCount; i++) {
    await upsertDraft(pool, {
      respondentId: r.id,
      questionId: `S4-Q${i + 1}`,
      scope: 'shared',
      ratedFirmId: null,
      answer: { a: '5' },
    });
  }
  return { respondentId: r.id };
}

// ─── Gate 1: STOP-language verification ─────────────────────────────────────

describe('Gate 1 — STOP-language (DEC-012, Phase 21 revert)', () => {
  it('carries STOP once a respondent has already received a reminder, never on their first', () => {
    const last = new Date('2026-06-01T00:00:00Z');
    const closeAt = new Date('2026-07-01T00:00:00Z');
    for (const sentSteps of [[], [1], [1, 2]]) {
      const due = nextDueReminder({
        schedule: SCHEDULE,
        cap: 3,
        sentSteps,
        lastActivityAt: last,
        closeAt,
        asOf: new Date('2026-07-01T00:00:00Z'),
      });
      if (due !== null) {
        expect(due.carriesStop).toBe(sentSteps.length > 0);
      }
    }
  });

  it('step 1 (a respondent’s first scheduled reminder) carries NO STOP — DEC-012', () => {
    const last = new Date('2026-06-01T00:00:00Z');
    const due = nextDueReminder({
      schedule: SCHEDULE,
      cap: 3,
      sentSteps: [],
      lastActivityAt: last,
      closeAt: null,
      asOf: new Date(last.getTime() + 3 * DAY),
    });
    expect(due?.step).toBe(1);
    expect(due?.carriesStop).toBe(false);
  });

  it('the assembled SMS body actually omits/includes the STOP line, not just the flag', async () => {
    // Real, rendered-output check — the flag alone proves nothing if the
    // template still hardcodes the sentence regardless of it.
    const { respondentId } = await investor('stop-line@x.example');
    const noStop = await assembleReminderText(pool, respondentId, '/r/tok1', false);
    const withStop = await assembleReminderText(pool, respondentId, '/r/tok1', true);
    expect(noStop).not.toContain('STOP');
    expect(withStop).toContain('Reply STOP to stop reminders.');
  });

  it('the assembled email carries no stop link text on a first reminder, and the live wording on later ones', async () => {
    const { respondentId } = await investor('stop-email@x.example');
    const noStop = await assembleReminderEmail(pool, respondentId, false);
    const withStop = await assembleReminderEmail(pool, respondentId, true);
    expect(noStop.stopLinkText).toBeNull();
    expect(withStop.stopLinkText).toBe('Stop these reminders');
  });
});

// ─── Gate 2: SMS-length ───────────────────────────────────────────────────────

describe('Gate 2 — SMS length ≤ 160 chars', () => {
  const SMS_MAX = 160;
  const URL_BUDGET = 70;

  function measureSms(body: string): number {
    const withUrl = body.replace('{{recovery_url}}', 'x'.repeat(URL_BUDGET));
    return withUrl.replace(/\{\{[^}]+\}\}/g, '').length;
  }

  it('first_message_text seed fits in one segment', async () => {
    const live = await getLiveContent(pool, 'reminder_content', 'first_message_text');
    expect(live).not.toBeNull();
    const len = measureSms(live!.version.body);
    expect(len).toBeLessThanOrEqual(SMS_MAX);
  });

  it('reminder_text seed fits in one segment (worst case: {{stop_line}} unexpanded)', async () => {
    const live = await getLiveContent(pool, 'reminder_content', 'reminder_text');
    expect(live).not.toBeNull();
    const len = measureSms(live!.version.body);
    expect(len).toBeLessThanOrEqual(SMS_MAX);
  });

  it('the ASSEMBLED reminder_text fits in one segment with the real STOP line filled in', async () => {
    // The raw-seed check above strips {{stop_line}} to nothing, same as every
    // other placeholder — it never measures what actually gets sent once
    // assembleReminderText fills it in. Check the real worst case directly.
    const { respondentId } = await investor('sms-len@x.example', 0);
    const withStop = await assembleReminderText(pool, respondentId, 'x'.repeat(URL_BUDGET), true);
    expect(withStop.length).toBeLessThanOrEqual(SMS_MAX);
  });

  it('a body that would exceed 160 chars is detectable by the length check', () => {
    // This verifies the gate function's contract — bodies over the limit are caught.
    const longBody =
      'This is a very long SMS body that will definitely exceed the character limit when combined with a recovery URL that is placed at the end of the message body for the reminder. {{recovery_url}}';
    expect(measureSms(longBody)).toBeGreaterThan(SMS_MAX);
  });
});

// ─── Gate 3: Progress wording ─────────────────────────────────────────────────

describe('Gate 3 — Progress wording computed, not fixed', () => {
  it('two respondents at different positions get different phrasing', async () => {
    const { respondentId: r1 } = await investor('a@x.example', 2); // ~15% of 13 items
    const { respondentId: r2 } = await investor('b@x.example', 7); // ~54% of 13 items

    const p1 = await getRespondentProgress(pool, r1);
    const p2 = await getRespondentProgress(pool, r2);

    const w1 = computeProgressWording(p1.answered, p1.total);
    const w2 = computeProgressWording(p2.answered, p2.total);

    expect(w1).not.toBe(w2);
    expect(w1.length).toBeGreaterThan(0);
    expect(w2.length).toBeGreaterThan(0);
  });

  it('answered count matches actual drafts', async () => {
    const { respondentId } = await investor('c@x.example', 5);
    const progress = await getRespondentProgress(pool, respondentId);
    expect(progress.answered).toBe(5);
    expect(progress.total).toBeGreaterThan(0);
  });
});

// ─── Gate 4: Channel inheritance ─────────────────────────────────────────────

describe('Gate 4 — Channel inherited from UX-RET-001, no override', () => {
  it('respondent contact_channel matches the preference set at consent time', async () => {
    const r = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    const token = 'test-channel-token-' + r.id;
    const updated = await setRespondentContact(pool, r.id, {
      channel: 'text',
      phone: '+2348000000001',
      recoveryToken: token,
    });
    expect(updated.contactChannel).toBe('text');
    // The channel is what was stored at consent time — never a reminder-time override.
    const fetched = await getRespondentByRecoveryToken(pool, token);
    expect(fetched?.contactChannel).toBe('text');
  });
});

// ─── Gate 5: Non-withdrawal ───────────────────────────────────────────────────

describe('Gate 5 — STOP ≠ withdrawal', () => {
  it('optOutReminders sets reminders_opted_out without touching consent or submitted_at', async () => {
    const r = await createRespondent(pool, {
      editionId,
      instrumentCode: 'S4',
      consentAccepted: true,
    });
    await setRespondentContact(pool, r.id, { channel: 'email', email: 'd@x.example' });

    expect(await isReminderOptedOut(pool, r.id)).toBe(false);
    await optOutReminders(pool, r.id);
    expect(await isReminderOptedOut(pool, r.id)).toBe(true);

    // consent_accepted and submitted_at must be unchanged
    const res = await pool.query(
      'SELECT consent_accepted, submitted_at FROM respondents WHERE id = $1',
      [r.id],
    );
    const row = res.rows[0];
    expect(row.consent_accepted).toBe(true);
    expect(row.submitted_at).toBeNull();
  });

  it('an opted-out respondent can still be submitted (not withdrawn)', async () => {
    const r = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    await setRespondentContact(pool, r.id, { channel: 'email', email: 'e@x.example' });
    await optOutReminders(pool, r.id);

    // Submission must still succeed
    await markRespondentSubmitted(pool, r.id);
    const res = await pool.query('SELECT submitted_at FROM respondents WHERE id = $1', [r.id]);
    expect(res.rows[0].submitted_at).not.toBeNull();
  });

  it('opted-out respondents are excluded from future reminder sends', async () => {
    await setReminderSchedule(pool, SCHEDULE);
    await setReminderCap(pool, 3);

    const { respondentId } = await investor('f@x.example', 3);
    await optOutReminders(pool, respondentId);

    const asOf = new Date(Date.now() + 3 * DAY);
    const sent = await scheduleDueReminders(pool, editionId, asOf);
    expect(sent).toHaveLength(0); // opted-out respondent excluded
  });
});

// ─── Gate 6: Already-submitted ───────────────────────────────────────────────

describe('Gate 6 — Already-submitted detection', () => {
  it('a submitted respondent is detectable by their recovery token', async () => {
    const r = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    const token = 'test-submitted-token-' + r.id;
    await setRespondentContact(pool, r.id, {
      channel: 'email',
      email: 'g@x.example',
      recoveryToken: token,
    });
    await upsertDraft(pool, {
      respondentId: r.id,
      questionId: 'S4-Q1',
      scope: 'shared',
      ratedFirmId: null,
      answer: { a: '5' },
    });
    await markRespondentSubmitted(pool, r.id);

    const fetched = await getRespondentByRecoveryToken(pool, token);
    expect(fetched).not.toBeNull();
    expect(fetched!.submittedAt).not.toBeNull();
  });
});

// ─── Gate 7: Unreachable-cohort regression ────────────────────────────────────

describe('Gate 7 — Unreachable cohort excluded from sends', () => {
  it('participants without contact details receive no reminder', async () => {
    await setReminderSchedule(pool, SCHEDULE);
    await setReminderCap(pool, 3);

    await investor(null, 3); // unreachable — no contact

    const asOf = new Date(Date.now() + 3 * DAY);
    const sent = await scheduleDueReminders(pool, editionId, asOf);
    expect(sent).toHaveLength(0);
  });

  it('opted-out and unreachable are both excluded while reachable active is reminded', async () => {
    await setReminderSchedule(pool, SCHEDULE);
    await setReminderCap(pool, 3);

    const { respondentId: reachable } = await investor('h@x.example', 3);
    const { respondentId: optedOut } = await investor('i@x.example', 3);
    await optOutReminders(pool, optedOut);
    await investor(null, 3); // unreachable

    const asOf = new Date(Date.now() + 3 * DAY);
    const sent = await scheduleDueReminders(pool, editionId, asOf);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.responseId).toBe(reachable);
  });
});
