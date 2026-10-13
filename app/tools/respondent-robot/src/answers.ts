import type { AnswerValue, GridAnswer, SurveyItem } from '@cis/survey';
import { Rng, clamp } from './rng';

/**
 * Answer generation for every question kind the shared renderer supports,
 * producing exactly the shapes its controls write (apps/admin/src/renderer/
 * controls.tsx), wrapped in the canonical `{a, c?}` envelope:
 *
 *   scale  → number               single → option string
 *   yesno  → {v, detail?}          select → string[]  (or {picked, greatest})
 *   multi  → string[]              rank   → exactly-N ordered string[]
 *   grid   → {row: {column: value-string}}
 *   open   → string
 *
 * What a respondent says is tilted by a target "goodness" in [0, 1] — the
 * rated firm's quality (firm-specific items) or the respondent's general
 * disposition (shared items) — so good firms score well and weak firms badly.
 * Lazy respondents do not tilt: a straight-liner gives the same position every
 * time; a speeder answers at random with the least effort the form accepts.
 */

export type Persona =
  | { kind: 'normal' }
  | { kind: 'speeder' }
  /** `position` in [0, 1]: 0 = always the first option / the bottom of a scale. */
  | { kind: 'straightliner'; position: number };

export interface AnswerContext {
  rng: Rng;
  persona: Persona;
  /** Target goodness in [0, 1]; null = no opinion tilt (uniform choice). */
  goodness: number | null;
}

/** Scales where a HIGH number is BAD (scoring transform N2). */
export const NEGATIVE_SCALES = new Set(['S1-Q5', 'S2-Q1']);

/** Yes/No items are all "has a failure ever ...?" — "Yes" is the adverse answer. */
const YES_IS_ADVERSE = true;

/** Options that are a non-answer for scoring ("missing", never imputed). */
const NEUTRAL = new Set(['Don’t know', "Don't know", 'Not applicable', 'Unable to assess']);

/**
 * How good each known ordinal label is, 0 (worst) .. 1 (best), following the
 * scoring transforms N3–N8 and the obvious reading of the other scales in the
 * Survey Register. Unknown labels return null (no tilt for that item).
 */
const GOODNESS: Record<string, number> = {
  // N3 adverse frequency, and the other frequency scales of an adverse event
  'Very frequently': 0,
  Frequently: 0.25,
  Occasionally: 0.5,
  Rarely: 0.75,
  Never: 1,
  'Almost always': 0,
  'Every time': 0,
  Often: 0.25,
  Sometimes: 0.5,
  'Almost never': 1,
  // N5 performance
  Poor: 0,
  'Below average': 0.25,
  Average: 0.5,
  Good: 0.75,
  Excellent: 1,
  // N6 risk
  'Very high': 0,
  High: 0.25,
  Moderate: 0.5,
  Low: 0.75,
  'Very low': 1,
  // N7 key-person dependency
  'Severe disruption, critical processes may stop': 0,
  'Major disruption': 0.25,
  'Moderate disruption': 0.5,
  'Minor disruption': 0.75,
  'Little or no impact': 1,
  // capability
  'Very weak': 0,
  Weak: 0.25,
  Adequate: 0.5,
  Strong: 0.75,
  'Very strong': 1,
  // comparisons
  'Significantly worse': 0,
  'Somewhat worse': 0.25,
  'About the same': 0.5,
  'Somewhat better': 0.75,
  'Significantly better': 1,
  Worse: 0,
  Same: 0.5,
  Better: 1,
  // documentation failures (S2-Q6)
  'Yes, more than once': 0,
  'Yes, once': 0.4,
  No: 1,
};

/** Goodness of an option label, or null when it has no known ordering. */
export function optionGoodness(label: string): number | null {
  if (label in GOODNESS) return GOODNESS[label] ?? null;
  // N4 manual-process bands: the less manual, the better.
  const band = /^(\d+) to (\d+)%$/.exec(label);
  if (band) return 1 - (Number(band[1]) + Number(band[2])) / 200;
  if (/^More than (\d+)%$/.test(label)) return 0.05;
  return null;
}

/** Pick from `options` near the target goodness; uniform when unordered. */
function pickOrdinal(options: string[], ctx: AnswerContext): string {
  const { rng, persona } = ctx;
  if (options.length === 0) throw new Error('An option question with no options');
  if (persona.kind === 'straightliner') {
    return options[Math.round(persona.position * (options.length - 1))] as string;
  }
  const scored = options.filter((o) => !NEUTRAL.has(o));
  const neutral = options.filter((o) => NEUTRAL.has(o));
  const known = scored.map(optionGoodness);
  if (persona.kind === 'speeder' || ctx.goodness === null || known.some((g) => g === null)) {
    return rng.pick(options);
  }
  // Now and then a real respondent can't say.
  if (neutral.length > 0 && rng.chance(0.04)) return rng.pick(neutral);
  const target = ctx.goodness;
  const weights = known.map((g) => Math.exp(-(((g as number) - target) ** 2) / (2 * 0.18 ** 2)));
  return scored[rng.weightedIndex(weights)] as string;
}

function scaleValue(min: number, max: number, goodness: number, ctx: AnswerContext): number {
  const { rng, persona } = ctx;
  if (persona.kind === 'straightliner') return Math.round(min + persona.position * (max - min));
  if (persona.kind === 'speeder') return rng.int(min, max);
  const x = min + goodness * (max - min) + rng.normal(0, (max - min) / 10);
  return Math.round(clamp(x, min, max));
}

const OPEN_GOOD = [
  'Faster onboarding and quicker responses when I call.',
  'Keep the statements coming on time; they have been reliable.',
  'More digital self-service would make a good service even better.',
  'Clearer fee breakdowns on contract notes.',
  'Nothing major, the service has been consistent.',
];
const OPEN_MID = [
  'Fewer repeated requests for the same KYC documents.',
  'Quicker updates on the status of share transfers.',
  'Better coordination between the dealing desk and back office.',
  'A single point of contact who follows issues through.',
  'Reconciliation of holdings could be faster.',
];
const OPEN_BAD = [
  'Settlement delays and no one explains what is happening.',
  'Statements are late and sometimes wrong.',
  'It takes weeks to resolve simple account issues.',
  'Calls and emails go unanswered for days.',
  'Records do not match what the depository shows.',
];
const DETAIL = [
  'A settlement was delayed by several days without explanation.',
  'Documents had to be resubmitted twice before the account was updated.',
  'A corporate-action entitlement was credited late.',
  'Trade confirmations did not match the instruction.',
];
const COMMENTS = [
  'Hard to judge for every case.',
  'This has improved over the past year.',
  'Varies with the person handling the account.',
];

function openText(ctx: AnswerContext): string {
  const { rng, persona } = ctx;
  if (persona.kind === 'straightliner') return 'No comment.';
  if (persona.kind === 'speeder') return rng.pick(['ok', 'fine', 'nothing', 'n/a']);
  const g = ctx.goodness ?? 0.5;
  return rng.pick(g >= 0.65 ? OPEN_GOOD : g >= 0.4 ? OPEN_MID : OPEN_BAD);
}

/** Options for one grid column, exactly as GridControl lists them. */
export function gridColumnOptions(item: SurveyItem, column: string): string[] {
  if (item.gridDimensions) return item.gridDimensions[column] ?? [];
  if (item.gridScale) {
    const out: string[] = [];
    for (let i = item.gridScale.min; i <= item.gridScale.max; i++) out.push(String(i));
    return out;
  }
  return item.options ?? [];
}

export function gridColumns(item: SurveyItem): string[] {
  return item.gridDimensions ? Object.keys(item.gridDimensions) : ['Rating'];
}

function gridAnswer(item: SurveyItem, ctx: AnswerContext): GridAnswer {
  const out: GridAnswer = {};
  for (const row of item.gridRows ?? []) {
    const cells: Record<string, string> = {};
    for (const col of gridColumns(item)) {
      const opts = gridColumnOptions(item, col);
      if (item.gridScale && !item.gridDimensions) {
        const v = scaleValue(item.gridScale.min, item.gridScale.max, ctx.goodness ?? 0.5, ctx);
        cells[col] = String(v);
      } else {
        cells[col] = pickOrdinal(opts, ctx);
      }
    }
    out[row] = cells;
  }
  return out;
}

function chooseCount(cap: number, ctx: AnswerContext): number {
  if (ctx.persona.kind !== 'normal') return 1;
  return Math.max(1, Math.min(cap, ctx.rng.weightedIndex([0, 0.25, 0.4, 0.35]) || 1));
}

function firstOrSample(options: string[], k: number, ctx: AnswerContext): string[] {
  if (ctx.persona.kind === 'straightliner') {
    const start = Math.round(ctx.persona.position * Math.max(0, options.length - k));
    return options.slice(start, start + k);
  }
  return ctx.rng.sample(options, k);
}

/**
 * The answer one respondent gives to one item, or null to leave it blank (only
 * ever for an item the register marks optional).
 */
export function generateAnswer(item: SurveyItem, ctx: AnswerContext): AnswerValue | null {
  const { rng, persona } = ctx;
  const goodness = ctx.goodness ?? 0.5;
  let a: unknown;

  switch (item.kind) {
    case 'scale': {
      const min = item.scaleMin ?? 1;
      const max = item.scaleMax ?? 10;
      const g = NEGATIVE_SCALES.has(item.id) ? 1 - goodness : goodness;
      a = scaleValue(min, max, ctx.goodness === null ? rng.next() : g, ctx);
      break;
    }
    case 'single':
      a = pickOrdinal(item.options ?? [], ctx);
      break;
    case 'yesno': {
      let v: string;
      if (persona.kind === 'straightliner') v = persona.position < 0.5 ? 'Yes' : 'No';
      else if (persona.kind === 'speeder') v = rng.chance(0.5) ? 'Yes' : 'No';
      else {
        const pAdverse = 0.04 + 0.6 * (1 - goodness) ** 1.6;
        const adverse = rng.chance(pAdverse);
        v = adverse === YES_IS_ADVERSE ? 'Yes' : 'No';
      }
      a =
        item.conditionalDetailOn && v === item.conditionalDetailOn
          ? { v, detail: persona.kind === 'normal' ? rng.pick(DETAIL) : 'Delay.' }
          : { v };
      break;
    }
    case 'select': {
      const opts = item.options ?? [];
      const picked = firstOrSample(opts, chooseCount(item.selectUpToN ?? 3, ctx), ctx);
      a = item.selectThenGreatest
        ? { picked, greatest: persona.kind === 'straightliner' ? picked[0] : rng.pick(picked) }
        : picked;
      break;
    }
    case 'multi': {
      const opts = item.options ?? [];
      a = firstOrSample(opts, chooseCount(Math.min(4, opts.length), ctx), ctx);
      break;
    }
    case 'rank': {
      const n = item.rankExactlyN ?? 3;
      a = firstOrSample(item.options ?? [], n, ctx);
      break;
    }
    case 'grid':
      a = gridAnswer(item, ctx);
      break;
    case 'open':
      if (item.answerOptional && (persona.kind !== 'normal' || rng.chance(0.4))) return null;
      a = openText(ctx);
      break;
    default:
      throw new Error(`Unsupported question kind: ${String((item as SurveyItem).kind)}`);
  }

  const comment =
    item.hasOptionalComment && item.kind !== 'open' && persona.kind === 'normal' && rng.chance(0.08)
      ? rng.pick(COMMENTS)
      : undefined;
  return comment ? { a, c: comment } : { a };
}
