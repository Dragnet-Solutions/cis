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
  /** Why the last `days` days' "recorded, not sent" notices were held back:
   *  a reserved test address (`.example`, `.test` … — by design, never sent),
   *  or no mail service configured. */
  loggedByReason: { testAddress: number; noMailService: number };
  /** The most recent recorded-not-sent notices, with their reason. */
  recentHeld: Array<{ kind: string; to: string; reason: string; at: Date }>;
}

/** The reason the mailer records on a notice to a reserved test domain. */
export const HELD_TEST_ADDRESS_REASON = 'reserved test domain';

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

  const reasons = await query<{ test_address: string; no_service: string }>(
    pool,
    `SELECT COUNT(*) FILTER (WHERE error = $2)::text AS test_address,
            COUNT(*) FILTER (WHERE error IS DISTINCT FROM $2)::text AS no_service
       FROM email_outbox
      WHERE status = 'logged' AND created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
    [days, HELD_TEST_ADDRESS_REASON],
  );
  const held = await query<{ kind: string; to_address: string; error: string | null; at: Date }>(
    pool,
    `SELECT kind, to_address, error, COALESCE(attempted_at, created_at) AS at
       FROM email_outbox WHERE status = 'logged'
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
    loggedByReason: {
      testAddress: parseInt(reasons.rows[0]?.test_address ?? '0', 10),
      noMailService: parseInt(reasons.rows[0]?.no_service ?? '0', 10),
    },
    recentHeld: held.rows.map((r) => ({
      kind: r.kind,
      to: r.to_address,
      reason:
        r.error === HELD_TEST_ADDRESS_REASON
          ? 'Test address — mail to reserved test domains (.example, .test …) is never sent'
          : 'No mail service was configured when it was due',
      at: r.at,
    })),
  };
}
