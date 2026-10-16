/**
 * How a notice leaves the system. The outbox (email_outbox) is the record; a
 * transport only sends. Delivery is driven by mailer.ts.
 */

export interface MailMessage {
  to: string;
  toName?: string | null;
  subject: string;
  text: string;
  html?: string | null;
  /** Our own reference for the message (the outbox id), echoed by the provider. */
  reference?: string;
}

export interface MailTransport {
  /** Recorded on the outbox row as `provider` (e.g. 'zeptomail', 'smtp'). */
  name: string;
  /** Resolves with the provider's id for the message; throws MailSendError. */
  send(msg: MailMessage): Promise<{ messageId?: string }>;
}

/**
 * A refused or failed send. `permanent` means retrying will not help (a bad
 * address, a rejected sender, bad credentials); otherwise the notice is tried
 * again later with back-off.
 */
export class MailSendError extends Error {
  readonly permanent: boolean;
  constructor(message: string, opts: { permanent: boolean }) {
    super(message);
    this.name = 'MailSendError';
    this.permanent = opts.permanent;
  }
}

export interface Sender {
  address: string;
  name: string;
}

export const DEFAULT_SENDER_NAME = 'CIS × Dragnet';
const DEFAULT_SENDER_ADDRESS = 'no-reply@cis.example';

/**
 * Parses an address in the form `Name <addr@example.com>` or a bare
 * `addr@example.com`. A bare address takes `defaultName`.
 */
export function parseAddress(
  value: string | undefined | null,
  defaultName = DEFAULT_SENDER_NAME,
): Sender | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const m = /^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(raw);
  if (m) {
    const name = (m[1] ?? '')
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim();
    return { address: m[2] ?? '', name: name || defaultName };
  }
  return { address: raw, name: defaultName };
}

/** The sender, from MAIL_FROM ("Name <addr>" or a bare address). */
export function senderFromEnv(env: NodeJS.ProcessEnv = process.env): Sender {
  return (
    parseAddress(env['MAIL_FROM']) ?? { address: DEFAULT_SENDER_ADDRESS, name: DEFAULT_SENDER_NAME }
  );
}
