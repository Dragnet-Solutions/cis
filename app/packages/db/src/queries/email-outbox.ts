import { Pool, PoolClient } from 'pg';
import { query } from '../client';

/**
 * Every notice the system sends, kept whether or not a mail service is set:
 * `queued` until delivered, then `sent`, `logged` (no mail service — recorded,
 * not sent) or `failed` with the reason. A transient refusal keeps it `queued`
 * with the error and a later `next_attempt_at` (back-off).
 *
 * `next_attempt_at` is also the lease: claiming a notice pushes it into the
 * future, so another API pod polling the outbox does not send it twice.
 */
export type EmailStatus = 'queued' | 'sent' | 'logged' | 'failed';

/** A pool, or a client inside a transaction. */
type Db = Pool | PoolClient;

export interface OutboxEmail {
  id: string;
  kind: string;
  refId: string | null;
  toAddress: string;
  toName: string | null;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  status: EmailStatus;
  error: string | null;
  attempts: number;
  nextAttemptAt: Date;
  provider: string | null;
  providerMessageId: string | null;
  createdAt: Date;
  attemptedAt: Date | null;
}

interface RawOutboxRow {
  id: string;
  kind: string;
  ref_id: string | null;
  to_address: string;
  to_name: string | null;
  subject: string;
  body_text: string;
  body_html: string | null;
  status: EmailStatus;
  error: string | null;
  attempts: number;
  next_attempt_at: Date;
  provider: string | null;
  provider_message_id: string | null;
  created_at: Date;
  attempted_at: Date | null;
}

const mapEmail = (r: RawOutboxRow): OutboxEmail => ({
  id: r.id,
  kind: r.kind,
  refId: r.ref_id,
  toAddress: r.to_address,
  toName: r.to_name,
  subject: r.subject,
  bodyText: r.body_text,
  bodyHtml: r.body_html,
  status: r.status,
  error: r.error,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  provider: r.provider,
  providerMessageId: r.provider_message_id,
  createdAt: r.created_at,
  attemptedAt: r.attempted_at,
});

/** PoolClient's query is call-compatible with Pool's; the helper is typed on Pool. */
const asPool = (db: Db): Pool => db as Pool;

export async function queueEmail(
  db: Db,
  data: {
    kind: string;
    refId: string | null;
    toAddress: string;
    toName?: string | null;
    subject: string;
    bodyText: string;
    bodyHtml?: string | null;
  },
): Promise<OutboxEmail> {
  const res = await query<RawOutboxRow>(
    asPool(db),
    `INSERT INTO email_outbox (kind, ref_id, to_address, to_name, subject, body_text, body_html)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      data.kind,
      data.refId,
      data.toAddress,
      data.toName ?? null,
      data.subject,
      data.bodyText,
      data.bodyHtml ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('email outbox insert returned no rows');
  return mapEmail(row);
}

/** Queued notices whose next attempt is due (read only — see claimDueEmails). */
export async function listQueuedEmails(pool: Db, limit = 50): Promise<OutboxEmail[]> {
  const res = await query<RawOutboxRow>(
    asPool(pool),
    `SELECT * FROM email_outbox
      WHERE status = 'queued' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at LIMIT $1`,
    [limit],
  );
  return res.rows.map(mapEmail);
}

/**
 * Atomically lease up to `limit` due notices for delivery: each claimed row's
 * attempts goes up by one and its next attempt moves `leaseMs` into the
 * future, so a concurrent claim (another pod) skips it. A delivery that dies
 * mid-way is retried once the lease runs out.
 */
export async function claimDueEmails(
  pool: Db,
  opts: { limit?: number; leaseMs?: number } = {},
): Promise<OutboxEmail[]> {
  const limit = opts.limit ?? 25;
  const leaseMs = opts.leaseMs ?? 300_000;
  const res = await query<RawOutboxRow>(
    asPool(pool),
    `UPDATE email_outbox
        SET attempts = attempts + 1,
            next_attempt_at = NOW() + ($2::int * INTERVAL '1 millisecond')
      WHERE id IN (
        SELECT id FROM email_outbox
         WHERE status = 'queued' AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit, leaseMs],
  );
  return res.rows
    .map(mapEmail)
    .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime());
}

export async function markEmailSent(
  pool: Db,
  id: string,
  sent: { provider: string; providerMessageId?: string | null },
): Promise<void> {
  await query(
    asPool(pool),
    `UPDATE email_outbox
        SET status = 'sent', error = NULL, attempted_at = NOW(),
            provider = $2, provider_message_id = $3
      WHERE id = $1`,
    [id, sent.provider, sent.providerMessageId ?? null],
  );
}

/** No mail service is configured: recorded, not sent. */
export async function markEmailLogged(pool: Db, id: string): Promise<void> {
  await query(
    asPool(pool),
    `UPDATE email_outbox SET status = 'logged', error = NULL, attempted_at = NOW() WHERE id = $1`,
    [id],
  );
}

export async function markEmailFailed(pool: Db, id: string, error: string): Promise<void> {
  await query(
    asPool(pool),
    `UPDATE email_outbox SET status = 'failed', error = $2, attempted_at = NOW() WHERE id = $1`,
    [id, error.slice(0, 1000)],
  );
}

/** A transient refusal: stays queued, records why, and is tried again after `delayMs`. */
export async function rescheduleEmail(
  pool: Db,
  id: string,
  error: string,
  delayMs: number,
): Promise<void> {
  await query(
    asPool(pool),
    `UPDATE email_outbox
        SET status = 'queued', error = $2, attempted_at = NOW(),
            next_attempt_at = NOW() + ($3::int * INTERVAL '1 millisecond')
      WHERE id = $1`,
    [id, error.slice(0, 1000), Math.max(0, Math.round(delayMs))],
  );
}

/** Generic status update, kept for compatibility; prefer the markEmail* helpers. */
export async function markEmail(
  pool: Db,
  id: string,
  status: Exclude<EmailStatus, 'queued'>,
  error: string | null = null,
): Promise<void> {
  await query(
    asPool(pool),
    `UPDATE email_outbox SET status = $2, error = $3, attempted_at = NOW() WHERE id = $1`,
    [id, status, error],
  );
}

/** The notices sent about one thing (e.g. one firm report's release). */
export async function listEmailsFor(
  pool: Db,
  kind: string,
  refIds: string[],
): Promise<OutboxEmail[]> {
  if (refIds.length === 0) return [];
  const res = await query<RawOutboxRow>(
    asPool(pool),
    `SELECT * FROM email_outbox WHERE kind = $1 AND ref_id = ANY($2::uuid[]) ORDER BY created_at`,
    [kind, refIds],
  );
  return res.rows.map(mapEmail);
}

export async function getEmailById(pool: Db, id: string): Promise<OutboxEmail | null> {
  const res = await query<RawOutboxRow>(asPool(pool), 'SELECT * FROM email_outbox WHERE id = $1', [
    id,
  ]);
  const row = res.rows[0];
  return row ? mapEmail(row) : null;
}
