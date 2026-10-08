import { Pool } from 'pg';
import {
  getConfig,
  setConfig,
  getEditionById,
  getInProgressResponses,
  listReminderSteps,
  recordReminderSend,
  type InProgressResponse,
  type ReminderSend,
} from '@cis/db';
import { segmentForInstrument } from './funnel-service';
import { DomainError } from './errors';

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
  lastActivityAt: Date;
  closeAt: Date | null;
  asOf: Date;
}): DueReminder | null {
  if (params.sentSteps.length >= params.cap) return null;
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
 *  Firm-side seat responses (S1/S2/S3) and unreachable participants are excluded. */
function eligibleInvestorResponses(rows: InProgressResponse[]): InProgressResponse[] {
  return rows.filter((r) => segmentForInstrument(r.instrumentCode) !== 'firm' && r.reachable);
}

// ─── The scheduling run (persists sends; never touches response state) ──────────

/**
 * Compute and record the reminders due at `asOf`. One reminder per response per
 * run, recorded in the append-only `reminder_send` ledger with its STOP flag.
 * Firm-side, unreachable and already-completed responses never appear (completed
 * responses are excluded at the query — an answered survey is never reminded).
 */
export async function scheduleDueReminders(
  pool: Pool,
  editionId: string,
  asOf: Date = new Date(),
): Promise<ReminderSend[]> {
  const schedule = await getReminderSchedule(pool);
  const cap = await getReminderCap(pool);
  const edition = await getEditionById(pool, editionId);
  const closeAt = edition?.surveyCloseAt ?? null; // LIVE reference each run
  const rows = await getInProgressResponses(pool, editionId);

  const sent: ReminderSend[] = [];
  for (const r of eligibleInvestorResponses(rows)) {
    const sentSteps = await listReminderSteps(pool, editionId, r.responseId);
    const due = nextDueReminder({
      schedule,
      cap,
      sentSteps,
      lastActivityAt: r.lastActivityAt,
      closeAt,
      asOf,
    });
    if (!due) continue;
    sent.push(
      await recordReminderSend(pool, {
        editionId,
        responseId: r.responseId,
        step: due.step,
        scheduledFor: due.scheduledFor,
        carriesStop: due.carriesStop,
      }),
    );
  }
  return sent;
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
  const investor = rows.filter((r) => segmentForInstrument(r.instrumentCode) !== 'firm');
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
  count: number;
  /** The single largest cluster — a question doing damage. */
  peak: boolean;
}

export async function getDropoffHistogram(pool: Pool, editionId: string): Promise<DropoffBucket[]> {
  const rows = await getInProgressResponses(pool, editionId);
  const investor = rows.filter((r) => segmentForInstrument(r.instrumentCode) !== 'firm');
  const counts = new Map<string, number>();
  for (const r of investor) counts.set(r.lastQuestionId, (counts.get(r.lastQuestionId) ?? 0) + 1);
  const max = Math.max(0, ...counts.values());
  return Array.from(counts.entries())
    .map(([questionId, count]) => ({ questionId, count, peak: count === max && max > 0 }))
    .sort((a, b) => b.count - a.count || a.questionId.localeCompare(b.questionId));
}
