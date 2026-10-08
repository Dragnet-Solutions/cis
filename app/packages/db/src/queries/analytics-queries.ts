import { Pool } from 'pg';
import { query } from '../client';

/**
 * Raw analytics reads that back the Phase 5 scoring/eligibility/traceability
 * layer. Kept separate from the write-path query modules.
 */

/**
 * Per-firm count of completed firm-survey seats (S1/S2/S3) for an edition. A
 * firm is eligible for scoring with AT LEAST ONE complete. Uses Phase 4's
 * seat_assignments as the completion signal.
 */
export async function getFirmSeatCompletionCounts(
  pool: Pool,
  editionId: string,
): Promise<Array<{ organizationId: string; complete: number }>> {
  const result = await query<{ organization_id: string; complete: string }>(
    pool,
    `SELECT organization_id,
            COUNT(*) FILTER (WHERE state = 'complete')::text AS complete
       FROM seat_assignments
      WHERE edition_id = $1
      GROUP BY organization_id
      ORDER BY organization_id`,
    [editionId],
  );
  return result.rows.map((r) => ({
    organizationId: r.organization_id,
    complete: parseInt(r.complete, 10),
  }));
}

/**
 * Per-instrument participant counts for an edition: total submitted responses,
 * and the SUBSET who gave a contact detail (email or phone, channel not 'none').
 * The invitation audiences use the CONSENTED subset — presenting the response
 * count would imply a reach the study does not have (PAT-011, Phase 3).
 */
export async function countContactConsentByInstrument(
  pool: Pool,
  editionId: string,
): Promise<Record<string, { responses: number; consented: number }>> {
  const result = await query<{ instrument_code: string; responses: string; consented: string }>(
    pool,
    `SELECT instrument_code,
            COUNT(*)::text AS responses,
            COUNT(*) FILTER (
              WHERE contact_channel IS NOT NULL AND contact_channel <> 'none'
                AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL)
            )::text AS consented
       FROM respondents
      WHERE edition_id = $1 AND submitted_at IS NOT NULL
      GROUP BY instrument_code`,
    [editionId],
  );
  const out: Record<string, { responses: number; consented: number }> = {};
  for (const r of result.rows) {
    out[r.instrument_code] = {
      responses: parseInt(r.responses, 10),
      consented: parseInt(r.consented, 10),
    };
  }
  return out;
}

/**
 * The consented participant CONTACTS for a set of instruments — respondents who
 * gave a contact detail, returned as the address a permitted notice (recovery
 * link / final report) would go to. Enumerated only for a participant send; the
 * counts above are what the audience list shows.
 */
export async function listConsentedContactsByInstrument(
  pool: Pool,
  editionId: string,
  instrumentCodes: string[],
): Promise<Array<{ respondentId: string; email: string | null }>> {
  const result = await query<{ id: string; email: string | null }>(
    pool,
    `SELECT id, COALESCE(contact_email, contact_phone) AS email
       FROM respondents
      WHERE edition_id = $1 AND submitted_at IS NOT NULL
        AND instrument_code = ANY($2)
        AND contact_channel IS NOT NULL AND contact_channel <> 'none'
        AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL)`,
    [editionId, instrumentCodes],
  );
  return result.rows.map((r) => ({ respondentId: r.id, email: r.email }));
}

/**
 * Per-firm seat-state counts for an edition: how many of the three seats are
 * ASSIGNED (state beyond 'empty') and how many are COMPLETE. Feeds the
 * invitation audiences (noassign / partial / noreach / complete). Only firms
 * with seat rows appear.
 */
export async function getFirmSeatStateCounts(
  pool: Pool,
  editionId: string,
): Promise<Array<{ organizationId: string; assigned: number; complete: number }>> {
  const result = await query<{ organization_id: string; assigned: string; complete: string }>(
    pool,
    `SELECT organization_id,
            COUNT(*) FILTER (WHERE state <> 'empty')::text  AS assigned,
            COUNT(*) FILTER (WHERE state = 'complete')::text AS complete
       FROM seat_assignments
      WHERE edition_id = $1
      GROUP BY organization_id`,
    [editionId],
  );
  return result.rows.map((r) => ({
    organizationId: r.organization_id,
    assigned: parseInt(r.assigned, 10),
    complete: parseInt(r.complete, 10),
  }));
}

/**
 * Per-firm matrix of WHICH firm-survey seats (S1/S2/S3) are complete for an
 * edition. Distinct from `getFirmSeatCompletionCounts` (which returns only a
 * count): the per-index population predicates need to know exactly which seats
 * cleared — OMI needs all three, DMI needs S1+S3 specifically. Only firms with
 * at least one seat row appear.
 */
export async function getFirmSeatCompletionMatrix(
  pool: Pool,
  editionId: string,
): Promise<Array<{ organizationId: string; completeSeats: string[] }>> {
  const result = await query<{ organization_id: string; complete_seats: string[] | null }>(
    pool,
    `SELECT organization_id,
            ARRAY_AGG(seat_code ORDER BY seat_code) FILTER (WHERE state = 'complete') AS complete_seats
       FROM seat_assignments
      WHERE edition_id = $1
      GROUP BY organization_id
      ORDER BY organization_id`,
    [editionId],
  );
  return result.rows.map((r) => ({
    organizationId: r.organization_id,
    completeSeats: r.complete_seats ?? [],
  }));
}

/**
 * The eligible responses that rated a specific firm — the scoring input for that
 * firm. Comes from every response that rated the firm, regardless of arrival
 * route (never firm_id-tagged outreach attribution). Returns respondent ids +
 * the response rows, for the traceability chain.
 */
export async function getResponsesRatingFirm(
  pool: Pool,
  editionId: string,
  firmId: string,
): Promise<Array<{ responseId: string; respondentId: string; questionId: string }>> {
  const result = await query<{ id: string; respondent_id: string; question_id: string }>(
    pool,
    `SELECT id, respondent_id, question_id
       FROM responses
      WHERE edition_id = $1 AND rated_firm_id = $2
      ORDER BY respondent_id, question_id`,
    [editionId, firmId],
  );
  return result.rows.map((r) => ({
    responseId: r.id,
    respondentId: r.respondent_id,
    questionId: r.question_id,
  }));
}

/** Distinct respondents who rated a firm — the firm's scored-sample size. */
export async function countRespondentsRatingFirm(
  pool: Pool,
  editionId: string,
  firmId: string,
): Promise<number> {
  const result = await query<{ n: string }>(
    pool,
    `SELECT COUNT(DISTINCT respondent_id)::text AS n
       FROM responses
      WHERE edition_id = $1 AND rated_firm_id = $2`,
    [editionId, firmId],
  );
  return parseInt(result.rows[0]?.n ?? '0', 10);
}

/** All response ids for an edition, ordered — the deterministic fingerprint of a
 *  frozen dataset (two runs over unchanged data hash identically; AT-02). */
export async function getEditionResponseIds(pool: Pool, editionId: string): Promise<string[]> {
  const result = await query<{ id: string }>(
    pool,
    'SELECT id FROM responses WHERE edition_id = $1 ORDER BY id',
    [editionId],
  );
  return result.rows.map((r) => r.id);
}

/** Numeric answers to the given questions across responses that rated a firm —
 *  the scoring input for a metric whose config names those question IDs. */
export async function getNumericAnswersForFirm(
  pool: Pool,
  editionId: string,
  firmId: string,
  questionIds: string[],
): Promise<number[]> {
  if (questionIds.length === 0) return [];
  const result = await query<{ v: string }>(
    pool,
    `SELECT (answer->>'a') AS v
       FROM responses
      WHERE edition_id = $1 AND rated_firm_id = $2
        AND question_id = ANY($3::text[])
        AND (answer->>'a') ~ '^-?[0-9]+(\\.[0-9]+)?$'`,
    [editionId, firmId, questionIds],
  );
  return result.rows.map((r) => Number(r.v)).filter((n) => Number.isFinite(n));
}

/** Distinct RETAIL (S4) respondents who rated a firm — the firm report's own
 *  retail-cut sample (FRM_04 gating). */
export async function countRetailRespondentsRatingFirm(
  pool: Pool,
  editionId: string,
  firmId: string,
): Promise<number> {
  const result = await query<{ n: string }>(
    pool,
    `SELECT COUNT(DISTINCT r.respondent_id)::text AS n
       FROM responses r
       JOIN respondents rp ON rp.id = r.respondent_id
      WHERE r.edition_id = $1 AND r.rated_firm_id = $2 AND rp.instrument_code = 'S4'`,
    [editionId, firmId],
  );
  return parseInt(result.rows[0]?.n ?? '0', 10);
}

/** The DRG-OPS question codes — the single source of truth for the evidence-pack
 *  exclusion check (reuses the Phase 2 is_drg_ops flag, never re-derived). */
export async function getDrgOpsQuestionCodes(pool: Pool): Promise<string[]> {
  const result = await query<{ question_code: string }>(
    pool,
    'SELECT question_code FROM instrument_questions WHERE is_drg_ops = TRUE ORDER BY question_code',
  );
  return result.rows.map((r) => r.question_code);
}

/** The instrument codes classified as institutional (contextual, never scored).
 *  Institutional instruments feed PUB_10 only, never an index input. */
export async function getInstitutionalInstrumentCodes(pool: Pool): Promise<string[]> {
  const result = await query<{ code: string }>(
    pool,
    `SELECT code FROM instrument_definitions WHERE instrument_type IN ('institutional','regulator') ORDER BY code`,
  );
  return result.rows.map((r) => r.code);
}

/** Question codes belonging to institutional/regulator instruments — the source
 *  of truth for the "institutional data is never an index input" evidence-pack
 *  check (never re-derived from a code prefix). */
export async function getInstitutionalQuestionCodes(pool: Pool): Promise<string[]> {
  const result = await query<{ question_code: string }>(
    pool,
    `SELECT q.question_code
       FROM instrument_questions q
       JOIN instrument_definitions d ON d.id = q.instrument_definition_id
      WHERE d.instrument_type IN ('institutional','regulator')
      ORDER BY q.question_code`,
  );
  return result.rows.map((r) => r.question_code);
}
