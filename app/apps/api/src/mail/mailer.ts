import {
  claimDueEmails,
  markEmailFailed,
  markEmailLogged,
  markEmailSent,
  rescheduleEmail,
} from '@cis/db';
import type { getPool } from '@cis/db';
import { selectTransport } from './select-transport';
import { MailSendError, type MailTransport } from './transport';

/**
 * Delivers the email outbox. Every notice is queued in `email_outbox` first, so
 * the record exists whatever happens here; this sends what is due.
 *
 * The mail service is chosen by selectTransport (ZeptoMail, else SMTP). With
 * neither configured, notices are marked `logged` — recorded, not sent — so
 * nothing is lost and the operator can see no mail service is set up.
 *
 * A transient refusal (rate limit, provider outage, network) leaves the notice
 * queued and retries it after 1, 5, 15 then 60 minutes; a permanent refusal,
 * or a fifth failed attempt, marks it `failed` with the reason.
 *
 * Delivery never throws.
 */

type Pool = ReturnType<typeof getPool>;

export interface MailLog {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface DeliverySummary {
  sent: number;
  logged: number;
  failed: number;
  retried: number;
}

export interface DeliverOptions {
  /** The mail service; `null` means none (log only). Default: from the environment. */
  transport?: MailTransport | null;
  /** How many notices to claim in this pass (default 25). */
  limit?: number;
}

export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/** Delay before the next try after `attempts` failed attempts (1-based). */
export function backoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[i] ?? 60 * 60_000;
}

let envTransport: MailTransport | null | undefined;
function defaultTransport(): MailTransport | null {
  if (envTransport === undefined) envTransport = selectTransport(process.env);
  return envTransport;
}

const reasonOf = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 1000);

export async function deliverDueEmails(
  pool: Pool,
  log: MailLog,
  opts: DeliverOptions = {},
): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: 0, logged: 0, failed: 0, retried: 0 };
  try {
    const transport = 'transport' in opts ? (opts.transport ?? null) : defaultTransport();
    const due = await claimDueEmails(pool, { limit: opts.limit ?? 25 });
    for (const email of due) {
      try {
        if (!transport) {
          await markEmailLogged(pool, email.id);
          log.info(
            { emailId: email.id, kind: email.kind },
            'No mail service configured — notice recorded, not sent',
          );
          summary.logged += 1;
          continue;
        }
        try {
          const { messageId } = await transport.send({
            to: email.toAddress,
            toName: email.toName,
            subject: email.subject,
            text: email.bodyText,
            html: email.bodyHtml,
            reference: email.id,
          });
          await markEmailSent(pool, email.id, {
            provider: transport.name,
            providerMessageId: messageId ?? null,
          });
          summary.sent += 1;
        } catch (err) {
          const reason = reasonOf(err);
          const permanent = err instanceof MailSendError ? err.permanent : false;
          if (permanent || email.attempts >= MAX_ATTEMPTS) {
            await markEmailFailed(pool, email.id, reason);
            log.warn(
              { emailId: email.id, kind: email.kind, attempts: email.attempts, reason },
              'Notice delivery failed',
            );
            summary.failed += 1;
          } else {
            const delay = backoffMs(email.attempts);
            await rescheduleEmail(pool, email.id, reason, delay);
            log.warn(
              {
                emailId: email.id,
                kind: email.kind,
                attempts: email.attempts,
                retryInMs: delay,
                reason,
              },
              'Notice delivery deferred — will retry',
            );
            summary.retried += 1;
          }
        }
      } catch (err) {
        // A database hiccup on one notice: its lease runs out and it is retried.
        log.warn({ emailId: email.id, err: reasonOf(err) }, 'Notice bookkeeping failed');
      }
    }
  } catch (err) {
    log.warn({ err: reasonOf(err) }, 'Email outbox could not be read');
  }
  return summary;
}

/**
 * Sends everything due now (several passes), for callers that report the
 * outcome straight away — e.g. a firm-report release. Never throws.
 */
export async function deliverQueuedEmails(
  pool: Pool,
  log: MailLog,
  opts: DeliverOptions = {},
): Promise<DeliverySummary> {
  const total: DeliverySummary = { sent: 0, logged: 0, failed: 0, retried: 0 };
  const limit = opts.limit ?? 25;
  for (let pass = 0; pass < 40; pass++) {
    const s = await deliverDueEmails(pool, log, { ...opts, limit });
    total.sent += s.sent;
    total.logged += s.logged;
    total.failed += s.failed;
    total.retried += s.retried;
    if (s.sent + s.logged + s.failed + s.retried < limit) break;
  }
  return total;
}

/** For tests: forget the transport chosen from the environment. */
export function resetMailTransportForTests(): void {
  envTransport = undefined;
}
