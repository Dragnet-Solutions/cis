/**
 * Phase 16 — UX-ADM-007 Dragnet Internal Analysis.
 *
 * TWO STRUCTURALLY SEPARATE QUERY PATHS that can never be combined:
 *
 *   getFirmMaturityRows   — firm-identified, OMI/DMI only, NO DRG-OPS content
 *   getDrgOpsAggregate    — aggregate-only, DRG-OPS only, NO firm identifier
 *
 * The join boundary is enforced structurally (different tables, different
 * functions, no shared JOIN path) not merely by UI convention. A test in
 * packages/domain/tests/dragnet.test.ts actively asserts the impossibility
 * of querying DRG-OPS content alongside any firm-identifying column.
 */

import { Pool } from 'pg';
import { query } from '../client';

export interface FirmMaturityRow {
  organizationId: string;
  firmName: string;
  /** OMI score 0–100 from the signed-off scoring run, or null if not yet scored. */
  omi: number | null;
  /** DMI score 0–100 from the signed-off scoring run, or null if not yet scored. */
  dmi: number | null;
  /** Only present for firms that gave follow-up consent (Phase 4). Never null-but-present. */
  contact: { name: string; role: string | null; email: string } | null;
}

export interface DrgOpsAggregateRow {
  /** The DRG-OPS question code (from instrument_questions.question_code). */
  questionCode: string;
  /** The human-readable prompt text for this question. */
  promptText: string;
  /** The specific answer value (from responses.answer->>'a'). */
  answerValue: string;
  /** How many respondents gave this exact answer. */
  count: number;
  /** Percentage of all responses to this question. */
  pct: number;
}

/**
 * Firm-level maturity data for the Dragnet analysis surface.
 *
 * Returns OMI/DMI from the most-recently signed-off scoring run for the
 * given edition, joined to follow-up-consented contact details where available.
 * DRG-OPS data is NOT touched by this function; the two query paths cannot
 * be combined.
 *
 * Contact is ABSENT (null) when the firm did not give follow-up consent —
 * not masked, not an empty string, genuinely absent.
 */
export async function getFirmMaturityRows(
  pool: Pool,
  editionId: string,
): Promise<FirmMaturityRow[]> {
  const result = await query<{
    organization_id: string;
    firm_name: string;
    omi: string | null;
    dmi: string | null;
    contact_name: string | null;
    contact_role: string | null;
    contact_email: string | null;
  }>(
    pool,
    `WITH authoritative_run AS (
       SELECT cr.calculation_run_id
         FROM scoring_signoffs cr
        WHERE cr.edition_id = $1 AND cr.state = 'signed_off'
        ORDER BY cr.approved_at DESC
        LIMIT 1
     ),
     firm_omi AS (
       SELECT subject_id, value
         FROM calculated_results
        WHERE calculation_run_id = (SELECT calculation_run_id FROM authoritative_run)
          AND subject_type = 'firm'
          AND metric_code = 'OMI'
     ),
     firm_dmi AS (
       SELECT subject_id, value
         FROM calculated_results
        WHERE calculation_run_id = (SELECT calculation_run_id FROM authoritative_run)
          AND subject_type = 'firm'
          AND metric_code = 'DMI'
     ),
     consented_lead AS (
       SELECT
         fc.organization_id,
         coord.name    AS contact_name,
         coord.role    AS contact_role,
         coord.email   AS contact_email
         FROM firm_claims fc
         JOIN firm_coordinators coord
           ON coord.organization_id = fc.organization_id
          AND coord.is_lead = TRUE
          AND coord.revoked_at IS NULL
        WHERE fc.follow_up_consent = TRUE
     )
     SELECT
       o.id              AS organization_id,
       o.display_name    AS firm_name,
       omi.value::text   AS omi,
       dmi.value::text   AS dmi,
       cl.contact_name,
       cl.contact_role,
       cl.contact_email
       FROM organizations o
       LEFT JOIN firm_omi  omi ON omi.subject_id  = o.id::text
       LEFT JOIN firm_dmi  dmi ON dmi.subject_id  = o.id::text
       LEFT JOIN consented_lead cl ON cl.organization_id = o.id
      WHERE o.org_type = 'firm'
      ORDER BY o.display_name`,
    [editionId],
  );

  return result.rows.map((r) => ({
    organizationId: r.organization_id,
    firmName: r.firm_name,
    omi: r.omi !== null ? parseFloat(r.omi) : null,
    dmi: r.dmi !== null ? parseFloat(r.dmi) : null,
    contact:
      r.contact_name !== null && r.contact_email !== null
        ? { name: r.contact_name, role: r.contact_role ?? null, email: r.contact_email }
        : null,
  }));
}

/**
 * Aggregate-only DRG-OPS friction data for the Dragnet analysis surface.
 *
 * This function ONLY queries responses to DRG-OPS questions (is_drg_ops=TRUE).
 * It returns aggregate counts and percentages with NO firm-identifying columns.
 * No firm_id, organization_id, or any other firm identifier appears anywhere in
 * this query or its return type — structural enforcement, not convention.
 *
 * NOTE: The minimum-population floor for this view is an open item — see
 * packages/domain/README.md. At low response volume, the aggregate still
 * computes correctly but may be statistically less meaningful.
 */
export async function getDrgOpsAggregate(
  pool: Pool,
  editionId: string,
): Promise<DrgOpsAggregateRow[]> {
  const result = await query<{
    question_code: string;
    prompt_text: string;
    answer_value: string;
    count: string;
    total: string;
  }>(
    pool,
    `WITH drg_responses AS (
       SELECT
         iq.question_code,
         iq.prompt_text,
         r.answer->>'a' AS answer_value
         FROM responses r
         JOIN instrument_questions iq
           ON iq.question_code = r.question_id
          AND iq.is_drg_ops = TRUE
        WHERE r.edition_id = $1
          AND r.answer->>'a' IS NOT NULL
     ),
     per_question_total AS (
       SELECT question_code, COUNT(*)::bigint AS total
         FROM drg_responses
        GROUP BY question_code
     )
     SELECT
       dr.question_code,
       dr.prompt_text,
       dr.answer_value,
       COUNT(*)::text   AS count,
       pqt.total::text  AS total
       FROM drg_responses dr
       JOIN per_question_total pqt USING (question_code)
      GROUP BY dr.question_code, dr.prompt_text, dr.answer_value, pqt.total
      ORDER BY dr.question_code, dr.answer_value`,
    [editionId],
  );

  return result.rows.map((r) => {
    const count = parseInt(r.count, 10);
    const total = parseInt(r.total, 10);
    return {
      questionCode: r.question_code,
      promptText: r.prompt_text,
      answerValue: r.answer_value,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
    };
  });
}
