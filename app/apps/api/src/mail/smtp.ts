import nodemailer from 'nodemailer';
import { MailSendError, senderFromEnv, type MailTransport } from './transport';

/**
 * Plain SMTP, the fallback when ZeptoMail is not configured.
 *   SMTP_URL — e.g. smtps://user:pass@smtp.example.com:465
 */
export function createSmtpTransport(env: NodeJS.ProcessEnv = process.env): MailTransport {
  const url = env['SMTP_URL'];
  if (!url) throw new Error('SMTP_URL is not set');
  const smtp = nodemailer.createTransport(url);
  const from = senderFromEnv(env);
  return {
    name: 'smtp',
    async send(msg) {
      try {
        const info = await smtp.sendMail({
          from: { name: from.name, address: from.address },
          to: msg.toName ? { name: msg.toName, address: msg.to } : msg.to,
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        });
        return info.messageId ? { messageId: String(info.messageId) } : {};
      } catch (err) {
        const e = err as { message?: string; responseCode?: number };
        // SMTP 5xx replies are final; 4xx and connection errors may pass.
        const permanent = typeof e.responseCode === 'number' && e.responseCode >= 500;
        throw new MailSendError(e.message ?? String(err), { permanent });
      }
    },
  };
}
