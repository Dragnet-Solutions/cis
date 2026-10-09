import { Pool } from 'pg';
import {
  getCalculationRun,
  createCalculationRun,
  insertCalculatedResult,
  getFirmSideItemAnswers,
  getFirmAttributableInvestorAnswers,
  getInvestorInstrumentAnswers,
  getDmiRequiredItems,
  getDmiWeights,
  getOmiRoleItemGroups,
  getMethodologyMeta,
  methodologyVersionString,
  getTransform,
  createComparisonRun,
  getAuthoritativeSignoff,
  listCalculatedResults,
  type ComparisonRun,
} from '@cis/db';
import type { CalculationRun, CalculatedResultComposition } from '@cis/shared-types';
import { DomainError } from './errors';
import { datasetHashFor } from './calculation-service';
import { scoreItem, isSubstantive, applyTransform } from './scoring-transforms';
import { computeSufficiency, segmentDisplayState, REPORTABLE_AT } from './sufficiency-service';
import type { SegmentDisplayState } from '@cis/shared-types';

/**
 * CIS-SCORE-2026 v0.15 candidate scoring engine (Phase 11). Runs the real
 * candidate methodology, always under `TEST_UNAPPROVED`, and enforces the hard
 * gate that such output can never reach an official evidence pack, AI
 * generation or a released report. It also owns: item-level DMI/OMI
 * completeness, the §11 investor-side item-level completeness predicates,
 * firm-scope-safe investor aggregation, the privacy-safe pooled public
 * headline with its mandatory composition disclosure (reporting each
 * segment's standalone display state alongside, per Phase 21 §2.1/v0.15
 * `standalone_segment_display`), the Industry-SEI NOT_CALCULABLE block, and
 * the like-for-like cross-edition recalculation.
 *
 * Its numeric core — every weight, transform and threshold — is read from the
 * sole authoritative v0.15 YAML config (`CONFIG_FILENAME` in
 * `scoring-config.ts`); the v0.14 → v0.15 reconciliation (Phase 21 §2, closed
 * once the actual YAML was supplied and diffed directly) changed structure,
 * not numbers — see README "Phase 21 §2" for exactly what did and did not
 * change.
 *
 * "Build the framework now. Do not invent the methodology." Every weight,
 * transform and threshold is read from the sole authoritative YAML config.
 */

export class CandidateScoringError extends DomainError {
  constructor(message: string, code = 'CANDIDATE_SCORING') {
    super(message, code);
  }
}

// ─── The official-use hard gate (build note §2) ───────────────────────────────

/**
 * Throw unless the run may back official output. A run produced under a
 * `TEST_UNAPPROVED` methodology is REFUSED here — a hard validation failure, not
 * a label. Called at the boundary of every official-output path (evidence pack,
 * AI generation, national/public report, released firm report).
 */
export async function assertRunOfficialUsable(
  pool: Pool,
  runId: string,
  useContext: string,
): Promise<void> {
  const run = await getCalculationRun(pool, runId);
  if (!run) throw new CandidateScoringError(`Calculation run ${runId} not found`, 'NOT_FOUND');
  if (run.methodologyStatus === 'TEST_UNAPPROVED') {
    throw new CandidateScoringError(
      `Run ${runId} was produced under a TEST_UNAPPROVED methodology (${run.methodologyVersion}) ` +
        `and cannot feed ${useContext}. Await methodology approval.`,
      'TEST_UNAPPROVED_RUN',
    );
  }
}

// ─── Item-level completeness (corrects Phase 7's seat-level DMI proxy) ─────────

/**
 * DMI-complete firms: those with a VALID answer to each of S1-Q3, S1-Q8, S3-Q2
 * specifically (item-level, per the OPS-003 clarification) — NOT firms whose S1
 * and S3 seats are merely marked complete. A firm that left S1-Q8 unanswered is
 * excluded even if both seats are "complete".
 */
export async function dmiCompleteFirmIds(
  pool: Pool,
  editionId: string,
  asOf?: Date,
): Promise<string[]> {
  const required = getDmiRequiredItems();
  const rows = await getFirmSideItemAnswers(pool, editionId, required, asOf);
  const byFirm = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!isSubstantive(r.a)) continue;
    if (!byFirm.has(r.firmId)) byFirm.set(r.firmId, new Set());
    byFirm.get(r.firmId)!.add(r.questionId);
  }
  const complete: string[] = [];
  for (const [firmId, items] of byFirm) {
    if (required.every((q) => items.has(q))) complete.push(firmId);
  }
  return complete;
}

/**
 * OMI-complete firms (item-level): a firm is OMI-complete when EACH of the three
 * OMI role sub-indices (CEO, Compliance, Operations) is calculable — i.e. has at
 * least one substantive contributing item — per `all_three_role_subindices_required`.
 * A firm participating with, say, no Compliance-seat answers is excluded even if
 * its CEO and Operations answers are complete.
 */
export async function omiCompleteFirmIds(
  pool: Pool,
  editionId: string,
  asOf?: Date,
): Promise<string[]> {
  const roles = getOmiRoleItemGroups();
  const allItems = Array.from(new Set(Object.values(roles).flat()));
  const rows = await getFirmSideItemAnswers(pool, editionId, allItems, asOf);
  const byFirm = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!isSubstantive(r.a)) continue;
    if (!byFirm.has(r.firmId)) byFirm.set(r.firmId, new Set());
    byFirm.get(r.firmId)!.add(r.questionId);
  }
  const roleEntries = Object.entries(roles);
  const complete: string[] = [];
  for (const [firmId, answered] of byFirm) {
    const everyRoleCalculable = roleEntries.every(([, items]) =>
      items.some((q) => answered.has(q)),
    );
    if (everyRoleCalculable) complete.push(firmId);
  }
  return complete;
}

/**
 * Which OMI roles a firm is missing (has zero substantive contributing items
 * for), across the edition. Drives the mission board's missing-role counts so a
 * "Compliance-seat gap" reads distinctly from a raw participation shortfall.
 */
export async function missingOmiRoleCounts(
  pool: Pool,
  editionId: string,
  asOf?: Date,
): Promise<Record<string, number>> {
  const roles = getOmiRoleItemGroups();
  const allItems = Array.from(new Set(Object.values(roles).flat()));
  const rows = await getFirmSideItemAnswers(pool, editionId, allItems, asOf);
  const byFirm = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!isSubstantive(r.a)) continue;
    if (!byFirm.has(r.firmId)) byFirm.set(r.firmId, new Set());
    byFirm.get(r.firmId)!.add(r.questionId);
  }
  const counts: Record<string, number> = {};
  for (const role of Object.keys(roles)) counts[role] = 0;
  for (const [, answered] of byFirm) {
    for (const [role, items] of Object.entries(roles)) {
      if (!items.some((q) => answered.has(q))) counts[role] = (counts[role] ?? 0) + 1;
    }
  }
  return counts;
}

/** Per-firm Firm_DMI = Σ weightᵢ · transform(itemᵢ), over DMI-complete firms. */
export async function firmDmiScores(
  pool: Pool,
  editionId: string,
): Promise<Array<{ firmId: string; score: number }>> {
  const required = getDmiRequiredItems();
  const weights = getDmiWeights();
  const rows = await getFirmSideItemAnswers(pool, editionId, required);
  const byFirm = new Map<string, Map<string, string | null>>();
  for (const r of rows) {
    if (!byFirm.has(r.firmId)) byFirm.set(r.firmId, new Map());
    byFirm.get(r.firmId)!.set(r.questionId, r.a);
  }
  const out: Array<{ firmId: string; score: number }> = [];
  for (const [firmId, items] of byFirm) {
    const scores = required.map((q) => scoreItem(q, items.get(q)));
    if (scores.some((s) => s === null)) continue; // not DMI-complete
    let score = 0;
    for (const q of required) score += (weights[q] ?? 0) * (scoreItem(q, items.get(q)) as number);
    out.push({ firmId, score });
  }
  return out;
}

// ─── §11 investor-side item-level completeness (v0.15 follow-up) ──────────────
//
// No prior version of this codebase computed per-investor-relationship
// eligibility for these six index-completeness rules — `pooledHeadline` and
// `computeLikeForLike` below are pure aggregators that have always taken
// already-filtered unit scores as their input; nothing yet produces those
// scores from raw survey answers (confirmed by search: no caller of either
// function exists in this codebase outside tests). These six pure predicates
// are the exact §11 rule each eventual investor-unit-score reader must apply
// — built and tested now, against the methodology spec's table, so that
// pipeline is wired against the correct partial-completeness allowances from
// day one, rather than a full-completeness assumption that would silently
// exclude genuinely eligible responses (the risk this follow-up flagged).
// Each takes already-fetched raw answer values; none reads the database or
// knows how a grid answer is stored — that remains the caller's job.
// Reuses `isSubstantive` throughout — never a re-derived missing-data check.

export interface RetailIeiAnswers {
  q1: unknown;
  q2: unknown;
  q3: unknown;
}
/** Retail IEI (§11): S4-Q1, S4-Q2 and S4-Q3 all required — no partial allowance. */
export function retailIeiEligible(a: RetailIeiAnswers): boolean {
  return isSubstantive(a.q1) && isSubstantive(a.q2) && isSubstantive(a.q3);
}

export interface RetailIciAnswers {
  q4: unknown;
  q5: unknown;
  q6: unknown;
  q7: unknown;
}
/** Retail ICI (§11): S4-Q4 required, PLUS at least 2 of the behavioural bundle
 *  (S4-Q5/Q6/Q7) — the explicit partial allowance this follow-up flagged. */
export function retailIciEligible(a: RetailIciAnswers): boolean {
  if (!isSubstantive(a.q4)) return false;
  const behavioural = [a.q5, a.q6, a.q7].filter(isSubstantive).length;
  return behavioural >= 2;
}

export interface LocalIeiAnswers {
  /** The four S5a-Q1 grid-row values (service quality, reporting quality,
   *  responsiveness, operational efficiency), however the caller parsed the
   *  grid answer — this function only counts how many are substantive. */
  q1Attributes: unknown[];
  q2: unknown;
}
/** Local IEI (§11): at least 3 of the 4 S5a-Q1 attributes, PLUS S5a-Q2 — the
 *  other explicit partial allowance this follow-up flagged. */
export function localIeiEligible(a: LocalIeiAnswers): boolean {
  const attributeCount = a.q1Attributes.filter(isSubstantive).length;
  return attributeCount >= 3 && isSubstantive(a.q2);
}

export interface LocalIciAnswers {
  q5: unknown;
  q6: unknown;
}
/** Local ICI (§11): S5a-Q5 and S5a-Q6 both required — no partial allowance. */
export function localIciEligible(a: LocalIciAnswers): boolean {
  return isSubstantive(a.q5) && isSubstantive(a.q6);
}

export interface ForeignIeiAnswers {
  q1: unknown;
  /** The institution-level aggregate of firm-specific Q2
   *  (`aggregate_firm_specific_within_institution: mean`) — null when no
   *  contributing firm-specific answer exists yet, never invented as 0. */
  aggregatedQ2: number | null;
  aggregatedQ3: number | null;
}
/** Foreign IEI (§11): S5b-Q1 (shared) plus BOTH aggregated Q2 and Q3 — no
 *  partial allowance; an absent aggregate fails it, same as a missing item. */
export function foreignIeiEligible(a: ForeignIeiAnswers): boolean {
  return isSubstantive(a.q1) && a.aggregatedQ2 !== null && a.aggregatedQ3 !== null;
}

export interface ForeignIciAnswers {
  aggregatedQ4: number | null;
  q8: unknown;
}
/** Foreign ICI (§11): aggregated Q4 plus S5b-Q8 — no partial allowance. */
export function foreignIciEligible(a: ForeignIciAnswers): boolean {
  return a.aggregatedQ4 !== null && isSubstantive(a.q8);
}

// ─── §7/§8 relationship-level investor scores (Phase 22) ──────────────────────
//
// ONE implementation of each relationship score, shared by the firm-side
// consumer (§7.4/§8.4 Firm_Investor_IEI_f/Firm_ICI_f, below) and the
// national-side consumer (§7.1-7.3/§8.1-8.3 investor-unit scores, below) —
// never two. Each applies its §11 eligibility predicate first (missing items
// are EXCLUDED from the mean, never imputed to neutral — §11 principle 5);
// ineligible returns null.

function meanValid(scores: ReadonlyArray<number | null>): number | null {
  const valid = scores.filter((s): s is number => s !== null);
  return valid.length === 0 ? null : valid.reduce((a, b) => a + b, 0) / valid.length;
}

/** Retail_IEI_relationship = mean(S4-Q1, S4-Q2, S4-Q3) (§7.1). */
export function retailIeiRelationshipScore(a: RetailIeiAnswers): number | null {
  if (!retailIeiEligible(a)) return null;
  return meanValid([scoreItem('S4-Q1', a.q1), scoreItem('S4-Q2', a.q2), scoreItem('S4-Q3', a.q3)]);
}

/** Retail_ICI_relationship = 0.50(S4-Q4) + 0.50(mean of valid S4-Q5/Q6/Q7) (§8.1). */
export function retailIciRelationshipScore(a: RetailIciAnswers): number | null {
  if (!retailIciEligible(a)) return null;
  const q4 = scoreItem('S4-Q4', a.q4);
  const behavioural = meanValid([
    scoreItem('S4-Q5', a.q5),
    scoreItem('S4-Q6', a.q6),
    scoreItem('S4-Q7', a.q7),
  ]);
  if (q4 === null || behavioural === null) return null; // defensive; eligibility already guarantees this
  return 0.5 * q4 + 0.5 * behavioural;
}

/** S5a-Q1's four grid rows share ONE transform (methodology §4: `S5a-Q1.* →
 *  N1`) — there is no per-attribute binding to look up by dotted code (unlike
 *  S3-Q4's two NAMED dimensions), so the transform is applied directly. */
function scoreS5aQ1Attribute(raw: unknown): number | null {
  const transform = getTransform('N1');
  return transform ? applyTransform(transform, raw) : null;
}

/** Local_IEI_relationship = mean(S5a-Q1_composite, S5a-Q2); S5a-Q1_composite =
 *  mean(valid defined S5a-Q1 attributes) (§7.2). */
export function localIeiRelationshipScore(a: LocalIeiAnswers): number | null {
  if (!localIeiEligible(a)) return null;
  const q1Composite = meanValid(a.q1Attributes.map(scoreS5aQ1Attribute));
  return meanValid([q1Composite, scoreItem('S5a-Q2', a.q2)]);
}

/** Local_ICI_relationship = mean(S5a-Q5, S5a-Q6 after transforms) (§8.2). */
export function localIciRelationshipScore(a: LocalIciAnswers): number | null {
  if (!localIciEligible(a)) return null;
  return meanValid([scoreItem('S5a-Q5', a.q5), scoreItem('S5a-Q6', a.q6)]);
}

/**
 * Foreign is computed DIRECTLY per institution, never relationship-then-
 * collapsed (§7.3/§8.3 are explicit that this is a deliberately different
 * shape from retail/local). `q2Values`/`q3Values`/`q4Values` are every
 * firm-specific raw value for that institution across every firm it rated;
 * `Q2_i`/`Q3_i`/`Q4_i` are their means, computed here before eligibility.
 */
export interface ForeignInstitutionRaw {
  q1: unknown;
  q2Values: unknown[];
  q3Values: unknown[];
  q4Values: unknown[];
  q8: unknown;
}

/** Foreign_IEI_unit_i = mean(S5b-Q1_i, Q2_i, Q3_i) (§7.3). */
export function foreignIeiUnitScore(
  a: Pick<ForeignInstitutionRaw, 'q1' | 'q2Values' | 'q3Values'>,
): number | null {
  const aggregatedQ2 = meanValid(a.q2Values.map((v) => scoreItem('S5b-Q2', v)));
  const aggregatedQ3 = meanValid(a.q3Values.map((v) => scoreItem('S5b-Q3', v)));
  if (!foreignIeiEligible({ q1: a.q1, aggregatedQ2, aggregatedQ3 })) return null;
  return meanValid([scoreItem('S5b-Q1', a.q1), aggregatedQ2, aggregatedQ3]);
}

/** Foreign_ICI_unit_i = mean(Q4_i, S5b-Q8_i) (§8.3). */
export function foreignIciUnitScore(
  a: Pick<ForeignInstitutionRaw, 'q4Values' | 'q8'>,
): number | null {
  const aggregatedQ4 = meanValid(a.q4Values.map((v) => scoreItem('S5b-Q4', v)));
  if (!foreignIciEligible({ aggregatedQ4, q8: a.q8 })) return null;
  return meanValid([aggregatedQ4, scoreItem('S5b-Q8', a.q8)]);
}

/**
 * Firm-attributable foreign observations (§7.4/§8.4): only the firm-specific
 * components may enter a firm record — the shared S5b-Q1/Q8 are never copied
 * in. The methodology names a national `Foreign_IEI_unit_i`/`Foreign_ICI_
 * unit_i` (above) but does not separately name a "Foreign_IEI_relationship"/
 * "Foreign_ICI_relationship" for firm attribution. This applies the same
 * "mean of valid firm-specific components" shape used by every other
 * relationship score for consistency — a framework interpretation, flagged
 * here and in the README rather than silently invented.
 */
export function foreignIeiFirmSpecificObservation(a: { q2: unknown; q3: unknown }): number | null {
  return meanValid([scoreItem('S5b-Q2', a.q2), scoreItem('S5b-Q3', a.q3)]);
}
export function foreignIciFirmSpecificObservation(a: { q4: unknown }): number | null {
  return scoreItem('S5b-Q4', a.q4);
}

// ─── §7.1-7.3/§8.1-8.3 investor-unit collapse + §7.4/§8.4 firm attribution ────
//
// Both stages read the SAME raw answer rows once per instrument and group them
// by respondent × rated-firm — one grouping, re-aggregated two ways (by
// respondent for the national unit score; by firm for the firm-attributable
// combined score), never two separate DB reads or two separate computations.
// Institutional responses (SEC/NGX/CSCS/LCFE/NASD/FMDQ) never enter this
// pipeline at all — structurally, by construction: only 'S4'/'S5a'/'S5b' are
// ever passed to `getInvestorInstrumentAnswers`, never an institutional
// instrument code (Phase 21 §2.2's exclusion needs no separate runtime check
// here for exactly the reason that section documented).

const SHARED_FIRM_KEY = '__shared__';

/** respondentId -> (ratedFirmId, or SHARED_FIRM_KEY for a shared item) ->
 *  questionId -> raw answer text. */
function groupInvestorAnswers(
  rows: Array<{
    respondentId: string;
    questionId: string;
    ratedFirmId: string | null;
    a: string | null;
  }>,
): Map<string, Map<string, Map<string, string | null>>> {
  const out = new Map<string, Map<string, Map<string, string | null>>>();
  for (const row of rows) {
    const firmKey = row.ratedFirmId ?? SHARED_FIRM_KEY;
    let byFirm = out.get(row.respondentId);
    if (!byFirm) {
      byFirm = new Map();
      out.set(row.respondentId, byFirm);
    }
    let answers = byFirm.get(firmKey);
    if (!answers) {
      answers = new Map();
      byFirm.set(firmKey, answers);
    }
    answers.set(row.questionId, row.a);
  }
  return out;
}

const S5A_Q1_ATTRIBUTES = [
  'Service quality',
  'Reporting quality',
  'Responsiveness',
  'Operational efficiency',
] as const;

/** S5a-Q1 is stored as ONE grid response (`GridAnswer` = `{row: {col: val}}`)
 *  under question_id `S5a-Q1`, not as four separately-coded rows. Extracts the
 *  four named attribute values the methodology's "at least 3 of 4" rule (§11)
 *  needs, tolerating a missing/malformed grid answer as "all four missing"
 *  rather than throwing — the same "missing, not neutral" treatment §11
 *  gives every other absent item. */
function parseS5aQ1Attributes(raw: string | null): unknown[] {
  if (!raw) return S5A_Q1_ATTRIBUTES.map(() => null);
  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown> | undefined>;
    return S5A_Q1_ATTRIBUTES.map((row) => parsed[row]?.['Rating'] ?? null);
  } catch {
    return S5A_Q1_ATTRIBUTES.map(() => null);
  }
}

export interface InvestorRelationshipObservation {
  respondentId: string;
  firmId: string;
  iei: number | null;
  ici: number | null;
}

/** Every retail (S4) relationship observation for an edition — one per
 *  (respondent, rated firm). Both the national Retail_IEI/ICI_unit collapse
 *  and Firm_Investor_IEI_f/Firm_ICI_f read this SAME array. */
export async function retailInvestorObservations(
  pool: Pool,
  editionId: string,
): Promise<InvestorRelationshipObservation[]> {
  const rows = await getInvestorInstrumentAnswers(pool, editionId, 'S4');
  const grouped = groupInvestorAnswers(rows);
  const out: InvestorRelationshipObservation[] = [];
  for (const [respondentId, byFirm] of grouped) {
    for (const [firmId, answers] of byFirm) {
      if (firmId === SHARED_FIRM_KEY) continue; // every S4 item is firm_specific
      out.push({
        respondentId,
        firmId,
        iei: retailIeiRelationshipScore({
          q1: answers.get('S4-Q1'),
          q2: answers.get('S4-Q2'),
          q3: answers.get('S4-Q3'),
        }),
        ici: retailIciRelationshipScore({
          q4: answers.get('S4-Q4'),
          q5: answers.get('S4-Q5'),
          q6: answers.get('S4-Q6'),
          q7: answers.get('S4-Q7'),
        }),
      });
    }
  }
  return out;
}

/** Every local institutional (S5a) relationship observation for an edition —
 *  one per (respondent, rated firm). Shared by the national Local_IEI/ICI_unit
 *  collapse and Firm_Investor_IEI_f/Firm_ICI_f. */
export async function localInvestorObservations(
  pool: Pool,
  editionId: string,
): Promise<InvestorRelationshipObservation[]> {
  const rows = await getInvestorInstrumentAnswers(pool, editionId, 'S5a');
  const grouped = groupInvestorAnswers(rows);
  const out: InvestorRelationshipObservation[] = [];
  for (const [respondentId, byFirm] of grouped) {
    for (const [firmId, answers] of byFirm) {
      if (firmId === SHARED_FIRM_KEY) continue; // every S5a item used here is firm_specific
      out.push({
        respondentId,
        firmId,
        iei: localIeiRelationshipScore({
          q1Attributes: parseS5aQ1Attributes(answers.get('S5a-Q1') ?? null),
          q2: answers.get('S5a-Q2'),
        }),
        ici: localIciRelationshipScore({ q5: answers.get('S5a-Q5'), q6: answers.get('S5a-Q6') }),
      });
    }
  }
  return out;
}

export interface ForeignInvestorUnit {
  respondentId: string;
  iei: number | null;
  ici: number | null;
}

/** Every foreign institutional (S5b) NATIONAL unit score for an edition — one
 *  per institution (respondent), computed directly per §7.3/§8.3 (never
 *  relationship-then-collapsed). */
export async function foreignInvestorUnitScores(
  pool: Pool,
  editionId: string,
): Promise<ForeignInvestorUnit[]> {
  const rows = await getInvestorInstrumentAnswers(pool, editionId, 'S5b');
  const grouped = groupInvestorAnswers(rows);
  const out: ForeignInvestorUnit[] = [];
  for (const [respondentId, byFirm] of grouped) {
    const shared = byFirm.get(SHARED_FIRM_KEY) ?? new Map<string, string | null>();
    const q2Values: unknown[] = [];
    const q3Values: unknown[] = [];
    const q4Values: unknown[] = [];
    for (const [firmId, answers] of byFirm) {
      if (firmId === SHARED_FIRM_KEY) continue;
      if (answers.has('S5b-Q2')) q2Values.push(answers.get('S5b-Q2'));
      if (answers.has('S5b-Q3')) q3Values.push(answers.get('S5b-Q3'));
      if (answers.has('S5b-Q4')) q4Values.push(answers.get('S5b-Q4'));
    }
    out.push({
      respondentId,
      iei: foreignIeiUnitScore({ q1: shared.get('S5b-Q1'), q2Values, q3Values }),
      ici: foreignIciUnitScore({ q4Values, q8: shared.get('S5b-Q8') }),
    });
  }
  return out;
}

/** Every foreign institutional FIRM-ATTRIBUTABLE observation for an edition —
 *  one per (respondent, rated firm), using ONLY firm-specific components
 *  (§7.4/§8.4) — the shared S5b-Q1/Q8 never enter a firm record. */
export async function foreignInvestorFirmObservations(
  pool: Pool,
  editionId: string,
): Promise<InvestorRelationshipObservation[]> {
  const rows = await getInvestorInstrumentAnswers(pool, editionId, 'S5b');
  const grouped = groupInvestorAnswers(rows);
  const out: InvestorRelationshipObservation[] = [];
  for (const [respondentId, byFirm] of grouped) {
    for (const [firmId, answers] of byFirm) {
      if (firmId === SHARED_FIRM_KEY) continue;
      out.push({
        respondentId,
        firmId,
        iei: foreignIeiFirmSpecificObservation({
          q2: answers.get('S5b-Q2'),
          q3: answers.get('S5b-Q3'),
        }),
        ici: foreignIciFirmSpecificObservation({ q4: answers.get('S5b-Q4') }),
      });
    }
  }
  return out;
}

export interface InvestorSegmentUnitScores {
  retail: { iei: number[]; ici: number[] };
  local: { iei: number[]; ici: number[] };
  foreign: { iei: number[]; ici: number[] };
}

/**
 * The real national investor-unit scores for an edition, collapsed exactly as
 * §7.1-7.3/§8.1-8.3 require — "multi-firm respondents receive one national
 * respondent/institution weight after their firm relationships are
 * collapsed" (principle 7). Retail/Local: one unit score per respondent, the
 * mean of that respondent's valid relationship scores across every firm they
 * rated. Foreign: already one score per institution (no collapse needed).
 * This is the real input `pooledHeadline`/`runInvestorPooling` need — never a
 * hand-built fixture.
 */
export async function investorSegmentUnitScores(
  pool: Pool,
  editionId: string,
): Promise<InvestorSegmentUnitScores> {
  const [retailRel, localRel, foreignUnits] = await Promise.all([
    retailInvestorObservations(pool, editionId),
    localInvestorObservations(pool, editionId),
    foreignInvestorUnitScores(pool, editionId),
  ]);

  const collapse = (
    observations: InvestorRelationshipObservation[],
    field: 'iei' | 'ici',
  ): number[] => {
    const byRespondent = new Map<string, number[]>();
    for (const obs of observations) {
      const score = obs[field];
      if (score === null) continue;
      const arr = byRespondent.get(obs.respondentId) ?? [];
      arr.push(score);
      byRespondent.set(obs.respondentId, arr);
    }
    const units: number[] = [];
    for (const scores of byRespondent.values()) {
      const unit = meanValid(scores);
      if (unit !== null) units.push(unit);
    }
    return units;
  };

  return {
    retail: { iei: collapse(retailRel, 'iei'), ici: collapse(retailRel, 'ici') },
    local: { iei: collapse(localRel, 'iei'), ici: collapse(localRel, 'ici') },
    foreign: {
      iei: foreignUnits.map((u) => u.iei).filter((s): s is number => s !== null),
      ici: foreignUnits.map((u) => u.ici).filter((s): s is number => s !== null),
    },
  };
}

export interface FirmInvestorScore {
  firmId: string;
  investorIei: number | null;
  investorIci: number | null;
  nIei: number;
  nIci: number;
}

/**
 * Firm_Investor_IEI_f / Firm_ICI_f (§7.4/§8.4) — the flat mean of every
 * eligible firm-attributable investor observation for firm `f`, combining
 * retail + local + foreign-firm-specific evidence internally without
 * publishing a separate institutional cut (§7.4's own rule; never a code
 * change away from the firm report's existing "no institutional cut" rule).
 * Reuses the SAME relationship observations `investorSegmentUnitScores`
 * reads — grouped by firm here instead of by respondent.
 */
export async function firmInvestorScores(
  pool: Pool,
  editionId: string,
): Promise<FirmInvestorScore[]> {
  const [retailRel, localRel, foreignFirmRel] = await Promise.all([
    retailInvestorObservations(pool, editionId),
    localInvestorObservations(pool, editionId),
    foreignInvestorFirmObservations(pool, editionId),
  ]);
  const all = [...retailRel, ...localRel, ...foreignFirmRel];

  const byFirm = new Map<string, { iei: number[]; ici: number[] }>();
  for (const obs of all) {
    let bucket = byFirm.get(obs.firmId);
    if (!bucket) {
      bucket = { iei: [], ici: [] };
      byFirm.set(obs.firmId, bucket);
    }
    if (obs.iei !== null) bucket.iei.push(obs.iei);
    if (obs.ici !== null) bucket.ici.push(obs.ici);
  }

  return Array.from(byFirm.entries()).map(([firmId, bucket]) => ({
    firmId,
    investorIei: meanValid(bucket.iei),
    investorIci: meanValid(bucket.ici),
    nIei: bucket.iei.length,
    nIci: bucket.ici.length,
  }));
}

// ─── §7.5/§8.5/§9 — the real pooled public headline, wired end to end ─────────

/**
 * Pooling eligibility ("clears its reportability floor", §7.5) is the SAME
 * REPORTABLE threshold `segmentDisplayState` already uses (`REPORTABLE_AT`) —
 * the methodology never defines a separate pooling-specific number, and
 * inventing one here would be exactly the kind of fixed shortcut §4 of the
 * Phase 22 prompt forbids. A segment's STANDALONE display state (computed the
 * same way) is a genuinely separate fact, reported alongside by
 * `pooledHeadline`'s existing `standaloneState` field — never blurred with
 * pooling eligibility, per §7.5's explicit wording.
 */
const SEGMENT_LABELS: Record<'retail' | 'local' | 'foreign', string> = {
  retail: 'Retail',
  local: 'Local Institutional',
  foreign: 'Foreign Institutional',
};

function pooledSegmentInputs(
  scores: InvestorSegmentUnitScores,
  metric: 'iei' | 'ici',
): PooledSegmentInput[] {
  return (['retail', 'local', 'foreign'] as const).map((segment) => ({
    segment,
    label: SEGMENT_LABELS[segment],
    unitScores: scores[segment][metric],
    reportabilityFloor: REPORTABLE_AT,
  }));
}

function headlineComposition(headline: PooledHeadline): CalculatedResultComposition[] {
  return headline.composition.map((c) => ({ segment: c.segment, label: c.label, count: c.count }));
}

export interface InvestorPoolingResult {
  iei: PooledHeadline;
  ici: PooledHeadline;
}

/**
 * The real caller `pooledHeadline` has never had: pulls real investor-unit
 * scores (`investorSegmentUnitScores`), determines `E` per segment via the
 * SAME reportability floor, calls `pooledHeadline` for IEI and ICI, and
 * persists each as a real `calculated_results` row (`subject_type: 'market'`,
 * `metric_code: 'IEI'`/`'ICI'`, TEST_UNAPPROVED via the run it's given) with
 * the §9 structured composition disclosure. A non-contributing segment is
 * OMITTED from `composition` entirely — `pooledHeadline` already builds it
 * that way; this only persists it unchanged.
 */
export async function runInvestorPooling(
  pool: Pool,
  editionId: string,
  calculationRunId: string,
): Promise<InvestorPoolingResult> {
  const scores = await investorSegmentUnitScores(pool, editionId);
  const iei = pooledHeadline('IEI', pooledSegmentInputs(scores, 'iei'));
  const ici = pooledHeadline('ICI', pooledSegmentInputs(scores, 'ici'));

  for (const [metricCode, headline] of [
    ['IEI', iei],
    ['ICI', ici],
  ] as const) {
    await insertCalculatedResult(pool, {
      calculationRunId,
      subjectType: 'market',
      subjectId: 'INDUSTRY',
      metricCode,
      value: headline.headline === null ? null : Math.round(headline.headline * 10) / 10,
      n: headline.totalUnits,
      denominator: headline.totalUnits,
      sufficiencyState: headline.headline === null ? 'SUPPRESSED' : 'REPORTABLE',
      reason: headline.headline === null ? headline.disclosure : null,
      composition: headlineComposition(headline),
    });
  }

  return { iei, ici };
}

/**
 * Build one edition's real `EditionSegmentEvidence` (§13) from data this
 * pipeline actually produced — never a hand-built fixture: the same real
 * unit scores `runInvestorPooling` pooled from, `reportable` determined by
 * the SAME reportability floor as pooling, and `publishedHeadline` read back
 * from the calculation run's own already-persisted pooled result.
 */
async function investorEditionSegmentEvidence(
  pool: Pool,
  editionId: string,
  calculationRunId: string,
  metricCode: 'IEI' | 'ICI',
): Promise<EditionSegmentEvidence> {
  const scores = await investorSegmentUnitScores(pool, editionId);
  const metricKey = metricCode === 'IEI' ? 'iei' : 'ici';
  const unitScoresBySegment: Record<'retail' | 'local' | 'foreign', number[]> = {
    retail: scores.retail[metricKey],
    local: scores.local[metricKey],
    foreign: scores.foreign[metricKey],
  };
  const reportable = (['retail', 'local', 'foreign'] as const).filter(
    (segment) => segmentDisplayState(unitScoresBySegment[segment].length) === 'REPORTABLE',
  );
  const results = await listCalculatedResults(pool, calculationRunId);
  const headlineRow = results.find(
    (r) => r.subjectType === 'market' && r.subjectId === 'INDUSTRY' && r.metricCode === metricCode,
  );
  return { reportable, unitScoresBySegment, publishedHeadline: headlineRow?.value ?? null };
}

/**
 * Wires `computeLikeForLike` to the real pooled-headline service (§13), the
 * same "give the pure function a real caller" fix applied to `pooledHeadline`
 * above: builds each edition's segment evidence from data
 * `runInvestorPooling` already persisted for that edition's run, then
 * records the comparison exactly as `recordLikeForLikeComparison` always
 * has — immutable, `LIKE_FOR_LIKE_RECALCULATED`, preserving both original
 * headlines.
 */
export async function recordInvestorLikeForLike(
  pool: Pool,
  input: {
    metricCode: 'IEI' | 'ICI';
    editionAId: string;
    editionBId: string;
    runAId: string;
    runBId: string;
  },
): Promise<ComparisonRun> {
  const [a, b] = await Promise.all([
    investorEditionSegmentEvidence(pool, input.editionAId, input.runAId, input.metricCode),
    investorEditionSegmentEvidence(pool, input.editionBId, input.runBId, input.metricCode),
  ]);
  return recordLikeForLikeComparison(pool, {
    metricCode: input.metricCode,
    editionAId: input.editionAId,
    editionBId: input.editionBId,
    runAId: input.runAId,
    runBId: input.runBId,
    a,
    b,
  });
}

// ─── Firm-scope-safe investor aggregation (§5) ────────────────────────────────

/**
 * The firm-specific investor answers eligible for a firm's combined ICI/IEI —
 * shared market-level items are EXCLUDED structurally via Phase 2's `scope`
 * flag. e.g. S5b-Q1 (shared) never enters; S5b-Q2/Q3 (firm_specific) may.
 */
export async function firmSpecificInvestorAnswers(
  pool: Pool,
  editionId: string,
  firmId: string,
): Promise<Array<{ questionId: string; a: string | null }>> {
  const rows = await getFirmAttributableInvestorAnswers(pool, editionId, firmId, {
    firmSpecificOnly: true,
  });
  return rows.map((r) => ({ questionId: r.questionId, a: r.a }));
}

// ─── Public pooled headline + mandatory composition disclosure (§6) ────────────

export interface PooledSegmentInput {
  segment: string;
  label: string;
  unitScores: number[];
  reportabilityFloor: number;
}

export interface PooledHeadline {
  metric: string;
  headline: number | null;
  totalUnits: number;
  composition: Array<{ segment: string; label: string; count: number }>;
  excludedSegments: string[];
  /** The mandatory disclosure line — a required structured field, never optional prose. */
  disclosure: string;
  /**
   * Phase 21 §2.1 (v0.15) — each input segment's STANDALONE display state
   * (`segmentDisplayState`, keyed off its own unit count), reported
   * alongside but computed INDEPENDENTLY of pooling eligibility above. A
   * segment can be excluded from the pooled headline (sub-floor for
   * pooling) while still being REPORTABLE or SHOWN_DIRECTIONALLY on its own,
   * and a segment that clears the pooling floor is not thereby guaranteed
   * REPORTABLE standalone (pooling and standalone floors are governed
   * separately — see `firm_investor_thresholds` in governed_config). Pooling
   * inclusion/exclusion above is UNCHANGED by this field.
   */
  standaloneState: Record<string, SegmentDisplayState>;
}

/**
 * The privacy-safe pooled public headline (methodology §7.5/§8.5, estimator
 * clarification §1). A segment contributes ONLY if it clears its reportability
 * floor; a sub-floor segment is excluded from BOTH the headline value and its
 * denominator (not merely flagged). The headline is a plain arithmetic mean of
 * all valid investor-unit scores from reportable segments — NO equal-third
 * weighting. Every result carries a composition disclosure line.
 */
export function pooledHeadline(metric: string, segments: PooledSegmentInput[]): PooledHeadline {
  const reportable = segments.filter((s) => s.unitScores.length >= s.reportabilityFloor);
  const excludedSegments = segments
    .filter((s) => s.unitScores.length < s.reportabilityFloor)
    .map((s) => s.segment);
  const allScores = reportable.flatMap((s) => s.unitScores);
  const headline =
    allScores.length === 0 ? null : allScores.reduce((a, b) => a + b, 0) / allScores.length;
  const composition = reportable.map((s) => ({
    segment: s.segment,
    label: s.label,
    count: s.unitScores.length,
  }));
  const totalUnits = composition.reduce((a, c) => a + c.count, 0);
  const parts = composition.map((c) => `${c.count} ${c.label}`);
  const disclosure =
    headline === null
      ? `${metric} not reportable — no segment clears its floor.`
      : `${metric} = ${Math.round(headline)}, based on ${totalUnits} reportable investor units: ${parts.join(' and ')}.`;
  const standaloneState: Record<string, SegmentDisplayState> = {};
  for (const s of segments) {
    standaloneState[s.segment] = segmentDisplayState(s.unitScores.length);
  }
  return {
    metric,
    headline,
    totalUnits,
    composition,
    excludedSegments,
    disclosure,
    standaloneState,
  };
}

// ─── Industry SEI — real derivation from reportable Firm_SEI (Phase 19, item 5) ─
//
// Replaces the permanent NOT_CALCULABLE block that used to be gated on an
// unapproved YAML parameter. Industry SEI now aggregates the mean Firm_SEI
// across every PARTICIPATING firm whose OWN Firm_SEI cleared at least
// DIRECTIONAL sufficiency (n >= SUPPRESS_BELOW investor raters, via the
// existing generic `computeSufficiency()` — never a bespoke minimum-
// observations threshold invented for this one metric). The COUNT of those
// contributing firms is then run back through the SAME `computeSufficiency()`
// ladder to decide whether the aggregate itself is reportable. No firm-level
// value is ever exposed on its own — only the aggregate, and only once it
// clears the same floor every other metric in this codebase clears.

export interface IndustrySeiState {
  status: 'NOT_CALCULABLE' | 'CALCULABLE';
  /** Present only when NOT_CALCULABLE — why, in plain terms. */
  reason?: string;
  /** How many firms have at least DIRECTIONAL Firm_SEI and so contribute. */
  contributingFirms: number;
  /** The derived aggregate (mean of contributing Firm_SEI values) — only
   *  when CALCULABLE. */
  value?: number;
  /** The aggregate's own sufficiency, from `computeSufficiency(contributingFirms)`
   *  — only when CALCULABLE (SUPPRESSED maps to NOT_CALCULABLE, never surfaced
   *  here). */
  sufficiency?: 'DIRECTIONAL' | 'REPORTABLE';
}

/**
 * Derive Industry SEI from the edition's authoritative (signed-off) scoring
 * run. NOT_CALCULABLE while no such run exists yet (collection is open, or
 * scoring hasn't been signed off) — a genuine data-shortfall reason, not a
 * permanent methodology gate, so outreach or waiting for sign-off resolves it.
 */
export async function industrySeiState(pool: Pool, editionId: string): Promise<IndustrySeiState> {
  const signoff = await getAuthoritativeSignoff(pool, editionId);
  if (!signoff) {
    return {
      status: 'NOT_CALCULABLE',
      reason: 'No signed-off scoring run exists for this edition yet',
      contributingFirms: 0,
    };
  }
  const results = await listCalculatedResults(pool, signoff.calculationRunId);
  const seiRows = results.filter((r) => r.subjectType === 'firm' && r.metricCode === 'SEI');
  const contributing = seiRows.filter(
    (r) => r.value !== null && computeSufficiency(r.n) !== 'SUPPRESSED',
  );
  const contributingFirms = contributing.length;
  const aggregateSufficiency = computeSufficiency(contributingFirms);
  if (aggregateSufficiency === 'SUPPRESSED') {
    return {
      status: 'NOT_CALCULABLE',
      reason: `Only ${contributingFirms} firm${contributingFirms === 1 ? '' : 's'} have reportable Firm_SEI so far — too few to aggregate safely`,
      contributingFirms,
    };
  }
  const mean = contributing.reduce((sum, r) => sum + (r.value as number), 0) / contributingFirms;
  return {
    status: 'CALCULABLE',
    value: Math.round(mean * 10) / 10,
    contributingFirms,
    sufficiency: aggregateSufficiency === 'DIRECTIONAL' ? 'DIRECTIONAL' : 'REPORTABLE',
  };
}

// ─── Like-for-like cross-edition recalculation (§7 / §13) ──────────────────────

export interface EditionSegmentEvidence {
  /** Reportable segments in this edition. */
  reportable: string[];
  /** Investor-unit scores per segment. */
  unitScoresBySegment: Record<string, number[]>;
  /** The edition's originally published headline (never overwritten). */
  publishedHeadline: number | null;
}

/** Whether two editions' headlines may be compared directly — false when the
 *  reportable segment sets differ (a like-for-like recalculation is then
 *  mandatory before any trend claim). */
export function canCompareHeadlinesDirectly(reportableA: string[], reportableB: string[]): boolean {
  const a = new Set(reportableA);
  const b = new Set(reportableB);
  if (a.size !== b.size) return false;
  for (const s of a) if (!b.has(s)) return false;
  return true;
}

function meanOnSegments(ev: EditionSegmentEvidence, segments: string[]): number | null {
  const scores = segments.flatMap((s) => ev.unitScoresBySegment[s] ?? []);
  return scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length;
}

export interface LikeForLike {
  commonSegments: string[];
  recalculatedA: number | null;
  recalculatedB: number | null;
  originalHeadlineA: number | null;
  originalHeadlineB: number | null;
}

/** Recompute both editions on their common reportable segment set. Pure. */
export function computeLikeForLike(
  a: EditionSegmentEvidence,
  b: EditionSegmentEvidence,
): LikeForLike {
  const bset = new Set(b.reportable);
  const commonSegments = a.reportable.filter((s) => bset.has(s)).sort();
  return {
    commonSegments,
    recalculatedA: meanOnSegments(a, commonSegments),
    recalculatedB: meanOnSegments(b, commonSegments),
    originalHeadlineA: a.publishedHeadline,
    originalHeadlineB: b.publishedHeadline,
  };
}

/**
 * Persist a like-for-like comparison as a new, separately-immutable
 * `LIKE_FOR_LIKE_RECALCULATED` run referencing two prior signed runs — never
 * mutating either. Both original headlines are preserved on the record.
 */
export async function recordLikeForLikeComparison(
  pool: Pool,
  input: {
    metricCode: string;
    editionAId: string;
    editionBId: string;
    runAId: string;
    runBId: string;
    a: EditionSegmentEvidence;
    b: EditionSegmentEvidence;
  },
): Promise<ComparisonRun> {
  const lfl = computeLikeForLike(input.a, input.b);
  return createComparisonRun(pool, {
    editionAId: input.editionAId,
    editionBId: input.editionBId,
    runAId: input.runAId,
    runBId: input.runBId,
    metricCode: input.metricCode,
    methodologyVersion: methodologyVersionString(),
    commonSegments: lfl.commonSegments,
    originalHeadlineA: lfl.originalHeadlineA,
    originalHeadlineB: lfl.originalHeadlineB,
    recalculatedA: lfl.recalculatedA,
    recalculatedB: lfl.recalculatedB,
  });
}

// ─── The candidate scoring run ─────────────────────────────────────────────────

export interface CandidateRunResult {
  run: CalculationRun;
  dmiCompleteCount: number;
  industryDmi: number | null;
  industrySei: IndustrySeiState;
  /** Firms with a real, pipeline-sourced Firm_SEI_f this run (Phase 22 §2.6). */
  firmSeiCount: number;
  /** The real pooled public IEI/ICI headlines this run produced (Phase 22 §2.4). */
  investorPooling: InvestorPoolingResult;
}

/**
 * Run the candidate methodology over an edition. ALWAYS `TEST_UNAPPROVED`. It
 * computes Firm_DMI for DMI-complete firms (exercising the transforms + weights
 * from the config), the Industry_DMI mean, and records Industry SEI as
 * NOT_CALCULABLE while its floor is unset. Every result is stamped with the
 * candidate methodology version and barred from official use by the gate above.
 */
export async function runCandidateScoring(
  pool: Pool,
  editionId: string,
): Promise<CandidateRunResult> {
  const meta = getMethodologyMeta();
  if (meta.status !== 'TEST_UNAPPROVED') {
    // The build note permits building ONLY the TEST_UNAPPROVED candidate.
    throw new CandidateScoringError(
      `Candidate config status is ${meta.status}; only TEST_UNAPPROVED may be run here`,
      'UNEXPECTED_STATUS',
    );
  }
  const datasetHash = await datasetHashFor(pool, editionId);
  const run = await createCalculationRun(pool, {
    editionId,
    runType: 'scoring',
    methodologyVersion: methodologyVersionString(),
    methodologyStatus: 'TEST_UNAPPROVED',
    datasetHash,
  });

  const dmi = await firmDmiScores(pool, editionId);
  for (const f of dmi) {
    await insertCalculatedResult(pool, {
      calculationRunId: run.id,
      subjectType: 'firm',
      subjectId: f.firmId,
      metricCode: 'DMI',
      value: Math.round(f.score * 10000) / 10000,
      n: getDmiRequiredItems().length,
      denominator: getDmiRequiredItems().length,
      sufficiencyState: 'REPORTABLE',
    });
  }
  const industryDmi = dmi.length === 0 ? null : dmi.reduce((a, b) => a + b.score, 0) / dmi.length;
  if (industryDmi !== null) {
    await insertCalculatedResult(pool, {
      calculationRunId: run.id,
      subjectType: 'market',
      subjectId: 'INDUSTRY',
      metricCode: 'DMI',
      value: Math.round(industryDmi * 10000) / 10000,
      n: dmi.length,
      denominator: dmi.length,
      sufficiencyState: 'REPORTABLE',
    });
  }

  // Industry SEI — real derivation from the authoritative run's Firm_SEI.
  const industrySei = await industrySeiState(pool, editionId);
  if (industrySei.status === 'NOT_CALCULABLE') {
    await insertCalculatedResult(pool, {
      calculationRunId: run.id,
      subjectType: 'market',
      subjectId: 'INDUSTRY',
      metricCode: 'SEI',
      value: null,
      n: industrySei.contributingFirms,
      denominator: industrySei.contributingFirms,
      sufficiencyState: 'NOT_CALCULABLE',
      reason: industrySei.reason ?? 'Industry SEI is not calculable',
    });
  } else {
    await insertCalculatedResult(pool, {
      calculationRunId: run.id,
      subjectType: 'market',
      subjectId: 'INDUSTRY',
      metricCode: 'SEI',
      value: industrySei.value ?? null,
      n: industrySei.contributingFirms,
      denominator: industrySei.contributingFirms,
      sufficiencyState: industrySei.sufficiency ?? 'REPORTABLE',
    });
  }

  // Firm-side SEI (§10): Firm_SEI_f = 100 - abs(Firm_Expectation_f -
  // Firm_Investor_IEI_f), now genuinely database-sourced — Firm_Investor_IEI_f
  // comes from the real §7.4 pipeline (`firmInvestorScores`), never a stub.
  // Private-report calculable regardless of volume (§10), so REPORTABLE
  // unconditionally once both inputs exist — this is NOT the public Industry
  // SEI eligibility gate, which stays untouched (PENDING_VALIDATOR, below).
  const expectationRows = await getFirmSideItemAnswers(pool, editionId, ['S1-Q11']);
  const investorScores = await firmInvestorScores(pool, editionId);
  const investorByFirm = new Map(investorScores.map((s) => [s.firmId, s]));
  let firmSeiCount = 0;
  for (const row of expectationRows) {
    const expectation = scoreItem('S1-Q11', row.a);
    const investor = investorByFirm.get(row.firmId);
    if (expectation === null || investor === undefined || investor.investorIei === null) continue;
    const seiValue = 100 - Math.abs(expectation - investor.investorIei);
    await insertCalculatedResult(pool, {
      calculationRunId: run.id,
      subjectType: 'firm',
      subjectId: row.firmId,
      metricCode: 'SEI',
      value: Math.round(seiValue * 10000) / 10000,
      n: investor.nIei,
      denominator: investor.nIei,
      sufficiencyState: 'REPORTABLE',
    });
    firmSeiCount += 1;
  }

  // Investor-side IEI/ICI pooling (§7.5/§8.5/§9) — the real caller
  // `pooledHeadline` never had, now a real stage of this same run.
  const investorPooling = await runInvestorPooling(pool, editionId, run.id);

  return {
    run,
    dmiCompleteCount: dmi.length,
    industryDmi,
    industrySei,
    firmSeiCount,
    investorPooling,
  };
}
