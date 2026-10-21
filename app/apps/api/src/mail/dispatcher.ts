import type { getPool } from '@cis/db';
import { deliverDueEmails, type MailLog } from './mailer';

/**
 * Sends the email outbox in the background: every MAIL_DISPATCH_INTERVAL_MS
 * (default 15s), and soon after a route queues a notice (kickMailDispatcher).
 * One pass at a time per process; several pods are safe because notices are
 * leased (claimDueEmails). MAIL_DISPATCH=off disables it.
 */

type Pool = ReturnType<typeof getPool>;

const KICK_DELAY_MS = 250;

let runOnce: (() => void) | null = null;
let kickTimer: NodeJS.Timeout | null = null;

export function startMailDispatcher(
  pool: Pool,
  log: MailLog & { error?: (obj: object, msg: string) => void },
  opts: { intervalMs?: number } = {},
): () => void {
  if (process.env['MAIL_DISPATCH'] === 'off') {
    log.info({}, 'Mail dispatcher disabled (MAIL_DISPATCH=off)');
    return () => {};
  }
  const intervalMs =
    opts.intervalMs ?? (Number(process.env['MAIL_DISPATCH_INTERVAL_MS']) || 15_000);

  let inFlight = false;
  let again = false;
  let stopped = false;

  const run = () => {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    void (async () => {
      try {
        const s = await deliverDueEmails(pool, log);
        if (s.sent + s.logged + s.failed + s.retried > 0) {
          log.info({ ...s }, 'Mail dispatcher pass');
        }
      } finally {
        inFlight = false;
        if (again && !stopped) {
          again = false;
          run();
        }
      }
    })();
  };

  const timer = setInterval(run, intervalMs);
  timer.unref();
  runOnce = run;
  run();

  return () => {
    stopped = true;
    clearInterval(timer);
    if (kickTimer) clearTimeout(kickTimer);
    kickTimer = null;
    if (runOnce === run) runOnce = null;
  };
}

/** Whether the background dispatcher is running in this process. */
export function isMailDispatcherRunning(): boolean {
  return runOnce !== null;
}

/**
 * Ask the dispatcher to run soon (debounced) — call after queueing a notice so
 * it goes out within seconds. A no-op when the dispatcher is not running
 * (tests, MAIL_DISPATCH=off).
 */
export function kickMailDispatcher(): void {
  if (!runOnce || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    runOnce?.();
  }, KICK_DELAY_MS);
  kickTimer.unref();
}
