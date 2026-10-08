import { Pool } from 'pg';
import type { QuestionScope, Respondent, RespondentDraft, Response } from '@cis/shared-types';
import { query } from '../client';

interface RawDraftRow {
  id: string;
  respondent_id: string;
  question_id: string;
  scope: string;
  rated_firm_id: string | null;
  answer: { a: unknown; c?: string };
  updated_at: Date;
}

function mapDraft(row: RawDraftRow): RespondentDraft {
  return {
    id: row.id,
    respondentId: row.respondent_id,
    questionId: row.question_id,
    scope: row.scope as QuestionScope,
    ratedFirmId: row.rated_firm_id,
    answer: row.answer,
    updatedAt: row.updated_at,
  };
}

interface RawRespondentRow {
  id: string;
  edition_id: string;
  instrument_code: string;
  recruiting_firm_id: string | null;
  submitted_at: Date | null;
  consent_accepted: boolean;
  rated_firm_ids: string[];
  resume_step: number;
  referred_by_respondent_id: string | null;
  institution_name: string | null;
  contact_channel: 'email' | 'text' | 'both' | 'none' | null;
  contact_email: string | null;
  contact_phone: string | null;
  recovery_token: string | null;
  report_delivery: string | null;
  withdrawn_at: Date | null;
  created_at: Date;
}

interface RawResponseRow {
  id: string;
  edition_id: string;
  respondent_id: string;
  question_id: string;
  scope: string;
  rated_firm_id: string | null;
  answer: { a: unknown; c?: string };
  created_at: Date;
}

function mapRespondent(row: RawRespondentRow): Respondent {
  return {
    id: row.id,
    editionId: row.edition_id,
    instrumentCode: row.instrument_code,
    recruitingFirmId: row.recruiting_firm_id,
    submittedAt: row.submitted_at,
    consentAccepted: row.consent_accepted,
    ratedFirmIds: row.rated_firm_ids,
    resumeStep: row.resume_step,
    referredByRespondentId: row.referred_by_respondent_id,
    institutionName: row.institution_name,
    contactChannel: row.contact_channel,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    recoveryToken: row.recovery_token,
    reportDelivery: row.report_delivery,
    withdrawnAt: row.withdrawn_at,
    createdAt: row.created_at,
  };
}

function mapResponse(row: RawResponseRow): Response {
  return {
    id: row.id,
    editionId: row.edition_id,
    respondentId: row.respondent_id,
    questionId: row.question_id,
    scope: row.scope as QuestionScope,
    ratedFirmId: row.rated_firm_id,
    answer: row.answer,
    createdAt: row.created_at,
  };
}

export async function createRespondent(
  pool: Pool,
  data: {
    editionId: string;
    instrumentCode: string;
    recruitingFirmId?: string | null;
    consentAccepted?: boolean;
    ratedFirmIds?: string[];
    referredByRespondentId?: string | null;
    institutionName?: string | null;
  },
): Promise<Respondent> {
  const result = await query<RawRespondentRow>(
    pool,
    `INSERT INTO respondents
       (edition_id, instrument_code, recruiting_firm_id, consent_accepted,
        rated_firm_ids, referred_by_respondent_id, institution_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.editionId,
      data.instrumentCode,
      data.recruitingFirmId ?? null,
      data.consentAccepted ?? false,
      JSON.stringify(data.ratedFirmIds ?? []),
      data.referredByRespondentId ?? null,
      data.institutionName ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Respondent insert returned no rows');
  return mapRespondent(row);
}

/** Update mutable journey state (rated-firm list + resume step). Consent, once
 *  accepted, is set here too — the response record itself stays immutable. */
export async function updateRespondentJourney(
  pool: Pool,
  id: string,
  data: {
    ratedFirmIds?: string[];
    resumeStep?: number;
    consentAccepted?: boolean;
  },
): Promise<Respondent> {
  const result = await query<RawRespondentRow>(
    pool,
    `UPDATE respondents
       SET rated_firm_ids   = COALESCE($2, rated_firm_ids),
           resume_step      = COALESCE($3, resume_step),
           consent_accepted = COALESCE($4, consent_accepted)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      data.ratedFirmIds === undefined ? null : JSON.stringify(data.ratedFirmIds),
      data.resumeStep ?? null,
      data.consentAccepted ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Respondent ${id} not found`);
  return mapRespondent(row);
}

/**
 * Firm-side respondent completion STATUS for a firm — status only, never any
 * answer content. This is the sole firm-facing view of its respondents: it
 * returns who was set to answer and whether they submitted, and structurally
 * cannot return an individual answer (it never selects from responses).
 */
export async function getFirmRespondentStatuses(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<Array<{ respondentId: string; instrumentCode: string; submitted: boolean }>> {
  const result = await query<{
    id: string;
    instrument_code: string;
    submitted: boolean;
  }>(
    pool,
    `SELECT id, instrument_code, (submitted_at IS NOT NULL) AS submitted
       FROM respondents
      WHERE edition_id = $1 AND recruiting_firm_id = $2
      ORDER BY instrument_code`,
    [editionId, organizationId],
  );
  return result.rows.map((r) => ({
    respondentId: r.id,
    instrumentCode: r.instrument_code,
    submitted: r.submitted,
  }));
}

export async function getRespondentById(pool: Pool, id: string): Promise<Respondent | null> {
  const result = await query<RawRespondentRow>(pool, 'SELECT * FROM respondents WHERE id = $1', [
    id,
  ]);
  const row = result.rows[0];
  return row ? mapRespondent(row) : null;
}

export async function markRespondentSubmitted(pool: Pool, id: string): Promise<void> {
  await query(pool, 'UPDATE respondents SET submitted_at = NOW() WHERE id = $1', [id]);
}

/**
 * A genuine withdrawal (UX-X-001), distinct from Phase 17's reminders_opted_out
 * (which is explicitly NOT withdrawal). Setting this flag is the only thing
 * this function does — no self-service withdrawal request/approval flow is
 * built here, per the artefact's explicit scope boundary.
 */
export async function markRespondentWithdrawn(pool: Pool, id: string): Promise<void> {
  await query(pool, 'UPDATE respondents SET withdrawn_at = NOW() WHERE id = $1', [id]);
}

/**
 * Insert one immutable response row. `ratedFirmId` must be null for shared items
 * and a firm id for firm-specific items (enforced by a DB CHECK). Duplicate
 * (respondent, question, rated firm) rows are rejected by a unique index — there
 * are no overwrites.
 */
export async function insertResponse(
  pool: Pool,
  data: {
    editionId: string;
    respondentId: string;
    questionId: string;
    scope: QuestionScope;
    ratedFirmId: string | null;
    answer: { a: unknown; c?: string };
  },
): Promise<Response> {
  const result = await query<RawResponseRow>(
    pool,
    `INSERT INTO responses (edition_id, respondent_id, question_id, scope, rated_firm_id, answer)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.editionId,
      data.respondentId,
      data.questionId,
      data.scope,
      data.ratedFirmId,
      JSON.stringify(data.answer),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Response insert returned no rows');
  return mapResponse(row);
}

export async function getResponsesForRespondent(
  pool: Pool,
  respondentId: string,
): Promise<Response[]> {
  const result = await query<RawResponseRow>(
    pool,
    'SELECT * FROM responses WHERE respondent_id = $1 ORDER BY question_id, rated_firm_id',
    [respondentId],
  );
  return result.rows.map(mapResponse);
}

// ─── Drafts (mutable, autosave) ────────────────────────────────────────────────

export async function upsertDraft(
  pool: Pool,
  data: {
    respondentId: string;
    questionId: string;
    scope: QuestionScope;
    ratedFirmId: string | null;
    answer: { a: unknown; c?: string };
  },
): Promise<RespondentDraft> {
  const result = await query<RawDraftRow>(
    pool,
    `INSERT INTO respondent_drafts (respondent_id, question_id, scope, rated_firm_id, answer)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (respondent_id, question_id, rated_firm_id)
       DO UPDATE SET answer = EXCLUDED.answer, updated_at = NOW()
     RETURNING *`,
    [data.respondentId, data.questionId, data.scope, data.ratedFirmId, JSON.stringify(data.answer)],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Draft upsert returned no rows');
  return mapDraft(row);
}

export async function listDraftsForRespondent(
  pool: Pool,
  respondentId: string,
): Promise<RespondentDraft[]> {
  const result = await query<RawDraftRow>(
    pool,
    'SELECT * FROM respondent_drafts WHERE respondent_id = $1 ORDER BY question_id, rated_firm_id',
    [respondentId],
  );
  return result.rows.map(mapDraft);
}

// ─── Contact / recovery / report delivery (respondent, mutable) ─────────────────

export async function setRespondentContact(
  pool: Pool,
  id: string,
  data: {
    channel: 'email' | 'text' | 'both' | 'none';
    email?: string | null;
    phone?: string | null;
    recoveryToken?: string | null;
    reportDelivery?: string | null;
  },
): Promise<Respondent> {
  const result = await query<RawRespondentRow>(
    pool,
    `UPDATE respondents
       SET contact_channel = $2,
           contact_email = $3,
           contact_phone = $4,
           recovery_token = COALESCE($5, recovery_token),
           report_delivery = COALESCE($6, report_delivery)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      data.channel,
      data.email ?? null,
      data.phone ?? null,
      data.recoveryToken ?? null,
      data.reportDelivery ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Respondent ${id} not found`);
  return mapRespondent(row);
}

/** Change only the report-delivery preference (UX-RET-008) — answers untouched. */
export async function setReportDelivery(
  pool: Pool,
  id: string,
  data: { reportDelivery: string; email?: string | null; phone?: string | null },
): Promise<Respondent> {
  const result = await query<RawRespondentRow>(
    pool,
    `UPDATE respondents
       SET report_delivery = $2,
           contact_email = COALESCE($3, contact_email),
           contact_phone = COALESCE($4, contact_phone)
     WHERE id = $1
     RETURNING *`,
    [id, data.reportDelivery, data.email ?? null, data.phone ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Respondent ${id} not found`);
  return mapRespondent(row);
}

/** Kill a respondent's recovery token so its survey link no longer resolves
 *  (used by a regulator referral: the earlier link dies with its partial answers). */
export async function revokeRespondentToken(pool: Pool, id: string): Promise<void> {
  await query(pool, 'UPDATE respondents SET recovery_token = NULL WHERE id = $1', [id]);
}

export async function getRespondentByRecoveryToken(
  pool: Pool,
  token: string,
): Promise<Respondent | null> {
  const result = await query<RawRespondentRow>(
    pool,
    'SELECT * FROM respondents WHERE recovery_token = $1',
    [token],
  );
  const row = result.rows[0];
  return row ? mapRespondent(row) : null;
}

/** Distinct rated-firm ids a respondent produced answers for (never includes null). */
export async function getRatedFirmsForRespondent(
  pool: Pool,
  respondentId: string,
): Promise<string[]> {
  const result = await query<{ rated_firm_id: string }>(
    pool,
    `SELECT DISTINCT rated_firm_id FROM responses
     WHERE respondent_id = $1 AND rated_firm_id IS NOT NULL
     ORDER BY rated_firm_id`,
    [respondentId],
  );
  return result.rows.map((r) => r.rated_firm_id);
}
