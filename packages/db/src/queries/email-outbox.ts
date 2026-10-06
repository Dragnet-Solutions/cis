import { Pool } from 'pg';
import { query } from '../client';

/**
 * Every notice the system sends, kept whether or not a mail server is set:
 * `queued` until a delivery attempt, then `sent`, `logged` (no mail server —
 * recorded, not sent) or `failed` with the reason.
 */
export type EmailStatus = 'queued' | 'sent' | 'logged' | 'failed';

export interface OutboxEmail {
  id: string;
  kind: string;
  refId: string | null;
  toAddress: string;
  subject: string;
  bodyText: string;
  status: EmailStatus;
  error: string | null;
  createdAt: Date;
  attemptedAt: Date | null;
}

interface RawOutboxRow {
  id: string;
  kind: string;
  ref_id: string | null;
  to_address: string;
  subject: string;
  body_text: string;
  status: EmailStatus;
  error: string | null;
  created_at: Date;
  attempted_at: Date | null;
}

const mapEmail = (r: RawOutboxRow): OutboxEmail => ({
  id: r.id,
  kind: r.kind,
  refId: r.ref_id,
  toAddress: r.to_address,
  subject: r.subject,
  bodyText: r.body_text,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
  attemptedAt: r.attempted_at,
});

export async function queueEmail(
  pool: Pool,
  data: {
    kind: string;
    refId: string | null;
    toAddress: string;
    subject: string;
    bodyText: string;
  },
): Promise<OutboxEmail> {
  const res = await query<RawOutboxRow>(
    pool,
    `INSERT INTO email_outbox (kind, ref_id, to_address, subject, body_text)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [data.kind, data.refId, data.toAddress, data.subject, data.bodyText],
  );
  const row = res.rows[0];
  if (!row) throw new Error('email outbox insert returned no rows');
  return mapEmail(row);
}

export async function listQueuedEmails(pool: Pool, limit = 50): Promise<OutboxEmail[]> {
  const res = await query<RawOutboxRow>(
    pool,
    `SELECT * FROM email_outbox WHERE status = 'queued' ORDER BY created_at LIMIT $1`,
    [limit],
  );
  return res.rows.map(mapEmail);
}

export async function markEmail(
  pool: Pool,
  id: string,
  status: Exclude<EmailStatus, 'queued'>,
  error: string | null = null,
): Promise<void> {
  await query(
    pool,
    `UPDATE email_outbox SET status = $2, error = $3, attempted_at = NOW() WHERE id = $1`,
    [id, status, error],
  );
}

/** The notices sent about one thing (e.g. one firm report's release). */
export async function listEmailsFor(
  pool: Pool,
  kind: string,
  refIds: string[],
): Promise<OutboxEmail[]> {
  if (refIds.length === 0) return [];
  const res = await query<RawOutboxRow>(
    pool,
    `SELECT * FROM email_outbox WHERE kind = $1 AND ref_id = ANY($2::uuid[]) ORDER BY created_at`,
    [kind, refIds],
  );
  return res.rows.map(mapEmail);
}
