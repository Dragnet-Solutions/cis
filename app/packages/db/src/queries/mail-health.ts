import { Pool } from 'pg';
import { query } from '../client';
import type { EmailStatus } from './email-outbox';

/**
 * What the email outbox says about the mail service's health, for operators:
 * how the last `days` days of notices stand, how long the oldest one has been
 * waiting, and the most recent failures.
 */
export interface OutboxHealth {
  counts: Record<EmailStatus, number>;
  oldestQueuedAt: Date | null;
  recentFailures: Array<{ kind: string; to: string; error: string | null; at: Date }>;
  recentLogged: number;
}

export async function getOutboxHealth(
  pool: Pool,
  opts: { days?: number; failures?: number } = {},
): Promise<OutboxHealth> {
  const days = opts.days ?? 7;
  const counts: Record<EmailStatus, number> = { queued: 0, sent: 0, logged: 0, failed: 0 };
  const byStatus = await query<{ status: EmailStatus; n: string }>(
    pool,
    `SELECT status, COUNT(*)::text AS n FROM email_outbox
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY status`,
    [days],
  );
  for (const r of byStatus.rows) {
    if (r.status in counts) counts[r.status] = parseInt(r.n, 10);
  }

  const oldest = await query<{ at: Date | null }>(
    pool,
    `SELECT MIN(created_at) AS at FROM email_outbox WHERE status = 'queued'`,
  );

  const failures = await query<{
    kind: string;
    to_address: string;
    error: string | null;
    at: Date;
  }>(
    pool,
    `SELECT kind, to_address, error, COALESCE(attempted_at, created_at) AS at
       FROM email_outbox WHERE status = 'failed'
      ORDER BY COALESCE(attempted_at, created_at) DESC
      LIMIT $1`,
    [opts.failures ?? 10],
  );

  return {
    counts,
    oldestQueuedAt: oldest.rows[0]?.at ?? null,
    recentFailures: failures.rows.map((r) => ({
      kind: r.kind,
      to: r.to_address,
      error: r.error,
      at: r.at,
    })),
    recentLogged: counts.logged,
  };
}
