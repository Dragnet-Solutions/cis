import { MailSendError, parseAddress, senderFromEnv, type MailTransport } from './transport';

/**
 * ZeptoMail (Zoho's transactional email API) over HTTPS.
 *
 *   ZEPTOMAIL_API_TOKEN — the Send Mail token of a Mail Agent. Either the raw
 *                         token or the full "Zoho-enczapikey …" header value.
 *   ZEPTOMAIL_API_URL   — default https://api.zeptomail.com/v1.1/email; use the
 *                         regional host the account lives on (api.zeptomail.eu,
 *                         api.zeptomail.in, …).
 *   MAIL_FROM           — "Name <addr>"; the domain must be verified in the agent.
 *   MAIL_REPLY_TO       — optional reply-to ("Name <addr>" or bare address).
 *
 * The token is only ever placed in the Authorization header — never in an
 * error message or a log line.
 */

export const DEFAULT_ZEPTOMAIL_API_URL = 'https://api.zeptomail.com/v1.1/email';
const TIMEOUT_MS = 15_000;
const AUTH_PREFIX = 'Zoho-enczapikey';

interface ZeptoErrorDetail {
  code?: string;
  message?: string;
  target?: string;
  target_value?: string;
}

interface ZeptoResponse {
  request_id?: string;
  message?: string;
  data?: unknown;
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    details?: ZeptoErrorDetail[];
  };
}

export function zeptomailAuthorization(token: string): string {
  const t = token.trim();
  return t.startsWith(AUTH_PREFIX) ? t : `${AUTH_PREFIX} ${t}`;
}

/** A readable reason from a ZeptoMail error body. */
function describeError(status: number, body: ZeptoResponse | null): string {
  const parts: string[] = [];
  const err = body?.error;
  if (err) {
    const head = [err.code, err.message].filter(Boolean).join(' ');
    if (head) parts.push(head);
    for (const d of err.details ?? []) {
      const detail = [d.code, d.message].filter(Boolean).join(' ');
      const where = d.target ? ` (${d.target})` : '';
      if (detail) parts.push(`${detail}${where}`);
    }
  } else if (body?.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    const d = body.data as { error_code?: string; message?: string };
    const head = [d.error_code, d.message].filter(Boolean).join(' ');
    if (head) parts.push(head);
  } else if (body?.message) {
    parts.push(body.message);
  }
  return `ZeptoMail ${status}${parts.length ? `: ${parts.join('; ')}` : ''}`;
}

export function createZeptomailTransport(env: NodeJS.ProcessEnv = process.env): MailTransport {
  const token = env['ZEPTOMAIL_API_TOKEN'] ?? '';
  if (!token.trim()) throw new Error('ZEPTOMAIL_API_TOKEN is not set');
  const url = env['ZEPTOMAIL_API_URL']?.trim() || DEFAULT_ZEPTOMAIL_API_URL;
  const from = senderFromEnv(env);
  const replyTo = parseAddress(env['MAIL_REPLY_TO'], from.name);
  const authorization = zeptomailAuthorization(token);
  // Belt and braces: whatever the provider echoes, the token never leaves here.
  const rawToken = token.trim().replace(new RegExp(`^${AUTH_PREFIX}\\s*`), '');
  const scrub = (s: string) => (rawToken ? s.split(rawToken).join('[redacted]') : s);

  return {
    name: 'zeptomail',
    async send(msg) {
      const body: Record<string, unknown> = {
        from: { address: from.address, name: from.name },
        to: [
          {
            email_address: msg.toName ? { address: msg.to, name: msg.toName } : { address: msg.to },
          },
        ],
        subject: msg.subject,
        textbody: msg.text,
        track_clicks: false,
        track_opens: false,
      };
      if (msg.html) body['htmlbody'] = msg.html;
      if (msg.reference) body['client_reference'] = msg.reference;
      if (replyTo) body['reply_to'] = [{ address: replyTo.address, name: replyTo.name }];

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: authorization,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        const e = err as { name?: string; message?: string };
        const reason =
          e?.name === 'TimeoutError' || e?.name === 'AbortError'
            ? `timed out after ${TIMEOUT_MS / 1000}s`
            : (e?.message ?? String(err));
        throw new MailSendError(scrub(`ZeptoMail unreachable: ${reason}`), { permanent: false });
      }

      let parsed: ZeptoResponse | null = null;
      try {
        parsed = (await res.json()) as ZeptoResponse;
      } catch {
        parsed = null;
      }

      if (res.ok) {
        const messageId = parsed?.request_id;
        return messageId ? { messageId } : {};
      }
      const permanent = !(res.status === 429 || res.status >= 500);
      throw new MailSendError(scrub(describeError(res.status, parsed)), { permanent });
    },
  };
}
