import type { getPool } from '@cis/db';
import nodemailer, { type Transporter } from 'nodemailer';
import { listQueuedEmails, markEmail } from '@cis/db';

/**
 * Delivers the email outbox. Every notice is queued in `email_outbox` first, so
 * the record exists whatever happens here; this sends what is queued.
 *
 * Configuration (.env):
 *   SMTP_URL   — e.g. smtps://user:pass@smtp.example.com:465. Unset: notices are
 *                marked `logged` (recorded, not sent) — nothing is lost, and the
 *                operator sees that no mail server is configured.
 *   MAIL_FROM  — the sender (default "CIS × Dragnet <no-reply@cis.example>").
 *
 * Delivery never throws: a refusal marks that notice `failed` with the reason.
 */

let transport: Transporter | null | undefined;

function getTransport(): Transporter | null {
  if (transport === undefined) {
    const url = process.env['SMTP_URL'];
    transport = url ? nodemailer.createTransport(url) : null;
  }
  return transport;
}

export interface DeliverySummary {
  sent: number;
  logged: number;
  failed: number;
}

type Pool = ReturnType<typeof getPool>;

export async function deliverQueuedEmails(
  pool: Pool,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: 0, logged: 0, failed: 0 };
  const from = process.env['MAIL_FROM'] || 'CIS × Dragnet <no-reply@cis.example>';
  const smtp = getTransport();
  for (const email of await listQueuedEmails(pool)) {
    if (!smtp) {
      await markEmail(pool, email.id, 'logged');
      log.info(
        { emailId: email.id, kind: email.kind },
        'No SMTP_URL set — notice recorded, not sent',
      );
      summary.logged += 1;
      continue;
    }
    try {
      await smtp.sendMail({
        from,
        to: email.toAddress,
        subject: email.subject,
        text: email.bodyText,
      });
      await markEmail(pool, email.id, 'sent');
      summary.sent += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await markEmail(pool, email.id, 'failed', reason.slice(0, 500));
      log.warn({ emailId: email.id, kind: email.kind }, 'Notice delivery failed');
      summary.failed += 1;
    }
  }
  return summary;
}
