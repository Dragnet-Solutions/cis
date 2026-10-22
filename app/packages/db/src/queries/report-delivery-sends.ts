import type { Pool, PoolClient } from 'pg';

/**
 * D-04 — the ledger of the published report emailed to investors who asked for
 * it (`report_delivery_sends`, one row per publication and respondent).
 */

/** A respondent the report email is now due to: newly written to the ledger. */
export interface ReportDeliveryRecipient {
  respondentId: string;
  email: string;
  recoveryToken: string | null;
}

/**
 * Claims up to `limit` respondents of the edition who asked for the report by
 * email (`report_delivery` 'email' or 'both'), have an email address, have
 * submitted and not withdrawn, and are not yet in the ledger for this
 * publication. Rows are written ON CONFLICT DO NOTHING and only the rows this
 * call wrote are returned — so a concurrent or repeated call never claims the
 * same respondent twice. Run it in the transaction that queues the emails.
 */
export async function claimReportDeliveryRecipients(
  db: Pool | PoolClient,
  publicationId: string,
  editionId: string,
  limit: number,
): Promise<ReportDeliveryRecipient[]> {
  const res = await db.query<{
    respondent_id: string;
    contact_email: string;
    recovery_token: string | null;
  }>(
    `WITH claimed AS (
       INSERT INTO report_delivery_sends (publication_id, respondent_id)
       SELECT $1, r.id
         FROM respondents r
        WHERE r.edition_id = $2
          AND r.report_delivery IN ('email', 'both')
          AND btrim(r.contact_email) ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
          AND r.submitted_at IS NOT NULL
          AND r.withdrawn_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM report_delivery_sends s
             WHERE s.publication_id = $1 AND s.respondent_id = r.id
          )
        ORDER BY r.submitted_at, r.id
        LIMIT $3
       ON CONFLICT DO NOTHING
       RETURNING respondent_id
     )
     SELECT r.id AS respondent_id, btrim(r.contact_email) AS contact_email, r.recovery_token
       FROM claimed c JOIN respondents r ON r.id = c.respondent_id
      ORDER BY r.submitted_at, r.id`,
    [publicationId, editionId, limit],
  );
  return res.rows.map((row) => ({
    respondentId: row.respondent_id,
    email: row.contact_email,
    recoveryToken: row.recovery_token,
  }));
}

/** How many investors the report for this publication has been emailed to. */
export async function countReportDeliverySends(
  db: Pool | PoolClient,
  publicationId: string,
): Promise<number> {
  const res = await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM report_delivery_sends WHERE publication_id = $1`,
    [publicationId],
  );
  return Number(res.rows[0]?.n ?? 0);
}
