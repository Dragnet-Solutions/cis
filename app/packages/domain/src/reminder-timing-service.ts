import { Pool } from 'pg';
import {
  getConfig,
  setConfig,
  getEditionById,
  getRespondentById,
  getInProgressResponses,
  recordReminderSendOnce,
  listReminderHistory,
  listCollectingEditionIds,
  lockRespondentForReminder,
  withTransaction,
  getPublicVisibleQuestions,
  listDrgOpsQuestionSummary,
  INSTRUMENT_META,
  type InProgressResponse,
  type ReminderSend,
  getRespondentProgress,
} from '@cis/db';
import { isInvestorInstrument } from './funnel-service';
import { DomainError } from './errors';
import {
  assembleReminderEmail,
  computeProgressWording,
  getReminderContent,
  ReminderContentError,
} from './reminder-content-service';
import { queueTemplate, type TemplateNotice } from './email-content';
import { fmtDate } from './email-fields';
import { stopRemindersLink, surveyResumeLink, textParagraphs } from './notice-links';

/** Outbox kind of a respondent reminder email; ref_id is the reminder_send row. */
export const RESPONDENT_REMINDER_EMAIL_KIND = 'respondent-reminder';

/**
 * UX-OPS-004 — Reminder timing and frequency. This surface owns WHEN a reminder
 * is sent and HOW OFTEN; UX-RET-007 owns WHAT it says. So this engine schedules
 * sends and NEVER touches response state or message content.
 *
 * Deliberate rules (from the artefact):
 *  - RELATIVE timing: a reminder fires at `last_activity_at + N days` (counted
 *    from when someone STOPPED), never against a shared calendar date. The final
 *    step is timed against the edition CLOSE (`closes − N days`), a LIVE reference
 *    that moves if the close date moves.
 *  - STOP language: the FIRST scheduled reminder in the cadence carries no STOP;
 *    every reminder after it does (DEC-012, "Declined: allowing STOP on the first
 *    inactivity reminder" — reaffirmed 2026-08-20 estate reconciliation). STOP on
 *    a first message asks someone to decide about future messages before they
 *    know whether any will come; the cost is asymmetric — a second message
 *    carrying STOP is a small annoyance, a first message carrying STOP
 *    permanently removes people who would have completed. This is DISTINCT from
 *    the separate one-time initial link delivery (Phase 3/9), which was never
 *    part of this engine's cadence and never carries STOP either way.
 *  - A configurable CAP bounds total reminders; the schedule and cap are governed
 *    config (`reminders.schedule` / `reminders.cap`), editable during fieldwork.
 *  - INVESTOR-SIDE ONLY (retail/local/foreign). Firm-side seat-holders (S1/S2/S3)
 *    are reached through the firm (UX-OPS-002), not this engine — see README.
 *  - Reachable only: a reminder reaches only those who gave a contact detail; the
 *    unreachable cohort is a real ceiling, surfaced as a number, never hidden.
 *  - Nothing already completed is reminded (recovery is UX-RET-006's).
 */

export class ReminderTimingError extends DomainError {
  constructor(message: string, code = 'REMINDER_TIMING') {
    super(message, code);
  }
}

export interface ReminderStepConfig {
  step: number;
  kind: 'relative' | 'before_close';
  /** For a relative step: days after the person stopped. */
  days?: number;
  /** For a before_close step: days before the edition close date. */
  beforeCloseDays?: number;
  enabled: boolean;
}
export interface ReminderSchedule {
  steps: ReminderStepConfig[];
}

const DEFAULT_SCHEDULE: ReminderSchedule = {
  steps: [
    { step: 1, kind: 'relative', days: 2, enabled: true },
    { step: 2, kind: 'relative', days: 7, enabled: true },
    { step: 3, kind: 'before_close', beforeCloseDays: 3, enabled: true },
  ],
};
const DEFAULT_CAP = 3;
const DAY_MS = 86_400_000;
/** The least time between two reminders to the same person. */
export const REMINDER_MIN_GAP_MS = DAY_MS;

// ─── Governed config accessors ─────────────────────────────────────────────────

export async function getReminderSchedule(pool: Pool): Promise<ReminderSchedule> {
  return (await getConfig<ReminderSchedule>(pool, 'reminders.schedule')) ?? DEFAULT_SCHEDULE;
}
export async function setReminderSchedule(pool: Pool, schedule: ReminderSchedule): Promise<void> {
  await setConfig(pool, 'reminders.schedule', schedule);
}
export async function getReminderCap(pool: Pool): Promise<number> {
  return (await getConfig<number>(pool, 'reminders.cap')) ?? DEFAULT_CAP;
}
export async function setReminderCap(pool: Pool, cap: number): Promise<void> {
  if (!Number.isInteger(cap) || cap < 0) {
    throw new ReminderTimingError('The reminder cap must be a non-negative integer', 'INVALID_CAP');
  }
  await setConfig(pool, 'reminders.cap', cap);
}

// ─── Pure timing ────────────────────────────────────────────────────────────────

/** When a configured step fires for a given response. `before_close` steps are a
 *  LIVE reference to the close date — pass the CURRENT close date each run so a
 *  moved close date moves the trigger (never snapshot it). Null when a
 *  before_close step has no close date to reference. */
export function triggerTimeFor(
  step: ReminderStepConfig,
  lastActivityAt: Date,
  closeAt: Date | null,
): Date | null {
  if (step.kind === 'relative') {
    return new Date(lastActivityAt.getTime() + (step.days ?? 0) * DAY_MS);
  }
  if (!closeAt) return null;
  return new Date(closeAt.getTime() - (step.beforeCloseDays ?? 0) * DAY_MS);
}

export interface DueReminder {
  step: number;
  scheduledFor: Date;
  carriesStop: boolean;
}

/**
 * The single reminder (if any) due for one response at `asOf`: the earliest
 * enabled, not-yet-sent step whose trigger time has passed, provided the cap is
 * not reached. Pure — no DB, no clock.
 *
 * STOP flag (DEC-012): the FIRST reminder this respondent ever receives from
 * this cadence carries no STOP — `sentSteps` is empty. Every reminder after it
 * does. This is deliberately based on "has this respondent received any
 * reminder yet," not on the literal step NUMBER, so it stays correct even if
 * step 1 is disabled and step 2 fires first for someone.
 */
export function nextDueReminder(params: {
  schedule: ReminderSchedule;
  cap: number;
  sentSteps: number[];
  /** When this respondent's latest reminder was sent, if any. */
  lastSentAt?: Date | null;
  lastActivityAt: Date;
  closeAt: Date | null;
  asOf: Date;
}): DueReminder | null {
  if (params.sentSteps.length >= params.cap) return null;
  // Never two reminders to one person within REMINDER_MIN_GAP_MS — e.g. a
  // response idle for weeks when reminders first switch on is overdue for
  // every step; it gets them a day apart, not an hour apart.
  if (
    params.lastSentAt &&
    params.asOf.getTime() - params.lastSentAt.getTime() < REMINDER_MIN_GAP_MS
  ) {
    return null;
  }
  const sent = new Set(params.sentSteps);
  const steps = params.schedule.steps.filter((s) => s.enabled).sort((a, b) => a.step - b.step);
  for (const s of steps) {
    if (sent.has(s.step)) continue;
    const trigger = triggerTimeFor(s, params.lastActivityAt, params.closeAt);
    if (trigger && params.asOf.getTime() >= trigger.getTime()) {
      return {
        step: s.step,
        scheduledFor: trigger,
        // DEC-012: no STOP on this respondent's first reminder.
        carriesStop: params.sentSteps.length > 0,
      };
    }
  }
  return null;
}

// ─── Eligibility ────────────────────────────────────────────────────────────────

/** Investor-side, in-progress, reachable responses — the only reminder cohort.
 *  Firm-side seat responses (S1/S2/S3), regulators (chased from the Regulators
 *  screen, never by the investor schedule) and unreachable participants are
 *  excluded. */
function eligibleInvestorResponses(rows: InProgressResponse[]): InProgressResponse[] {
  return rows.filter((r) => isInvestorInstrument(r.instrumentCode) && r.reachable);
}

// ─── The scheduling run (persists sends; never touches response state) ──────────

/** Why a due reminder was not emailed in a run. */
export type ReminderSkipReason =
  /** Chose text messages only, or left no email address — recorded in the
   *  ledger as sent (the schedule moved on) but there is no text service. */
  | 'notEmail'
  /** No live reminder wording is published — nothing recorded, so the person
   *  is reminded once wording goes live. */
  | 'noWording'
  /** Another run (another pod, or a second click) already recorded this step. */
  | 'alreadySent'
  /** Submitted, stopped reminders or was withdrawn between the read and the send. */
  | 'noLongerEligible';

export interface ReminderRunSummary {
  editionId: string;
  /** False when the edition is not collecting (not open, or past its close
   *  date) — nothing is sent. */
  collecting: boolean;
  /** Ledger rows recorded by this run. */
  sends: ReminderSend[];
  /** Reminder emails queued by this run. */
  emailed: number;
  skipped: Record<ReminderSkipReason, number>;
  /** Reachable unfinished people with nothing due yet (or capped). */
  notDue: number;
}

const emptySkips = (): Record<ReminderSkipReason, number> => ({
  notEmail: 0,
  noWording: 0,
  alreadySent: 0,
  noLongerEligible: 0,
});

/**
 * Compute and record the reminders due at `asOf` for one edition, returning
 * the ledger rows written. See `runEditionReminders` for the full contract.
 */
export async function scheduleDueReminders(
  pool: Pool,
  editionId: string,
  asOf: Date = new Date(),
  opts: { portalUrl?: string } = {},
): Promise<ReminderSend[]> {
  return (await runEditionReminders(pool, editionId, asOf, opts)).sends;
}

/**
 * Compute and record the reminders due at `asOf`. One reminder per response per
 * run, recorded in the append-only `reminder_send` ledger with its STOP flag.
 * Firm-side, regulator, unreachable, opted-out and already-completed responses
 * never appear (completed responses are excluded at the query — an answered
 * survey is never reminded). Nothing is sent once the close date has passed.
 *
 * Idempotent: each send is its own transaction that re-checks the respondent
 * under a row lock, inserts the ledger row ON CONFLICT DO NOTHING against
 * UNIQUE (edition_id, response_id, step) and queues the email in the same
 * transaction — so running twice, or on two pods at once, never sends a step
 * twice. With `portalUrl` the reminder is emailed to a respondent who chose
 * email; without it (tests, legacy callers) only the ledger is written.
 */
export async function runEditionReminders(
  pool: Pool,
  editionId: string,
  asOf: Date = new Date(),
  opts: { portalUrl?: string } = {},
): Promise<ReminderRunSummary> {
  const summary: ReminderRunSummary = {
    editionId,
    collecting: true,
    sends: [],
    emailed: 0,
    skipped: emptySkips(),
    notDue: 0,
  };
  const edition = await getEditionById(pool, editionId);
  const closeAt = edition?.surveyCloseAt ?? null; // LIVE reference each run
  if (!edition || (closeAt && asOf.getTime() >= closeAt.getTime())) {
    summary.collecting = false;
    return summary;
  }
  const schedule = await getReminderSchedule(pool);
  const cap = await getReminderCap(pool);
  const rows = await getInProgressResponses(pool, editionId);

  for (const r of eligibleInvestorResponses(rows)) {
    const dueFor = (history: { step: number; createdAt: Date }[]) =>
      nextDueReminder({
        schedule,
        cap,
        sentSteps: history.map((h) => h.step),
        lastSentAt: history.at(-1)?.createdAt ?? null,
        lastActivityAt: r.lastActivityAt,
        closeAt,
        asOf,
      });
    const due = dueFor(await listReminderHistory(pool, editionId, r.responseId));
    if (!due) {
      summary.notDue++;
      continue;
    }

    // The email (if this person can get one) is assembled before the
    // transaction; with no live wording nothing is recorded, so the step is
    // not used up by a reminder nobody received.
    let email: Omit<TemplateNotice, 'refId'> | null = null;
    if (opts.portalUrl) {
      const prepared = await prepareReminderEmail(
        pool,
        r.responseId,
        due.carriesStop,
        opts.portalUrl,
        { label: edition.label, closeAt },
      );
      if (prepared === 'noWording') {
        summary.skipped.noWording++;
        continue;
      }
      email = prepared;
    }

    const outcome = await withTransaction(pool, async (client) => {
      const now = await lockRespondentForReminder(client, r.responseId);
      if (!now || now.submitted || now.optedOut || now.withdrawn) return 'noLongerEligible';
      // Re-read under the lock: a concurrent run may have sent a step since.
      const again = dueFor(await listReminderHistory(client, editionId, r.responseId));
      if (!again || again.step !== due.step || again.carriesStop !== due.carriesStop) {
        return 'alreadySent';
      }
      const send = await recordReminderSendOnce(client, {
        editionId,
        responseId: r.responseId,
        step: due.step,
        scheduledFor: due.scheduledFor,
        carriesStop: due.carriesStop,
      });
      if (!send) return 'alreadySent';
      if (email) await queueTemplate(client, { ...email, refId: send.id });
      return send;
    });

    if (typeof outcome === 'string') {
      summary.skipped[outcome]++;
      continue;
    }
    summary.sends.push(outcome);
    if (email) summary.emailed++;
    else if (opts.portalUrl) summary.skipped.notEmail++;
  }
  return summary;
}

/**
 * The reminder email for one respondent who chose email (or email and text):
 * the managed reminder wording, a link back into their survey and — after
 * their first reminder (DEC-012) — a link to stop reminders. Null for a
 * text-only respondent or one with no email (there is no text-message
 * service); 'noWording' when no live reminder wording is published. The
 * `refId` is filled in with the ledger row's id inside the send transaction.
 */
/** The managed first-message wording (Wording page), or null when none is live. */
async function firstMessageBody(pool: Pool): Promise<string | null> {
  try {
    const parsed = JSON.parse(await getReminderContent(pool, 'first_message_email')) as {
      body?: unknown;
    };
    return typeof parsed.body === 'string' && parsed.body.trim() ? parsed.body : null;
  } catch (err) {
    if (err instanceof ReminderContentError || err instanceof SyntaxError) return null;
    throw err;
  }
}

async function prepareReminderEmail(
  pool: Pool,
  respondentId: string,
  carriesStop: boolean,
  portalUrl: string,
  edition: { label: string; closeAt: Date | null },
): Promise<Omit<TemplateNotice, 'refId'> | null | 'noWording'> {
  const respondent = await getRespondentById(pool, respondentId);
  if (!respondent?.contactEmail?.trim() || !respondent.recoveryToken) return null;
  if (respondent.contactChannel !== 'email' && respondent.contactChannel !== 'both') return null;
  // The live reminder content must exist (UX-RET-007): without it nothing is sent.
  let reminder: Awaited<ReturnType<typeof assembleReminderEmail>>;
  try {
    reminder = await assembleReminderEmail(pool, respondent.id, carriesStop);
  } catch (err) {
    if (err instanceof ReminderContentError) return 'noWording';
    throw err;
  }
  const recoveryUrl = surveyResumeLink(portalUrl, respondent.recoveryToken);
  // DEC-012: the first reminder (P-02) has no stop option; every later one
  // (P-03) carries it, with the respondent's progress and the close date. The
  // managed wording (Wording page) is the body when it is live; else the
  // design's approved wording stands.
  if (!carriesStop) {
    const body = await firstMessageBody(pool);
    return {
      kind: RESPONDENT_REMINDER_EMAIL_KIND,
      to: respondent.contactEmail.trim(),
      template: 'P-02',
      fields: {
        recovery_url: recoveryUrl,
        body: body ? textParagraphs(body) : null,
        edition: edition.label,
      },
    };
  }
  const progress = await getRespondentProgress(pool, respondent.id);
  return {
    kind: RESPONDENT_REMINDER_EMAIL_KIND,
    to: respondent.contactEmail.trim(),
    template: 'P-03',
    fields: {
      recovery_url: recoveryUrl,
      stop_url: stopRemindersLink(portalUrl, respondent.recoveryToken),
      progress_wording: computeProgressWording(progress.answered, progress.total),
      close_date: fmtDate(edition.closeAt),
      body: reminder.body.trim() ? textParagraphs(reminder.body) : null,
      edition: edition.label,
    },
  };
}

// ─── The scheduled pass (every collecting edition, one pod at a time) ───────────

/** Postgres advisory-lock key for the reminder pass: only one API pod (or one
 *  manual run) computes reminders at a time. An arbitrary constant, unique in
 *  this codebase (node-pg-migrate uses its own key for migrations). */
export const REMINDER_PASS_LOCK_KEY = 704_115_003;

export interface ReminderPassResult {
  /** False when another pod or run held the lock — this pass did nothing. */
  ran: boolean;
  editions: ReminderRunSummary[];
}

/**
 * One reminder pass — what the hourly scheduler and the "Send reminders now"
 * button both call. Takes a session-level `pg_try_advisory_lock` on a
 * dedicated connection so that, across several API pods, only one pass runs
 * at a time (a pass that finds the lock held returns `ran: false` at once).
 * Without `editionIds` it covers every collecting (status 'open') edition; a
 * named edition that is not open is reported `collecting: false` and skipped.
 * The ledger's unique constraint still guarantees no step is sent twice even
 * if the lock were bypassed.
 */
export async function runReminderPass(
  pool: Pool,
  opts: { asOf?: Date; portalUrl?: string; editionIds?: string[] } = {},
): Promise<ReminderPassResult> {
  const asOf = opts.asOf ?? new Date();
  const lockClient = await pool.connect();
  let locked = false;
  let releaseErr: Error | undefined;
  try {
    const res = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [REMINDER_PASS_LOCK_KEY],
    );
    locked = res.rows[0]?.locked === true;
    if (!locked) return { ran: false, editions: [] };

    const open = new Set(await listCollectingEditionIds(pool));
    const ids = opts.editionIds ?? [...open];
    const editions: ReminderRunSummary[] = [];
    for (const id of ids) {
      if (!open.has(id)) {
        editions.push({
          editionId: id,
          collecting: false,
          sends: [],
          emailed: 0,
          skipped: emptySkips(),
          notDue: 0,
        });
        continue;
      }
      editions.push(
        await runEditionReminders(pool, id, asOf, {
          ...(opts.portalUrl ? { portalUrl: opts.portalUrl } : {}),
        }),
      );
    }
    return { ran: true, editions };
  } finally {
    if (locked) {
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [REMINDER_PASS_LOCK_KEY]);
      } catch (err) {
        // Destroy the connection rather than return it to the pool still
        // holding the lock; closing the session releases it.
        releaseErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    lockClient.release(releaseErr);
  }
}

// ─── Reachable / unreachable cohort (a real ceiling, stated as a number) ────────

export interface UnfinishedStats {
  unfinished: number;
  reachable: number;
  /** A real ceiling on what any reminder schedule can recover — never hidden. */
  unreachable: number;
}

export async function getUnfinishedStats(pool: Pool, editionId: string): Promise<UnfinishedStats> {
  const rows = await getInProgressResponses(pool, editionId);
  const investor = rows.filter((r) => isInvestorInstrument(r.instrumentCode));
  const reachable = investor.filter((r) => r.reachable).length;
  return {
    unfinished: investor.length,
    reachable,
    unreachable: investor.length - reachable,
  };
}

// ─── Drop-off histogram (by last answered question, not an aggregate rate) ──────

export interface DropoffBucket {
  questionId: string;
  /** What an operator reads for the question: its wording, or — for a Dragnet
   *  operational question, whose wording is never shown outside Dragnet — a
   *  plain description. Never the raw question code. */
  label: string;
  /** The survey the question belongs to, when known. */
  surveyName: string | null;
  count: number;
  /** The single largest cluster — a question doing damage. */
  peak: boolean;
}

/** Operator-readable labels for question codes. Public wording comes only from
 *  the sanctioned `getPublicVisibleQuestions`; Dragnet operational questions
 *  get a description, not their wording. */
async function questionLabels(
  pool: Pool,
): Promise<Map<string, { label: string; surveyName: string | null }>> {
  const [visible, drgOps] = await Promise.all([
    getPublicVisibleQuestions(pool),
    listDrgOpsQuestionSummary(pool),
  ]);
  const out = new Map<string, { label: string; surveyName: string | null }>();
  for (const q of visible) out.set(q.questionCode, { label: q.promptText, surveyName: null });
  for (const q of drgOps) {
    out.set(q.questionCode, {
      label: 'A Dragnet operational question (wording shown to Dragnet only)',
      surveyName: q.instrumentName,
    });
  }
  return out;
}

export async function getDropoffHistogram(pool: Pool, editionId: string): Promise<DropoffBucket[]> {
  const rows = await getInProgressResponses(pool, editionId);
  const investor = rows.filter((r) => isInvestorInstrument(r.instrumentCode));
  const counts = new Map<string, number>();
  const instrumentOf = new Map<string, string>();
  for (const r of investor) {
    counts.set(r.lastQuestionId, (counts.get(r.lastQuestionId) ?? 0) + 1);
    instrumentOf.set(r.lastQuestionId, r.instrumentCode);
  }
  const labels = await questionLabels(pool);
  const surveyNames = new Map(INSTRUMENT_META.map((m) => [m.code, m.name]));
  const max = Math.max(0, ...counts.values());
  return Array.from(counts.entries())
    .map(([questionId, count]) => {
      const known = labels.get(questionId);
      const surveyName =
        known?.surveyName ?? surveyNames.get(instrumentOf.get(questionId) ?? '') ?? null;
      return {
        questionId,
        label: known?.label ?? 'A question no longer in the survey',
        surveyName,
        count,
        peak: count === max && max > 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.questionId.localeCompare(b.questionId));
}
