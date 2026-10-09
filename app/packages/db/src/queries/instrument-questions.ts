import { Pool } from 'pg';
import type { InstrumentQuestion, QuestionKind, QuestionScope } from '@cis/shared-types';
import type { SurveyItem } from '@cis/survey';
import { query } from '../client';

interface RawQuestionRow {
  id: string;
  instrument_definition_id: string;
  question_code: string;
  prompt_text: string;
  kind: string;
  scope: string;
  display_order: number;
  scored: boolean;
  is_drg_ops: boolean;
  is_placeholder: boolean;
  options: string[] | null;
  scale_min: number | null;
  scale_max: number | null;
  scale_anchors: string | null;
  rank_exactly_n: number | null;
  select_up_to_n: number | null;
  has_optional_comment: boolean;
  answer_optional: boolean;
  conditional_detail_on: string | null;
  select_then_greatest: boolean;
  grid_rows: string[] | null;
  grid_dimensions: Record<string, string[]> | null;
  grid_scale: { min: number; max: number } | null;
  created_at: Date;
}

function mapQuestion(row: RawQuestionRow): InstrumentQuestion {
  return {
    id: row.id,
    instrumentDefinitionId: row.instrument_definition_id,
    questionCode: row.question_code,
    promptText: row.prompt_text,
    kind: row.kind as QuestionKind,
    scope: row.scope as QuestionScope,
    displayOrder: row.display_order,
    scored: row.scored,
    isDrgOps: row.is_drg_ops,
    isPlaceholder: row.is_placeholder,
    options: row.options,
    scaleMin: row.scale_min,
    scaleMax: row.scale_max,
    scaleAnchors: row.scale_anchors,
    rankExactlyN: row.rank_exactly_n,
    selectUpToN: row.select_up_to_n,
    hasOptionalComment: row.has_optional_comment,
    answerOptional: row.answer_optional,
    conditionalDetailOn: row.conditional_detail_on,
    selectThenGreatest: row.select_then_greatest,
    gridRows: row.grid_rows,
    gridDimensions: row.grid_dimensions,
    gridScale: row.grid_scale,
    createdAt: row.created_at,
  };
}

/**
 * Map a stored question to the framework-agnostic SurveyItem the shared
 * renderer consumes. Optional fields are present only when non-null (respecting
 * exactOptionalPropertyTypes).
 */
export function toSurveyItem(q: InstrumentQuestion): SurveyItem {
  const item: SurveyItem = {
    id: q.questionCode,
    kind: q.kind,
    text: q.promptText,
    scope: q.scope,
    isDrgOps: q.isDrgOps,
    scored: q.scored,
  };
  if (q.options !== null) item.options = q.options;
  if (q.scaleMin !== null) item.scaleMin = q.scaleMin;
  if (q.scaleMax !== null) item.scaleMax = q.scaleMax;
  if (q.scaleAnchors !== null) item.scaleAnchors = q.scaleAnchors;
  if (q.rankExactlyN !== null) item.rankExactlyN = q.rankExactlyN;
  if (q.selectUpToN !== null) item.selectUpToN = q.selectUpToN;
  if (q.hasOptionalComment) item.hasOptionalComment = true;
  if (q.answerOptional) item.answerOptional = true;
  if (q.conditionalDetailOn !== null) item.conditionalDetailOn = q.conditionalDetailOn;
  if (q.selectThenGreatest) item.selectThenGreatest = true;
  if (q.gridRows !== null) item.gridRows = q.gridRows;
  if (q.gridDimensions !== null) item.gridDimensions = q.gridDimensions;
  if (q.gridScale !== null) item.gridScale = q.gridScale;
  return item;
}

export interface CreateInstrumentQuestionInput {
  instrumentDefinitionId: string;
  questionCode: string;
  promptText: string;
  kind: QuestionKind;
  scope?: QuestionScope;
  displayOrder?: number;
  scored?: boolean;
  isDrgOps?: boolean;
  isPlaceholder?: boolean;
  options?: string[] | null;
  scaleMin?: number | null;
  scaleMax?: number | null;
  scaleAnchors?: string | null;
  rankExactlyN?: number | null;
  selectUpToN?: number | null;
  hasOptionalComment?: boolean;
  answerOptional?: boolean;
  conditionalDetailOn?: string | null;
  selectThenGreatest?: boolean;
  gridRows?: string[] | null;
  gridDimensions?: Record<string, string[]> | null;
  gridScale?: { min: number; max: number } | null;
}

export async function createInstrumentQuestion(
  pool: Pool,
  data: CreateInstrumentQuestionInput,
): Promise<InstrumentQuestion> {
  // A DRG-OPS question is never scored — mirror the DB CHECK at the write path
  // so callers get a clear error rather than a raw constraint violation.
  const isDrgOps = data.isDrgOps ?? false;
  const scored = isDrgOps ? false : (data.scored ?? true);
  const jsonb = (v: unknown): string | null =>
    v === undefined || v === null ? null : JSON.stringify(v);
  const result = await query<RawQuestionRow>(
    pool,
    `INSERT INTO instrument_questions
       (instrument_definition_id, question_code, prompt_text, kind, scope,
        display_order, scored, is_drg_ops, is_placeholder, options,
        scale_min, scale_max, scale_anchors, rank_exactly_n, select_up_to_n,
        has_optional_comment, answer_optional, conditional_detail_on,
        select_then_greatest, grid_rows, grid_dimensions, grid_scale)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *`,
    [
      data.instrumentDefinitionId,
      data.questionCode,
      data.promptText,
      data.kind,
      data.scope ?? 'shared',
      data.displayOrder ?? 0,
      scored,
      isDrgOps,
      data.isPlaceholder ?? false,
      jsonb(data.options),
      data.scaleMin ?? null,
      data.scaleMax ?? null,
      data.scaleAnchors ?? null,
      data.rankExactlyN ?? null,
      data.selectUpToN ?? null,
      data.hasOptionalComment ?? false,
      data.answerOptional ?? false,
      data.conditionalDetailOn ?? null,
      data.selectThenGreatest ?? false,
      jsonb(data.gridRows),
      jsonb(data.gridDimensions),
      jsonb(data.gridScale),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Instrument question insert returned no rows');
  return mapQuestion(row);
}

/**
 * The full item set for one instrument (by code), DRG-OPS included, in the
 * SurveyItem shape the renderer consumes. This is the respondent runtime path —
 * a respondent answers every item, including the folded-in operational ones.
 */
export async function getInstrumentItems(
  pool: Pool,
  instrumentCode: string,
): Promise<SurveyItem[]> {
  const result = await query<RawQuestionRow>(
    pool,
    `SELECT q.*
       FROM instrument_questions q
       JOIN instrument_definitions d ON d.id = q.instrument_definition_id
      WHERE d.code = $1
      ORDER BY q.display_order, q.question_code`,
    [instrumentCode],
  );
  return result.rows.map((r) => toSurveyItem(mapQuestion(r)));
}

/**
 * Summary of the DRG-OPS operational questions for the operations panel:
 * which operational question folds into which instrument. Codes only — no
 * prompt text — since this is shown to study operators, not respondents.
 */
export async function listDrgOpsQuestionSummary(
  pool: Pool,
): Promise<Array<{ questionCode: string; instrumentCode: string; instrumentName: string }>> {
  const result = await query<{
    question_code: string;
    instrument_code: string;
    instrument_name: string;
  }>(
    pool,
    `SELECT q.question_code, d.code AS instrument_code, d.name AS instrument_name
       FROM instrument_questions q
       JOIN instrument_definitions d ON d.id = q.instrument_definition_id
      WHERE q.is_drg_ops = TRUE
      ORDER BY q.question_code`,
  );
  return result.rows.map((r) => ({
    questionCode: r.question_code,
    instrumentCode: r.instrument_code,
    instrumentName: r.instrument_name,
  }));
}

/** Every question for an instrument, DRG-OPS included. Internal/analysis use only. */
export async function getAllQuestionsForInstrument(
  pool: Pool,
  instrumentDefinitionId: string,
): Promise<InstrumentQuestion[]> {
  const result = await query<RawQuestionRow>(
    pool,
    `SELECT * FROM instrument_questions
     WHERE instrument_definition_id = $1
     ORDER BY display_order, question_code`,
    [instrumentDefinitionId],
  );
  return result.rows.map(mapQuestion);
}

/**
 * The ONE sanctioned accessor for public / firm-facing / report / evidence-pack
 * question content. The `is_drg_ops = FALSE` predicate is hardcoded here and is
 * the single place that answers "which questions may a respondent, firm, or
 * public report ever see". All seven DRG-OPS operational questions are
 * structurally incapable of being returned by this function.
 *
 * A defensive assertion re-checks the invariant at runtime: if a future edit
 * ever loosened the SQL, this throws rather than leaking a DRG-OPS row.
 */
export async function getPublicVisibleQuestions(pool: Pool): Promise<InstrumentQuestion[]> {
  const result = await query<RawQuestionRow>(
    pool,
    `SELECT q.*
       FROM instrument_questions q
       JOIN instrument_definitions d ON d.id = q.instrument_definition_id
      WHERE q.is_drg_ops = FALSE
      ORDER BY d.code, q.display_order, q.question_code`,
  );
  const rows = result.rows.map(mapQuestion);
  const leaked = rows.find((q) => q.isDrgOps);
  if (leaked) {
    throw new Error(
      `Invariant violation: public-question query returned DRG-OPS question ${leaked.questionCode}`,
    );
  }
  return rows;
}
