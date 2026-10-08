import { Pool } from 'pg';
import { query } from '../client';

/**
 * Item-level read helpers for the candidate scoring engine (Phase 11).
 * Completeness is checked at the ITEM level (not seat-level, per the OPS-003
 * clarification), and firm-attributable investor aggregation enforces Phase 2's
 * existing `scope` flag so a shared market-level answer is never copied into a
 * firm-specific record.
 */

/**
 * Per-firm raw answers for a set of FIRM-SIDE items (S1/S2/S3), read through the
 * firm's seat respondents. Returns one row per (firm, item) that has an answer.
 * `a` is the raw answer value as text (the transform is applied in the domain).
 */
export async function getFirmSideItemAnswers(
  pool: Pool,
  editionId: string,
  itemIds: string[],
  asOf?: Date,
): Promise<Array<{ firmId: string; questionId: string; a: string | null }>> {
  const res = await query<{ firm_id: string; question_id: string; a: string | null }>(
    pool,
    `SELECT sa.organization_id AS firm_id, r.question_id, (r.answer->>'a') AS a
       FROM seat_assignments sa
       JOIN responses r ON r.respondent_id = sa.respondent_id
      WHERE sa.edition_id = $1 AND r.question_id = ANY($2)
        ${asOf ? 'AND r.created_at <= $3' : ''}`,
    asOf ? [editionId, itemIds, asOf] : [editionId, itemIds],
  );
  return res.rows.map((x) => ({ firmId: x.firm_id, questionId: x.question_id, a: x.a }));
}

/**
 * Firm-attributable investor answers for a firm, JOINED to
 * `instrument_questions.scope`. When `firmSpecificOnly` is true, only
 * `scope = 'firm_specific'` items are returned — a shared market-level answer
 * (e.g. S5b-Q1) is structurally excluded from a firm-specific ICI/IEI record.
 */
export async function getFirmAttributableInvestorAnswers(
  pool: Pool,
  editionId: string,
  firmId: string,
  opts: { firmSpecificOnly?: boolean } = {},
): Promise<Array<{ questionId: string; scope: 'shared' | 'firm_specific'; a: string | null }>> {
  const res = await query<{
    question_id: string;
    scope: 'shared' | 'firm_specific';
    a: string | null;
  }>(
    pool,
    `SELECT r.question_id, iq.scope, (r.answer->>'a') AS a
       FROM responses r
       JOIN respondents resp ON resp.id = r.respondent_id
       JOIN instrument_questions iq ON iq.question_code = r.question_id
      WHERE resp.edition_id = $1 AND r.rated_firm_id = $2
        ${opts.firmSpecificOnly ? "AND iq.scope = 'firm_specific'" : ''}`,
    [editionId, firmId],
  );
  return res.rows.map((x) => ({ questionId: x.question_id, scope: x.scope, a: x.a }));
}

/**
 * Every response for one investor instrument (S4/S5a/S5b) across an entire
 * edition — the raw material for Phase 22's relationship/unit-level investor
 * scoring. One row per (respondent, question, rated firm); a SHARED item
 * (e.g. S5b-Q1/Q8) carries `ratedFirmId: null` — the same distinction
 * `getFirmAttributableInvestorAnswers` already enforces, just ungrouped by
 * firm so a caller can build one relationship score per respondent×firm and
 * then re-aggregate it BOTH by respondent (national unit scores) and by firm
 * (`Firm_Investor_IEI_f`/`Firm_ICI_f`) from the exact same underlying data —
 * one computation, two aggregations, never two computations.
 */
export async function getInvestorInstrumentAnswers(
  pool: Pool,
  editionId: string,
  instrumentCode: string,
): Promise<
  Array<{ respondentId: string; questionId: string; ratedFirmId: string | null; a: string | null }>
> {
  const res = await query<{
    respondent_id: string;
    question_id: string;
    rated_firm_id: string | null;
    a: string | null;
  }>(
    pool,
    `SELECT r.respondent_id, r.question_id, r.rated_firm_id, (r.answer->>'a') AS a
       FROM responses r
       JOIN respondents resp ON resp.id = r.respondent_id
      WHERE resp.edition_id = $1 AND resp.instrument_code = $2`,
    [editionId, instrumentCode],
  );
  return res.rows.map((x) => ({
    respondentId: x.respondent_id,
    questionId: x.question_id,
    ratedFirmId: x.rated_firm_id,
    a: x.a,
  }));
}
