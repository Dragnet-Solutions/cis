import { Pool } from 'pg';
import { query } from '../client';

/**
 * Every submitted answer for an edition's report content, with the context the
 * report needs about who gave it. Withdrawn and unsubmitted respondents are
 * excluded — a report is built only from finished, standing responses.
 *
 * Unlike `getInvestorInstrumentAnswers` (which flattens the answer to text),
 * the answer keeps its structure: frictions, frustrations and the bank/fintech
 * comparison read multi-selects, rankings and grids.
 */
export interface ReportAnswerRow {
  respondentId: string;
  instrumentCode: string;
  questionId: string;
  /** The firm an investor's firm-specific answer is about. */
  ratedFirmId: string | null;
  /** A seat holder's own firm (S1–S3), or the firm whose link recruited an investor. */
  recruitingFirmId: string | null;
  institutionName: string | null;
  answer: unknown;
}

export async function listSubmittedAnswers(
  pool: Pool,
  editionId: string,
  instrumentCodes: string[],
): Promise<ReportAnswerRow[]> {
  const res = await query<{
    respondent_id: string;
    instrument_code: string;
    question_id: string;
    rated_firm_id: string | null;
    recruiting_firm_id: string | null;
    institution_name: string | null;
    answer: { a?: unknown } | null;
  }>(
    pool,
    `SELECT r.respondent_id, p.instrument_code, r.question_id, r.rated_firm_id,
            p.recruiting_firm_id, p.institution_name, r.answer
       FROM responses r
       JOIN respondents p ON p.id = r.respondent_id
      WHERE r.edition_id = $1
        AND p.instrument_code = ANY($2)
        AND p.submitted_at IS NOT NULL
        AND p.withdrawn_at IS NULL`,
    [editionId, instrumentCodes],
  );
  return res.rows.map((row) => ({
    respondentId: row.respondent_id,
    instrumentCode: row.instrument_code,
    questionId: row.question_id,
    ratedFirmId: row.rated_firm_id,
    recruitingFirmId: row.recruiting_firm_id,
    institutionName: row.institution_name,
    // Answers are stored as an envelope { a, c? }; the report reads the value.
    answer: row.answer && typeof row.answer === 'object' && 'a' in row.answer ? row.answer.a : null,
  }));
}

// ─── report_narratives ─────────────────────────────────────────────────────────

export interface NarrativeSentence {
  /** Which part of the report it belongs to (e.g. 'EXEC', 'PUB_03', 'F2'). */
  section: string;
  text: string;
  factIds: string[];
  /** Set when the checker held the sentence back; such a sentence is never shown. */
  finding: { kind: string; why: string } | null;
}

export interface NarrativeFact {
  id: string;
  /** REPORTABLE, or BANDED for a figure that must not be quoted as a point value. */
  state: string;
  statement: string;
  /** The numbers a sentence citing this fact may quote. */
  numbers: number[];
}

export interface ReportNarrative {
  id: string;
  editionId: string;
  kind: 'industry' | 'firm';
  subjectId: string | null;
  sentences: NarrativeSentence[];
  facts: NarrativeFact[];
  model: string;
  createdBy: string;
  createdAt: Date;
}

interface RawNarrativeRow {
  id: string;
  edition_id: string;
  kind: 'industry' | 'firm';
  subject_id: string | null;
  sentences: NarrativeSentence[];
  facts: NarrativeFact[];
  model: string;
  created_by: string;
  created_at: Date;
}

const mapNarrative = (r: RawNarrativeRow): ReportNarrative => ({
  id: r.id,
  editionId: r.edition_id,
  kind: r.kind,
  subjectId: r.subject_id,
  sentences: r.sentences,
  facts: r.facts,
  model: r.model,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export async function insertReportNarrative(
  pool: Pool,
  data: Omit<ReportNarrative, 'id' | 'createdAt'>,
): Promise<ReportNarrative> {
  const res = await query<RawNarrativeRow>(
    pool,
    `INSERT INTO report_narratives
       (edition_id, kind, subject_id, sentences, facts, model, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.editionId,
      data.kind,
      data.subjectId,
      JSON.stringify(data.sentences),
      JSON.stringify(data.facts),
      data.model,
      data.createdBy,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('report narrative insert returned no rows');
  return mapNarrative(row);
}

/** The narrative in force: the latest generation for this edition and subject. */
export async function getLatestReportNarrative(
  pool: Pool,
  editionId: string,
  kind: 'industry' | 'firm',
  subjectId: string | null,
): Promise<ReportNarrative | null> {
  const res = await query<RawNarrativeRow>(
    pool,
    `SELECT * FROM report_narratives
      WHERE edition_id = $1 AND kind = $2 AND subject_id IS NOT DISTINCT FROM $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [editionId, kind, subjectId],
  );
  return res.rows[0] ? mapNarrative(res.rows[0]) : null;
}

export async function getReportNarrativeById(
  pool: Pool,
  id: string,
): Promise<ReportNarrative | null> {
  const res = await query<RawNarrativeRow>(pool, 'SELECT * FROM report_narratives WHERE id = $1', [
    id,
  ]);
  return res.rows[0] ? mapNarrative(res.rows[0]) : null;
}

// ─── publications (what left CIS, frozen) ──────────────────────────────────────

export interface ReportPublication {
  id: string;
  editionId: string;
  kind: 'industry' | 'firm';
  subjectId: string | null;
  firmReportId: string | null;
  narrativeId: string;
  publishedBy: string;
  publishedAt: Date;
}

interface RawPublicationRow {
  id: string;
  edition_id: string;
  kind: 'industry' | 'firm';
  subject_id: string | null;
  firm_report_id: string | null;
  narrative_id: string;
  published_by: string;
  published_at: Date;
}

const mapPublication = (r: RawPublicationRow): ReportPublication => ({
  id: r.id,
  editionId: r.edition_id,
  kind: r.kind,
  subjectId: r.subject_id,
  firmReportId: r.firm_report_id,
  narrativeId: r.narrative_id,
  publishedBy: r.published_by,
  publishedAt: r.published_at,
});

/** Record a publication. Idempotent: a document already published keeps its first record. */
export async function insertReportPublication(
  pool: Pool,
  data: Omit<ReportPublication, 'id' | 'publishedAt'>,
): Promise<ReportPublication> {
  await query(
    pool,
    `INSERT INTO report_publications
       (edition_id, kind, subject_id, firm_report_id, narrative_id, published_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      data.editionId,
      data.kind,
      data.subjectId,
      data.firmReportId,
      data.narrativeId,
      data.publishedBy,
    ],
  );
  const published = await getReportPublication(pool, data.editionId, data.kind, data.subjectId);
  if (!published) throw new Error('report publication insert returned no rows');
  return published;
}

export async function getReportPublication(
  pool: Pool,
  editionId: string,
  kind: 'industry' | 'firm',
  subjectId: string | null,
): Promise<ReportPublication | null> {
  const res = await query<RawPublicationRow>(
    pool,
    `SELECT * FROM report_publications
      WHERE edition_id = $1 AND kind = $2 AND subject_id IS NOT DISTINCT FROM $3`,
    [editionId, kind, subjectId],
  );
  return res.rows[0] ? mapPublication(res.rows[0]) : null;
}

/** Every published Industry report, newest edition first — the public list. */
export async function listPublishedIndustryReports(
  pool: Pool,
): Promise<Array<{ editionId: string; editionLabel: string; publishedAt: Date }>> {
  const res = await query<{ edition_id: string; label: string; published_at: Date }>(
    pool,
    `SELECT p.edition_id, e.label, p.published_at
       FROM report_publications p
       JOIN editions e ON e.id = p.edition_id
      WHERE p.kind = 'industry'
      ORDER BY p.published_at DESC`,
  );
  return res.rows.map((r) => ({
    editionId: r.edition_id,
    editionLabel: r.label,
    publishedAt: r.published_at,
  }));
}
