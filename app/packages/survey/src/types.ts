/**
 * Runtime shape of a controlled Survey Register item, as consumed by the shared
 * renderer. This mirrors the fields the renderer reads — it is derived from the
 * `instrument_questions` table at runtime, never hardcoded (SV-010 §2).
 */

export type QuestionKind =
  'scale' | 'single' | 'yesno' | 'select' | 'multi' | 'rank' | 'grid' | 'open';

export type QuestionScope = 'shared' | 'firm_specific';

export interface SurveyItem {
  /** Register question ID (e.g. "S4-Q5"). Carried verbatim through storage. */
  id: string;
  kind: QuestionKind;
  text: string;
  scope: QuestionScope;
  isDrgOps: boolean;
  scored: boolean;

  options?: string[];
  scaleMin?: number;
  scaleMax?: number;
  scaleAnchors?: string;
  rankExactlyN?: number;
  selectUpToN?: number;
  /** Whether this item offers an optional free-text comment box. Item-driven. */
  hasOptionalComment?: boolean;
  /** Only S4-Q10: the item may be submitted blank. */
  answerOptional?: boolean;
  /** Yes/No detail is shown only when the answer equals this value. */
  conditionalDetailOn?: string;
  /** Select-then-greatest: a second single-choice step over what was chosen. */
  selectThenGreatest?: boolean;
  gridRows?: string[];
  gridDimensions?: Record<string, string[]>;
  gridScale?: { min: number; max: number };
}

/**
 * The canonical answer envelope for every item: `a` is the answer, `c` the
 * optional comment. Applied once at the boundary — a control only ever reads
 * and writes the `a` half; the comment box only ever the `c` half.
 */
export interface AnswerValue {
  a: unknown;
  c?: string;
}

/** Yes/No inner answer, with optional conditional detail. */
export interface YesNoAnswer {
  v: string;
  detail?: string;
}

/** Select-then-greatest inner answer. */
export interface SelectGreatestAnswer {
  picked: string[];
  greatest?: string;
}

/** Grid inner answer: row → column → chosen value. */
export type GridAnswer = Record<string, Record<string, string>>;
