import type { getPool } from '@cis/db';
import { writeAudit } from '@cis/audit';
import { runReminderPass, type ReminderPassResult } from '@cis/domain';
import { kickMailDispatcher } from '../mail/dispatcher';
import { publicOrigin } from '../public-url';

/**
 * Sends due respondent reminders automatically (D-03): every
 * REMINDER_SCHEDULE_INTERVAL_MS (default one hour) and once shortly after
 * startup (REMINDER_SCHEDULE_FIRST_RUN_MS, default 60s) so a restart never
 * delays reminders by a full interval. Each pass covers every collecting
 * edition; a Postgres advisory lock inside `runReminderPass` means only one
 * API pod runs a pass at a time, and the reminder ledger's unique
 * (edition, response, step) means no step is ever sent twice.
 * REMINDER_SCHEDULE=off disables it.
 */

type Pool = ReturnType<typeof getPool>;

export interface SchedulerLog {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

const DEFAULT_INTERVAL_MS = 3_600_000;
const DEFAULT_FIRST_RUN_MS = 60_000;

/** One scheduled pass: run, log what was sent, and kick the mail dispatcher. */
export async function reminderTick(
  pool: Pool,
  log: SchedulerLog,
  asOf: Date = new Date(),
): Promise<ReminderPassResult> {
  const result = await runReminderPass(pool, { asOf, portalUrl: publicOrigin() });
  if (!result.ran) {
    log.info({}, 'Reminder pass skipped: another instance holds the lock');
    return result;
  }
  const emailed = result.editions.reduce((n, e) => n + e.emailed, 0);
  if (emailed > 0) kickMailDispatcher();
  // Audited like a manual run ('reminders.run_manual'), with no actor: the
  // system sent it. Only a pass that sent something leaves an entry, so the
  // hourly pass does not fill the log with empty runs.
  for (const e of result.editions) {
    if (e.sends.length === 0) continue;
    await writeAudit(pool, {
      actorId: null,
      actionType: 'reminders.run_scheduled',
      entityType: 'edition',
      entityId: e.editionId,
      editionId: e.editionId,
      newValue: {
        collecting: e.collecting,
        emailed: e.emailed,
        recorded: e.sends.length,
        notDue: e.notDue,
        skipped: e.skipped,
      },
    });
  }
  const recorded = result.editions.reduce((n, e) => n + e.sends.length, 0);
  if (recorded > 0 || result.editions.some((e) => Object.values(e.skipped).some((v) => v > 0))) {
    log.info(
      {
        editions: result.editions.map((e) => ({
          editionId: e.editionId,
          emailed: e.emailed,
          recorded: e.sends.length,
          skipped: e.skipped,
        })),
      },
      'Reminder pass',
    );
  }
  return result;
}

export function startReminderScheduler(
  pool: Pool,
  log: SchedulerLog,
  opts: { intervalMs?: number; firstRunMs?: number } = {},
): () => void {
  if (process.env['REMINDER_SCHEDULE'] === 'off') {
    log.info({}, 'Reminder scheduler disabled (REMINDER_SCHEDULE=off)');
    return () => {};
  }
  const intervalMs =
    opts.intervalMs ??
    (Number(process.env['REMINDER_SCHEDULE_INTERVAL_MS']) || DEFAULT_INTERVAL_MS);
  const firstRunMs =
    opts.firstRunMs ??
    (Number(process.env['REMINDER_SCHEDULE_FIRST_RUN_MS']) || DEFAULT_FIRST_RUN_MS);

  let inFlight = false;
  let stopped = false;

  const run = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        await reminderTick(pool, log);
      } catch (err) {
        log.error({ err }, 'Reminder pass failed');
      } finally {
        inFlight = false;
      }
    })();
  };

  const first = setTimeout(run, firstRunMs);
  first.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  log.info({ intervalMs, firstRunMs }, 'Reminder scheduler started');

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
