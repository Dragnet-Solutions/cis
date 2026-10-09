/**
 * UX-RET-007 v2.3 — Reminder & Recovery Message Content (Phase 17).
 *
 * This service owns WHAT a reminder says. UX-OPS-004 (Phase 13) owns WHEN it fires.
 *
 * Invariants:
 *  - STOP (DEC-012): the FIRST scheduled reminder in the cadence carries no STOP;
 *    every reminder after it does. Reaffirmed by the 2026-08-20 estate
 *    reconciliation after a prior "correction" put STOP on every scheduled
 *    reminder — that was itself the defect, not the fix; see
 *    reminder-timing-service.ts's `nextDueReminder` for the flag this reads.
 *    Separately, the one-time initial link delivery (Phase 3/9) is not in the
 *    reminder cadence at all and never carries STOP either way.
 *  - Progress wording is computed from the respondent's actual answered-item count,
 *    never from fixed copy.
 *  - Channel is inherited from Phase 3's UX-RET-001 selection; never re-chosen here.
 *  - Stopping reminders sets reminders_opted_out without altering consent or
 *    participation status. No WhatsApp variants (DEC-010).
 */

import { Pool } from 'pg';
import {
  getLiveContent,
  optOutReminders,
  getRespondentProgress,
  type RespondentProgress,
} from '@cis/db';
import { DomainError } from './errors';

export class ReminderContentError extends DomainError {
  constructor(message: string, code = 'REMINDER_CONTENT') {
    super(message, code);
  }
}

export type ReminderSubKey =
  | 'first_message_email'
  | 'first_message_text'
  | 'reminder_email'
  | 'reminder_text'
  | 'reminders_stopped'
  | 'already_submitted'
  | 'link_tapped';

export { type RespondentProgress };

/**
 * Compute progress wording from the respondent's actual answered-item count.
 * Returns a human phrase like "about halfway through" or "around five minutes left".
 */
export function computeProgressWording(answered: number, total: number): string {
  if (total <= 0) return '';
  const ratio = answered / total;
  if (ratio <= 0) return '';
  if (ratio < 0.25) return 'You have just started — most of the survey is still ahead.';
  if (ratio < 0.45) return 'You are about a quarter of the way through — around ten minutes left.';
  if (ratio < 0.6) return 'You are about halfway through — around five minutes left.';
  if (ratio < 0.8) return 'You are more than halfway — just a few minutes to go.';
  return 'You are nearly done — just a couple of questions left.';
}

/** Read the live body for a reminder_content sub-key from the managed-content store. */
export async function getReminderContent(pool: Pool, subKey: ReminderSubKey): Promise<string> {
  const live = await getLiveContent(pool, 'reminder_content', subKey);
  if (!live) {
    throw new ReminderContentError(
      `No live content for reminder_content/${subKey}`,
      'CONTENT_NOT_FOUND',
    );
  }
  return live.version.body;
}

/**
 * Mark a respondent as no longer wanting reminders.
 * Does NOT touch consent_accepted, submitted_at, or any other participation field.
 * The respondent remains fully eligible to return and complete their response.
 */
export async function stopReminders(pool: Pool, respondentId: string): Promise<void> {
  await optOutReminders(pool, respondentId);
}

/** The literal STOP instruction appended to a reminder SMS — never present on a
 *  respondent's first reminder (DEC-012). Kept as one constant so the wording
 *  used in the assembled message and in tests that check for it never drift. */
const SMS_STOP_LINE = '\nReply STOP to stop reminders.';

/**
 * Assemble a reminder text body with dynamic progress wording, recovery URL,
 * and STOP language. `carriesStop` (from `nextDueReminder`/the `reminder_send`
 * ledger row) is DEC-012's flag: false for a respondent's first reminder, true
 * for every one after it. The template carries a `{{stop_line}}` placeholder
 * rather than hardcoding the STOP sentence, so this function — not the
 * managed-content body — is what decides whether it appears.
 */
export async function assembleReminderText(
  pool: Pool,
  respondentId: string,
  recoveryUrl: string,
  carriesStop: boolean,
): Promise<string> {
  const [template, progress] = await Promise.all([
    getReminderContent(pool, 'reminder_text'),
    getRespondentProgress(pool, respondentId),
  ]);
  const wording = computeProgressWording(progress.answered, progress.total);
  return template
    .replace('{{progress_wording}}', wording ? wording + ' ' : '')
    .replace('{{recovery_url}}', recoveryUrl)
    .replace('{{stop_line}}', carriesStop ? SMS_STOP_LINE : '');
}

/**
 * Assemble the reminder email content, with the same DEC-012 STOP-flag rule as
 * `assembleReminderText`. Returns the parsed template with `stopLinkText` set
 * to `null` when this reminder is a respondent's first — no STOP element for
 * the caller to render — and the live template's wording otherwise.
 */
export async function assembleReminderEmail(
  pool: Pool,
  respondentId: string,
  carriesStop: boolean,
): Promise<{ subject: string; body: string; cta: string; stopLinkText: string | null }> {
  const [raw, progress] = await Promise.all([
    getReminderContent(pool, 'reminder_email'),
    getRespondentProgress(pool, respondentId),
  ]);
  const parsed = JSON.parse(raw) as {
    subject: string;
    body: string;
    cta: string;
    stop_link_text: string;
  };
  const wording = computeProgressWording(progress.answered, progress.total);
  return {
    subject: parsed.subject,
    body: parsed.body.replace('{{progress_wording}}', wording),
    cta: parsed.cta,
    stopLinkText: carriesStop ? parsed.stop_link_text : null,
  };
}

/** Assemble the first-message text body (no STOP, no progress). */
export async function assembleFirstMessageText(pool: Pool, recoveryUrl: string): Promise<string> {
  const template = await getReminderContent(pool, 'first_message_text');
  return template.replace('{{recovery_url}}', recoveryUrl);
}
