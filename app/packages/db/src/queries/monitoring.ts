import { Pool } from 'pg';
import { query } from '../client';

/**
 * Monitoring reads for UX-OPS-003 / UX-OPS-004.
 *
 * A per-response `last_activity_at` is derived, never stored: it is the latest
 * autosave (`respondent_drafts.updated_at`) for an unfinished response. The
 * "last answered question" is that same latest draft's `question_id`. Reachable
 * = the participant gave a contact detail (PAT-011) — the exact predicate Phase 9
 * uses for participant audience counts.
 */

export interface InProgressResponse {
  responseId: string;
  instrumentCode: string;
  reachable: boolean;
  lastActivityAt: Date;
  lastQuestionId: string;
}

/**
 * Every STARTED-but-not-completed response for an edition, with its derived
 * last-activity clock, last-answered question, and reachability. "Started" means
 * it has at least one autosaved answer and has not been submitted.
 */
export async function getInProgressResponses(
  pool: Pool,
  editionId: string,
): Promise<InProgressResponse[]> {
  const res = await query<{
    response_id: string;
    instrument_code: string;
    reachable: boolean;
    last_activity_at: Date;
    last_question_id: string;
  }>(
    pool,
    `SELECT r.id AS response_id,
            r.instrument_code,
            (r.contact_channel IS NOT NULL AND r.contact_channel <> 'none'
              AND (r.contact_email IS NOT NULL OR r.contact_phone IS NOT NULL)) AS reachable,
            d.last_activity_at,
            d.last_question_id
       FROM respondents r
       JOIN LATERAL (
         SELECT MAX(updated_at) AS last_activity_at,
                (SELECT question_id FROM respondent_drafts d2
                   WHERE d2.respondent_id = r.id
                   ORDER BY updated_at DESC, question_id ASC
                   LIMIT 1) AS last_question_id
           FROM respondent_drafts d
          WHERE d.respondent_id = r.id
       ) d ON TRUE
      WHERE r.edition_id = $1
        AND r.submitted_at IS NULL
        AND r.reminders_opted_out = FALSE
        AND d.last_activity_at IS NOT NULL`,
    [editionId],
  );
  return res.rows.map((x) => ({
    responseId: x.response_id,
    instrumentCode: x.instrument_code,
    reachable: x.reachable,
    lastActivityAt: x.last_activity_at,
    lastQuestionId: x.last_question_id,
  }));
}

// ─── reminder_send ledger ──────────────────────────────────────────────────────

export interface ReminderSend {
  id: string;
  editionId: string;
  responseId: string;
  step: number;
  scheduledFor: Date;
  carriesStop: boolean;
  createdAt: Date;
}

interface RawReminderRow {
  id: string;
  edition_id: string;
  response_id: string;
  step: number;
  scheduled_for: Date;
  carries_stop: boolean;
  created_at: Date;
}

function mapReminder(r: RawReminderRow): ReminderSend {
  return {
    id: r.id,
    editionId: r.edition_id,
    responseId: r.response_id,
    step: r.step,
    scheduledFor: r.scheduled_for,
    carriesStop: r.carries_stop,
    createdAt: r.created_at,
  };
}

export async function recordReminderSend(
  pool: Pool,
  data: {
    editionId: string;
    responseId: string;
    step: number;
    scheduledFor: Date;
    carriesStop: boolean;
  },
): Promise<ReminderSend> {
  const res = await query<RawReminderRow>(
    pool,
    `INSERT INTO reminder_send (edition_id, response_id, step, scheduled_for, carries_stop)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [data.editionId, data.responseId, data.step, data.scheduledFor, data.carriesStop],
  );
  const row = res.rows[0];
  if (!row) throw new Error('reminder_send insert returned no rows');
  return mapReminder(row);
}

/** Steps already sent to a response (for cap + first-vs-subsequent STOP flag). */
export async function listReminderSteps(
  pool: Pool,
  editionId: string,
  responseId: string,
): Promise<number[]> {
  const res = await query<{ step: number }>(
    pool,
    `SELECT step FROM reminder_send WHERE edition_id = $1 AND response_id = $2 ORDER BY step`,
    [editionId, responseId],
  );
  return res.rows.map((r) => r.step);
}

export async function listReminderSends(pool: Pool, editionId: string): Promise<ReminderSend[]> {
  const res = await query<RawReminderRow>(
    pool,
    `SELECT * FROM reminder_send WHERE edition_id = $1 ORDER BY created_at, step`,
    [editionId],
  );
  return res.rows.map(mapReminder);
}

// ─── Opt-out (UX-RET-007) ─────────────────────────────────────────────────────

/** Set reminders_opted_out = true for a respondent. Never touches consent or
 *  participation-status fields — a stopped respondent remains fully eligible. */
export async function optOutReminders(pool: Pool, respondentId: string): Promise<void> {
  await query(pool, `UPDATE respondents SET reminders_opted_out = TRUE WHERE id = $1`, [
    respondentId,
  ]);
}

export async function isReminderOptedOut(pool: Pool, respondentId: string): Promise<boolean> {
  const res = await query<{ reminders_opted_out: boolean }>(
    pool,
    `SELECT reminders_opted_out FROM respondents WHERE id = $1`,
    [respondentId],
  );
  return res.rows[0]?.reminders_opted_out ?? false;
}

// ─── Progress for dynamic wording ─────────────────────────────────────────────

export interface RespondentProgress {
  answered: number;
  total: number;
}

/** Count of draft answers for a respondent vs total items for their instrument. */
export async function getRespondentProgress(
  pool: Pool,
  respondentId: string,
): Promise<RespondentProgress> {
  const res = await query<{ answered: number; total: number }>(
    pool,
    `SELECT
       (SELECT COUNT(DISTINCT question_id) FROM respondent_drafts WHERE respondent_id = $1)::int AS answered,
       (SELECT COUNT(*) FROM instrument_questions iq
          JOIN instrument_definitions idef ON idef.id = iq.instrument_definition_id
          JOIN respondents r ON r.instrument_code = idef.code
         WHERE r.id = $1)::int AS total`,
    [respondentId],
  );
  const row = res.rows[0];
  return { answered: row?.answered ?? 0, total: row?.total ?? 0 };
}
