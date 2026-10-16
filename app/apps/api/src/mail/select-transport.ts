import { createSmtpTransport } from './smtp';
import type { MailTransport } from './transport';
import { createZeptomailTransport } from './zeptomail';

/**
 * Which mail service sends notices: ZeptoMail when ZEPTOMAIL_API_TOKEN is set,
 * else SMTP when SMTP_URL is set, else none — notices are recorded (`logged`)
 * but not sent.
 */
export function selectTransport(env: NodeJS.ProcessEnv = process.env): MailTransport | null {
  if (env['ZEPTOMAIL_API_TOKEN']?.trim()) return createZeptomailTransport(env);
  if (env['SMTP_URL']?.trim()) return createSmtpTransport(env);
  return null;
}
