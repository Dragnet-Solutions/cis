import { Pool } from 'pg';
import {
  getEditionById,
  getConfig,
  getLatestNationalReportForEdition,
  listFirmReports,
  listOrganizations,
  listSubmittedAnswers,
  getTransform,
  getAuthoritativeSignoff,
  getCalculationRun,
  listCalculatedResults,
  listSampleFloors,
  type ReportAnswerRow,
} from '@cis/db';
import { investorSegmentUnitScores } from './candidate-scoring-service';
import { DomainError } from './errors';
import { currentSegmentSufficiency } from './eligibility-service';
import { getSections, NATIONAL_SECTIONS } from './national-report-service';
import { listRegulators } from './regulator-engagement-service';
import { applyTransform, isSubstantive } from './scoring-transforms';
import { SUPPRESS_BELOW } from './sufficiency-service';

/**
 * The CONTENT of the two report documents — the public Industry report and each
 * firm's private report — computed from submitted responses.
 *
 * Deliberately DESCRIPTIVE only: shares of respondents citing something, and
 * average ratings. Every 1–10 rating is put on 0–100 with the methodology's own
 * N1 transform ((x−1)/9·100), so the report and the scoring engine share one
 * scale. Nothing here weights, combines or indexes — the five indices (and
 * anything built on them, such as maturity tiers) need an APPROVED methodology,
 * so they are reported as pending rather than invented.
 *
 * A share or average over fewer than SUPPRESS_BELOW (10) responses is withheld,
 * not shown — the same small-number floor the rest of the study uses.
 */

export class ReportContentError extends DomainError {
  constructor(message: string, code = 'REPORT_CONTENT') {
    super(message, code);
  }
}

// ─── Shapes ────────────────────────────────────────────────────────────────────

/** A share of respondents citing something (0–100, rounded) and its base. */
export interface Share {
  label: string;
  pct: number;
  /** How many cited it. */
  count: number;
}

/** An average rating on 0–100, or null when there are too few ratings to show. */
export interface Rating {
  value: number | null;
  n: number;
}

export interface Pending {
  state: 'pending_methodology';
  note: string;
}

/** One index score as a report shows it: the value, its base and any caveat. */
export interface IndexScore {
  code: string;
  name: string;
  value: number | null;
  n: number | null;
  note: string | null;
}

/**
 * The five indices from the signed scoring run, once that run was made under
 * the approved methodology. `firm` is the firm's own scores (firm report only);
 * `segments` is IEI/ICI by investor segment, each behind the 10-investor floor.
 */
export interface IndicesReported {
  state: 'reported';
  methodology: string;
  runId: string;
  industry: IndexScore[];
  firm: IndexScore[] | null;
  segments: Array<{ segment: string; label: string; iei: Rating; ici: Rating }>;
  /**
   * Firms grouped into thirds by Firm_OMI, with each tier's mean OMI and DMI —
   * null when there are too few scored firms for a tier mean not to point at
   * one firm (`tiersNote` says why).
   */
  tiers: Array<{ tier: string; firms: number; omi: number; dmi: number | null }> | null;
  tiersNote: string | null;
}

/** A tier's mean is only shown when it pools at least this many firms. */
const MIN_FIRMS_PER_TIER = 3;

export type Indices = Pending | IndicesReported;

const INDEX_NAMES: Array<[string, string]> = [
  ['OMI', 'Operational maturity'],
  ['DMI', 'Digital maturity'],
  ['IEI', 'Investor experience'],
  ['ICI', 'Investor confidence'],
  ['SEI', 'Service excellence'],
];

const INDICES_PENDING: Pending = {
  state: 'pending_methodology',
  note:
    'The five indices are computed only from a methodology approved by the methodology ' +
    'partner. Until it is approved, index scores — and anything built on them, such as ' +
    'maturity tiers — are not reported.',
};

export interface ReportSectionState {
  id: string;
  name: string;
  disposition: 'publishable' | 'caveated' | 'suppressed';
  reason: string | null;
}

export interface IndustryReportContent {
  edition: { id: string; label: string; status: string };
  generatedAt: string;
  /** The generated national report's section states; null if none generated yet. */
  sections: ReportSectionState[] | null;
  participation: Array<{
    segment: string;
    label: string;
    target: number;
    achieved: number;
    meets: boolean;
  }>;
  indices: Indices;
  frictions: { base: number; items: Share[] } | null;
  frustrations: { base: number; items: Share[] } | null;
  participationImpact: { base: number; items: Share[] } | null;
  confidenceLevers: { base: number; items: Share[] } | null;
  localVsForeign: {
    localN: number;
    foreignN: number;
    rows: Array<{ label: string; local: Rating; foreign: Rating }>;
  };
  comparators: {
    base: number;
    rows: Array<{
      comparator: string;
      better: number;
      same: number;
      worse: number;
      n: number;
    }>;
  } | null;
  selfVsInvestors: { firmSelfBelief: Rating; investorExperience: Rating };
  institutional: InstitutionalReading[];
  /** Institutions invited to give a reading, and how many gave one. */
  institutionalParticipation: { invited: number; contributed: number };
  /**
   * Operational themes the institutions' readings name (most frequent issues and
   * greatest consequences), with which institutions name each — computed from
   * the answers, never assumed. `standsApart`: institutions none of whose
   * themes another institution names.
   */
  institutionalThemes: { themes: Array<{ theme: string; codes: string[] }>; standsApart: string[] };
}

/**
 * One institution's reading, in one of its roles (CSCS reads both clearing and
 * depository). Qualitative by design: a handful of institutions, so it is the
 * answers they gave — never a percentage over a base of one or two.
 */
export interface InstitutionalReading {
  /** Stable key for this institution-in-role, e.g. "A_SEC". */
  key: string;
  role: string;
  /** Short name, e.g. "SEC". */
  code: string;
  familyCode: string;
  /** The institution's own mandate: its vantage on stockbroking operations. */
  vantage: string;
  responses: number;
  topIssues: Share[];
  /** Q1: the issue named as greatest, and the others named with it. */
  issue: { greatest: string | null; others: string[] };
  /** Q2: how often firm-level weaknesses need the institution's intervention. */
  frequency: string | null;
  /** Q3: what distinguishes a firm that works well with the institution. */
  marks: string[];
  /** Q4: the weakness named as carrying the greatest consequence, and the others. */
  consequence: { greatest: string | null; others: string[] };
  /** Q5: the institution's overall assessment of the profession's capability. */
  capability: string | null;
}

export interface InvestorDimension {
  key: 'ease' | 'responsiveness' | 'transparency' | 'trust';
  label: string;
  firm: Rating;
  industry: Rating;
  /** Which questions feed this dimension, for the report's footnote. */
  sources: string;
}

export interface AgendaItem {
  title: string;
  detail: string;
  priority: 'high' | 'medium' | 'sustain';
}

export interface FirmReportContent {
  edition: { id: string; label: string; status: string };
  generatedAt: string;
  firm: { id: string; name: string };
  report: {
    retailN: number;
    cutState: 'none' | 'directional' | 'unlocked';
    approvalState: string;
    releaseState: string;
  };
  margin: number;
  indices: Indices;
  dimensions: InvestorDimension[];
  selfVsInvestors: {
    firmSelfBelief: Rating;
    investorExperience: Rating;
    industrySelfBelief: Rating;
    industryInvestorExperience: Rating;
  };
  retailCut: {
    state: 'none' | 'directional' | 'unlocked';
    n: number;
    dimensions: Array<{ label: string; firm: Rating; industry: Rating }>;
  };
  agenda: AgendaItem[];
}

// ─── Pure helpers (exported for tests) ─────────────────────────────────────────

/** A 1–10 answer on 0–100 via the methodology's N1 transform; null if not one. */
export function onHundredScale(raw: unknown): number | null {
  const n1 = getTransform('N1');
  if (!n1 || !isSubstantive(raw)) return null;
  return applyTransform(n1, raw);
}

/** Mean of the values that exist, rounded, withheld below the small-number floor. */
export function rating(values: Array<number | null>): Rating {
  const valid = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (valid.length < SUPPRESS_BELOW) return { value: null, n: valid.length };
  return { value: Math.round(valid.reduce((a, b) => a + b, 0) / valid.length), n: valid.length };
}

/** One person's rating on a 0–100 scale. */
export interface Scored {
  respondentId: string;
  value: number;
}

/**
 * The floor applies to PEOPLE, never to ratings: an investor who rated three
 * firms, or answered three items pooled into one measure, is one response. Each
 * respondent's ratings are averaged first, so every person counts once, then
 * the mean is taken across respondents; `n` is the number of respondents.
 */
export function ratingByRespondent(points: Scored[]): Rating {
  const byRespondent = new Map<string, number[]>();
  for (const p of points) {
    if (!Number.isFinite(p.value)) continue;
    const list = byRespondent.get(p.respondentId) ?? [];
    list.push(p.value);
    byRespondent.set(p.respondentId, list);
  }
  const means = [...byRespondent.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  if (means.length < SUPPRESS_BELOW) return { value: null, n: means.length };
  return {
    value: Math.round(means.reduce((a, b) => a + b, 0) / means.length),
    n: means.length,
  };
}

/** The options a select / multi / rank answer names (a select-then-greatest keeps `picked`). */
export function pickedOptions(answer: unknown): string[] {
  if (Array.isArray(answer)) return answer.filter((x): x is string => typeof x === 'string');
  if (
    answer &&
    typeof answer === 'object' &&
    Array.isArray((answer as { picked?: unknown }).picked)
  ) {
    return ((answer as { picked: unknown[] }).picked ?? []).filter(
      (x): x is string => typeof x === 'string',
    );
  }
  return [];
}

/**
 * Share of RESPONDENTS citing each option at least once (one respondent who rated
 * three firms and named the same frustration three times counts once), ranked.
 * Null when fewer than SUPPRESS_BELOW respondents answered.
 */
export function shareCiting(
  rows: Array<{ respondentId: string; options: string[] }>,
  top = 5,
  exclude: string[] = ['Other'],
): { base: number; items: Share[] } | null {
  const byRespondent = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byRespondent.get(r.respondentId) ?? new Set<string>();
    for (const o of r.options) set.add(o);
    byRespondent.set(r.respondentId, set);
  }
  const base = byRespondent.size;
  if (base < SUPPRESS_BELOW) return null;
  const counts = new Map<string, number>();
  for (const set of byRespondent.values()) {
    for (const o of set) if (!exclude.includes(o)) counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  const items = [...counts.entries()]
    .map(([label, count]) => ({ label, count, pct: Math.round((count / base) * 100) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, top);
  return { base, items };
}

function yesNoValue(answer: unknown): string | null {
  if (typeof answer === 'string') return answer;
  if (answer && typeof answer === 'object' && 'v' in answer) {
    const v = (answer as { v?: unknown }).v;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

/** Share of respondents answering "Yes" for at least one firm, per question. */
export function shareYes(
  rows: ReportAnswerRow[],
  questions: Array<{ id: string; label: string }>,
): { base: number; items: Share[] } | null {
  const base = new Set(rows.map((r) => r.respondentId)).size;
  if (base < SUPPRESS_BELOW) return null;
  const items = questions.map((q) => {
    const yes = new Set(
      rows
        .filter((r) => r.questionId === q.id && yesNoValue(r.answer) === 'Yes')
        .map((r) => r.respondentId),
    );
    return { label: q.label, count: yes.size, pct: Math.round((yes.size / base) * 100) };
  });
  return { base, items };
}

const BETTER = new Set(['Significantly better', 'Somewhat better']);
const WORSE = new Set(['Significantly worse', 'Somewhat worse']);

/** A grid cell's value — `{ [row]: { [col]: v } }` or `{ [row]: v }`. */
function gridCell(answer: unknown, row: string): unknown {
  if (!answer || typeof answer !== 'object') return null;
  const cell = (answer as Record<string, unknown>)[row];
  if (cell && typeof cell === 'object') return Object.values(cell as Record<string, unknown>)[0];
  return cell ?? null;
}

/** S4-Q8: for each comparator row, the share rating their stockbroker better / same / worse. */
export function comparatorShares(rows: ReportAnswerRow[]): IndustryReportContent['comparators'] {
  const tallies = new Map<string, { better: number; same: number; worse: number; n: number }>();
  const respondents = new Set<string>();
  for (const r of rows) {
    if (!r.answer || typeof r.answer !== 'object') continue;
    for (const comparator of Object.keys(r.answer as Record<string, unknown>)) {
      const v = gridCell(r.answer, comparator);
      if (typeof v !== 'string') continue;
      const t = tallies.get(comparator) ?? { better: 0, same: 0, worse: 0, n: 0 };
      if (BETTER.has(v)) t.better++;
      else if (WORSE.has(v)) t.worse++;
      else if (v === 'About the same') t.same++;
      else continue; // "Unable to compare" is no view either way
      t.n++;
      tallies.set(comparator, t);
      respondents.add(r.respondentId);
    }
  }
  if (respondents.size < SUPPRESS_BELOW) return null;
  const pct = (x: number, n: number) => (n ? Math.round((x / n) * 100) : 0);
  return {
    base: respondents.size,
    rows: [...tallies.entries()].map(([comparator, t]) => ({
      comparator,
      better: pct(t.better, t.n),
      same: pct(t.same, t.n),
      worse: pct(t.worse, t.n),
      n: t.n,
    })),
  };
}

/**
 * How each investor-experience dimension is read across the three investor
 * instruments. Every source is a 1–10 rating of the firm itself; a dimension
 * pools whichever instruments ask it.
 */
const DIMENSIONS: Array<{
  key: InvestorDimension['key'];
  label: string;
  sources: string;
  read: (r: ReportAnswerRow) => unknown;
}> = [
  {
    key: 'ease',
    label: 'Ease of dealing',
    sources: 'S4-Q1; S5a-Q1 service quality',
    read: (r) =>
      r.questionId === 'S4-Q1'
        ? r.answer
        : r.questionId === 'S5a-Q1'
          ? gridCell(r.answer, 'Service quality')
          : undefined,
  },
  {
    key: 'responsiveness',
    label: 'Responsiveness',
    sources: 'S4-Q2; S5a-Q1 responsiveness',
    read: (r) =>
      r.questionId === 'S4-Q2'
        ? r.answer
        : r.questionId === 'S5a-Q1'
          ? gridCell(r.answer, 'Responsiveness')
          : undefined,
  },
  {
    key: 'transparency',
    label: 'Transparency & reporting',
    sources: 'S4-Q3; S5a-Q1 reporting quality; S5b-Q3',
    read: (r) =>
      r.questionId === 'S4-Q3' || r.questionId === 'S5b-Q3'
        ? r.answer
        : r.questionId === 'S5a-Q1'
          ? gridCell(r.answer, 'Reporting quality')
          : undefined,
  },
  {
    key: 'trust',
    label: 'Trust in records',
    sources: 'S4-Q4; S5a-Q5; S5b-Q4',
    read: (r) =>
      r.questionId === 'S4-Q4' || r.questionId === 'S5a-Q5' || r.questionId === 'S5b-Q4'
        ? r.answer
        : undefined,
  },
];

/** The dimension's 0–100 ratings from the given answers (one per answer that asks it). */
function dimensionValues(rows: ReportAnswerRow[], key: InvestorDimension['key']): Scored[] {
  const d = DIMENSIONS.find((x) => x.key === key)!;
  const out: Scored[] = [];
  for (const r of rows) {
    const raw = d.read(r);
    if (raw === undefined) continue;
    const v = onHundredScale(raw);
    if (v !== null) out.push({ respondentId: r.respondentId, value: v });
  }
  return out;
}

/** Overall investor experience: every ease / responsiveness / transparency rating pooled. */
function experienceValues(rows: ReportAnswerRow[]): Scored[] {
  return [
    ...dimensionValues(rows, 'ease'),
    ...dimensionValues(rows, 'responsiveness'),
    ...dimensionValues(rows, 'transparency'),
  ];
}

/**
 * The firm's 90-day agenda, read only from its own gaps. A difference within the
 * comparison margin makes no claim either way (the study's own rule), so an item
 * appears only where the evidence actually separates the firm.
 */
export function buildAgenda(
  dimensions: Array<{ label: string; firm: Rating; industry: Rating }>,
  selfGap: { firm: number | null; industry: number | null },
  margin: number,
): AgendaItem[] {
  const gaps = dimensions
    .filter((d) => d.firm.value !== null && d.industry.value !== null)
    .map((d) => ({ ...d, gap: (d.firm.value as number) - (d.industry.value as number) }));
  const agenda: AgendaItem[] = [];

  const weakest = [...gaps].sort((a, b) => a.gap - b.gap)[0];
  if (weakest && weakest.gap <= -margin) {
    agenda.push({
      priority: 'high',
      title: `Close the ${weakest.label.toLowerCase()} gap`,
      detail:
        `Your investors rate you ${weakest.firm.value} on ${weakest.label.toLowerCase()}, ` +
        `against an industry ${weakest.industry.value} — your widest shortfall, and the most ` +
        'direct lever on how clients experience you.',
    });
  }

  if (
    selfGap.firm !== null &&
    selfGap.industry !== null &&
    selfGap.firm - selfGap.industry >= margin
  ) {
    agenda.push({
      priority: 'medium',
      title: 'Narrow the distance between your view and your clients’',
      detail:
        `Your leadership’s self-view runs ${selfGap.firm - selfGap.industry} points further ` +
        'ahead of your investors’ experience than the industry’s does. The gap, not the score, ' +
        'is the thing to work on.',
    });
  }

  const strongest = [...gaps].sort((a, b) => b.gap - a.gap)[0];
  if (strongest && strongest.gap >= margin) {
    agenda.push({
      priority: 'sustain',
      title: `Protect your ${strongest.label.toLowerCase()} strength`,
      detail:
        `You rate ${strongest.firm.value} against an industry ${strongest.industry.value}. ` +
        'Hold it while you address the gaps above.',
    });
  }

  // "Within the margin on every dimension" is a claim, so it needs every
  // dimension to have been measured; with ratings withheld there is no agenda.
  if (agenda.length === 0 && gaps.length > 0 && gaps.length === dimensions.length) {
    agenda.push({
      priority: 'sustain',
      title: 'Hold your position',
      detail:
        `Your investors rate you within ${margin} points of the industry on every dimension ` +
        'measured — no difference the data can separate. Keep it there.',
    });
  }
  return agenda;
}

// ─── Builders ──────────────────────────────────────────────────────────────────

const INVESTOR_CODES = ['S4', 'S5a', 'S5b'];
const SEGMENT_LABEL: Record<string, string> = {
  firm: 'Stockbroking firms',
  retail: 'Retail investors',
  local_institution: 'Local institutional investors',
  foreign_institution: 'Foreign institutional investors',
};
/** Each institutional family's instrument, and the prefix of its five questions. */
const INSTITUTIONAL: Record<string, { code: string; q: string }> = {
  A: { code: 'I-SEC', q: 'I-SEC-Q' },
  B: { code: 'I-NGX', q: 'I-NGX-Q' },
  C: { code: 'I-CSCS', q: 'I-CSCS-Q' },
  D: { code: 'I-DEP', q: 'D-Q' },
};

/** The short names the market uses; anything else falls back to its initials. */
const SHORT_NAME: Record<string, string> = {
  'Securities and Exchange Commission': 'SEC',
  'Nigerian Exchange Limited': 'NGX',
  'Central Securities Clearing System': 'CSCS',
  'Lagos Commodities and Futures Exchange': 'LCFE',
  'NASD OTC Securities Exchange': 'NASD',
  'FMDQ Securities Exchange Limited': 'FMDQ',
  'FMDQ Clear Limited': 'FMDQ Clear',
  'FMDQ Depository Limited': 'FMDQ Depository',
};
export const shortNameOf = (name: string): string =>
  SHORT_NAME[name] ??
  name
    .split(/\s+/)
    .filter((w) => /^[A-Z]/.test(w))
    .map((w) => w[0])
    .join('');

/**
 * Operational themes, for reading the institutions together. Each institution's
 * instrument words its options for its own mandate; these group the wordings
 * that name the same area of operations.
 */
const THEMES: Array<{ theme: string; match: RegExp }> = [
  { theme: 'Documentation and record keeping', match: /document|record/i },
  { theme: 'Reconciliation', match: /reconcil/i },
  { theme: 'Technology and systems', match: /technolog|system|cyber/i },
  { theme: 'Manual processing', match: /manual|automat/i },
  { theme: 'Timeliness', match: /\blate\b|delay|timel/i },
  { theme: 'Controls, governance and compliance', match: /control|governance|compliance|kyc|aml/i },
  {
    theme: 'Trade and instruction accuracy',
    match: /incorrect|inaccurate|instruction|trade information/i,
  },
  { theme: 'Staff competence', match: /staff|competen/i },
  { theme: 'Communication', match: /communicat/i },
  { theme: 'Settlement coordination', match: /settlement/i },
];

export function institutionalThemes(readings: InstitutionalReading[]): {
  themes: Array<{ theme: string; codes: string[] }>;
  standsApart: string[];
} {
  const named = new Map<string, Set<string>>();
  for (const r of readings) {
    const labels = [
      ...(r.issue.greatest ? [r.issue.greatest] : []),
      ...r.issue.others,
      ...(r.consequence.greatest ? [r.consequence.greatest] : []),
      ...r.consequence.others,
    ];
    for (const { theme, match } of THEMES) {
      if (labels.some((l) => match.test(l))) {
        if (!named.has(theme)) named.set(theme, new Set());
        named.get(theme)!.add(r.code);
      }
    }
  }
  const themes = [...named.entries()]
    .map(([theme, codes]) => ({ theme, codes: [...codes].sort() }))
    .sort((a, b) => b.codes.length - a.codes.length || a.theme.localeCompare(b.theme));
  const institutions = [...new Set(readings.map((r) => r.code))];
  const standsApart =
    institutions.length < 2
      ? []
      : institutions.filter((code) =>
          themes.filter((t) => t.codes.includes(code)).every((t) => t.codes.length === 1),
        );
  return { themes, standsApart };
}

async function editionOf(pool: Pool, editionId: string) {
  const edition = await getEditionById(pool, editionId);
  if (!edition) throw new ReportContentError('Edition not found', 'NOT_FOUND');
  return { id: edition.id, label: edition.label, status: edition.status };
}

const ratingsOf = (rows: ReportAnswerRow[], read: (r: ReportAnswerRow) => unknown): Rating =>
  ratingByRespondent(
    rows.flatMap((r) => {
      const value = onHundredScale(read(r));
      return value === null ? [] : [{ respondentId: r.respondentId, value }];
    }),
  );

export async function buildIndustryReportContent(
  pool: Pool,
  editionId: string,
): Promise<IndustryReportContent> {
  const edition = await editionOf(pool, editionId);
  const report = await getLatestNationalReportForEdition(pool, editionId);
  const nameOf = new Map(NATIONAL_SECTIONS.map((s) => [s.id, s.name]));
  const sections = report
    ? (await getSections(pool, report.id)).map((s) => ({
        id: s.sectionId,
        name: nameOf.get(s.sectionId) ?? s.sectionId,
        disposition: s.disposition,
        reason: s.reason,
      }))
    : null;

  const sufficiency = await currentSegmentSufficiency(pool, editionId);
  const participation = Object.entries(SEGMENT_LABEL).map(([segment, label]) => ({
    segment,
    label,
    target: sufficiency[segment]?.floor ?? 0,
    achieved: sufficiency[segment]?.counted ?? 0,
    meets: !!sufficiency[segment]?.meets,
  }));

  const answers = await listSubmittedAnswers(pool, editionId, [
    'S1',
    'S3',
    ...INVESTOR_CODES,
    ...Object.values(INSTITUTIONAL).map((i) => i.code),
  ]);
  const of = (code: string, q?: string) =>
    answers.filter((a) => a.instrumentCode === code && (!q || a.questionId === q));
  const cited = (rows: ReportAnswerRow[]) =>
    rows.map((r) => ({ respondentId: r.respondentId, options: pickedOptions(r.answer) }));

  const local = of('S5a');
  const foreign = of('S5b');
  const q = (rows: ReportAnswerRow[], id: string) => rows.filter((r) => r.questionId === id);

  const roles = await listRegulators(pool, editionId);
  const single = (rows: ReportAnswerRow[]): string | null => {
    const a = rows[0]?.answer;
    return typeof a === 'string' ? a : null;
  };
  const greatestOf = (rows: ReportAnswerRow[]) => {
    const a = rows[0]?.answer;
    const picked = pickedOptions(a).filter((o) => o !== 'Other');
    const g = a && typeof a === 'object' ? (a as { greatest?: unknown }).greatest : undefined;
    const greatest = typeof g === 'string' && g !== 'Other' ? g : (picked[0] ?? null);
    return { greatest, others: picked.filter((o) => o !== greatest) };
  };
  const institutional: InstitutionalReading[] = roles
    .filter((r) => r.state === 'confirmed')
    .map((r) => {
      const inst = INSTITUTIONAL[r.familyCode]!;
      const rows = of(inst.code).filter((a) => a.institutionName === r.name);
      const issues = new Map<string, number>();
      for (const a of q(rows, `${inst.q}1`)) {
        for (const o of pickedOptions(a.answer)) {
          if (o !== 'Other') issues.set(o, (issues.get(o) ?? 0) + 1);
        }
      }
      const code = shortNameOf(r.name);
      return {
        key: `${r.familyCode}_${code.replace(/[^A-Za-z0-9]+/g, '')}`,
        role: r.name,
        code,
        familyCode: r.familyCode,
        vantage: r.mandate,
        responses: new Set(rows.map((a) => a.respondentId)).size,
        topIssues: [...issues.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 3)
          .map(([label, count]) => ({ label, count, pct: 0 })),
        issue: greatestOf(q(rows, `${inst.q}1`)),
        frequency: single(q(rows, `${inst.q}2`)),
        marks: pickedOptions(q(rows, `${inst.q}3`)[0]?.answer).filter((o) => o !== 'Other'),
        consequence: greatestOf(q(rows, `${inst.q}4`)),
        capability: single(q(rows, `${inst.q}5`)),
      };
    })
    .filter((r) => r.responses > 0);
  // Institutions, not roles: CSCS answering in two roles is one institution.
  const askedNames = new Set(
    roles.filter((r) => ['invited', 'confirmed', 'declined'].includes(r.state)).map((r) => r.name),
  );
  const institutionalParticipation = {
    invited: askedNames.size,
    contributed: new Set(institutional.map((r) => r.role)).size,
  };

  const investorRows = answers.filter((a) => INVESTOR_CODES.includes(a.instrumentCode));

  return {
    edition,
    generatedAt: new Date().toISOString(),
    sections,
    participation,
    indices: await buildIndices(pool, editionId, null),
    frictions: shareCiting(cited(of('S3', 'S3-Q1'))),
    frustrations: shareCiting(cited(of('S4', 'S4-Q9'))),
    participationImpact: shareYes(of('S4'), [
      { id: 'S4-Q6', label: 'Delayed or abandoned a transaction' },
      { id: 'S4-Q5', label: 'Reduced willingness to invest' },
      { id: 'S4-Q7', label: 'Moved assets or accounts elsewhere' },
    ]),
    confidenceLevers: shareCiting(cited(of('S5a', 'S5a-Q9')), 3),
    localVsForeign: {
      localN: new Set(local.map((r) => r.respondentId)).size,
      foreignN: new Set(foreign.map((r) => r.respondentId)).size,
      rows: [
        {
          label: 'Responsiveness / operational support',
          local: ratingsOf(q(local, 'S5a-Q1'), (r) => gridCell(r.answer, 'Responsiveness')),
          foreign: ratingsOf(q(foreign, 'S5b-Q2'), (r) => r.answer),
        },
        {
          label: 'Reporting quality',
          local: ratingsOf(q(local, 'S5a-Q1'), (r) => gridCell(r.answer, 'Reporting quality')),
          foreign: ratingsOf(q(foreign, 'S5b-Q3'), (r) => r.answer),
        },
        {
          label: 'Confidence in records',
          local: ratingsOf(q(local, 'S5a-Q5'), (r) => r.answer),
          foreign: ratingsOf(q(foreign, 'S5b-Q4'), (r) => r.answer),
        },
      ],
    },
    comparators: comparatorShares(of('S4', 'S4-Q8')),
    selfVsInvestors: {
      firmSelfBelief: ratingsOf(of('S1', 'S1-Q11'), (r) => r.answer),
      investorExperience: ratingByRespondent(experienceValues(investorRows)),
    },
    institutional,
    institutionalParticipation,
    institutionalThemes: institutionalThemes(institutional),
  };
}

export async function buildFirmReportContent(
  pool: Pool,
  editionId: string,
  firmId: string,
): Promise<FirmReportContent> {
  const edition = await editionOf(pool, editionId);
  const firmReport = (await listFirmReports(pool, editionId)).find(
    (r) => r.organizationId === firmId,
  );
  if (!firmReport) {
    throw new ReportContentError(
      'No report has been generated for this firm in this edition',
      'FIRM_REPORT_NOT_GENERATED',
    );
  }
  const org = (await listOrganizations(pool)).find((o) => o.id === firmId);
  const margin = (await getConfig<number>(pool, 'reporting.comparison_margin')) ?? 3;

  const answers = await listSubmittedAnswers(pool, editionId, ['S1', ...INVESTOR_CODES]);
  const investorRows = answers.filter((a) => INVESTOR_CODES.includes(a.instrumentCode));
  const aboutFirm = investorRows.filter((a) => a.ratedFirmId === firmId);

  const dimensions: InvestorDimension[] = DIMENSIONS.map((d) => ({
    key: d.key,
    label: d.label,
    sources: d.sources,
    firm: ratingByRespondent(dimensionValues(aboutFirm, d.key)),
    industry: ratingByRespondent(dimensionValues(investorRows, d.key)),
  }));

  const selfRows = answers.filter((a) => a.instrumentCode === 'S1' && a.questionId === 'S1-Q11');
  // One S1 seat per firm, so the firm's self-belief is ONE person's answer (the
  // MD/CEO seat). It is never shown as a figure: a single answer is not a
  // reading, and the report goes to the coordinator, who is promised never to
  // see a seat's answers. Only `n` (whether the seat answered) is kept.
  const ownSelf = selfRows.filter((a) => a.recruitingFirmId === firmId);
  const selfVsInvestors = {
    firmSelfBelief: ratingsOf(ownSelf, (r) => r.answer),
    investorExperience: ratingByRespondent(experienceValues(aboutFirm)),
    industrySelfBelief: ratingsOf(selfRows, (r) => r.answer),
    industryInvestorExperience: ratingByRespondent(experienceValues(investorRows)),
  };

  // Retail cut — S4 only, shown only where the firm's own retail volume allows it.
  const retailAbout = aboutFirm.filter((a) => a.instrumentCode === 'S4');
  const retailAll = investorRows.filter((a) => a.instrumentCode === 'S4');
  const retailDims = (
    [
      ['Retail · Ease', 'S4-Q1'],
      ['Retail · Responsiveness', 'S4-Q2'],
      ['Retail · Trust in records', 'S4-Q4'],
    ] as const
  ).map(([label, id]) => ({
    label,
    firm: ratingsOf(
      retailAbout.filter((r) => r.questionId === id),
      (r) => r.answer,
    ),
    industry: ratingsOf(
      retailAll.filter((r) => r.questionId === id),
      (r) => r.answer,
    ),
  }));
  const cutState = firmReport.cutState;

  const gapOf = (a: Rating, b: Rating) =>
    a.value === null || b.value === null ? null : a.value - b.value;

  return {
    edition,
    generatedAt: new Date().toISOString(),
    firm: { id: firmId, name: org?.displayName ?? 'Your firm' },
    report: {
      retailN: firmReport.retailN,
      cutState,
      approvalState: firmReport.approvalState,
      releaseState: firmReport.releaseState,
    },
    margin,
    indices: await buildIndices(pool, editionId, firmId),
    dimensions,
    selfVsInvestors,
    retailCut: {
      state: cutState,
      n: firmReport.retailN,
      // Below the threshold nothing is shown at this level — not even the numbers.
      dimensions: cutState === 'none' ? [] : retailDims,
    },
    agenda: buildAgenda(
      [...dimensions, ...(cutState === 'unlocked' ? retailDims : [])],
      {
        firm: gapOf(selfVsInvestors.firmSelfBelief, selfVsInvestors.investorExperience),
        industry: gapOf(
          selfVsInvestors.industrySelfBelief,
          selfVsInvestors.industryInvestorExperience,
        ),
      },
      margin,
    ),
  };
}

/**
 * The sections this Industry report will withhold, and why: every figure in
 * the section is below the 10-response floor, or the section is built on index
 * scores still pending methodology approval. The national report marks these
 * sections as not publishable, so its section table says what the report will
 * actually show (never "publishable" for a section that shows nothing).
 */
export function withheldSections(c: IndustryReportContent): Partial<Record<string, string>> {
  const pending =
    'Pending methodology approval: no index score is reported until the scoring methodology ' +
    '(CIS-SCORE-2026) has been approved by the methodology partner.';
  const floor = (who: string) =>
    `Fewer than ${SUPPRESS_BELOW} ${who} answered, so every figure in this section is withheld.`;
  const out: Partial<Record<string, string>> = {};
  if (c.indices.state === 'pending_methodology') {
    out['PUB_01_HEADLINE_INDICES'] = pending;
    out['PUB_02_SEGMENT_IEI_ICI'] = pending;
    out['PUB_05_MATURITY_HEATMAP'] = pending;
  } else {
    if (!c.indices.tiers) {
      out['PUB_05_MATURITY_HEATMAP'] = c.indices.tiersNote ?? 'Tiers are not drawn this edition.';
    }
    const seg = c.indices.segments;
    if (!seg.some((x) => x.iei.value !== null || x.ici.value !== null)) {
      out['PUB_02_SEGMENT_IEI_ICI'] = floor('investors in any one segment');
    }
  }
  if (!c.frictions) out['PUB_03_OPERATIONAL_FRICTIONS'] = floor('firms');
  if (!c.frustrations) out['PUB_04_INVESTOR_FRUSTRATIONS'] = floor('retail investors');
  if (!c.participationImpact && !c.confidenceLevers) {
    out['PUB_06_CONFIDENCE_AND_PARTICIPATION'] = floor('investors');
  }
  if (!c.localVsForeign.rows.some((r) => r.local.value !== null && r.foreign.value !== null)) {
    out['PUB_07_LOCAL_VS_FOREIGN'] = floor('local and foreign institutions each');
  }
  if (!c.comparators) out['PUB_08_CROSS_INDUSTRY_BENCHMARK'] = floor('retail investors');
  const sv = c.selfVsInvestors;
  if (sv.firmSelfBelief.value === null || sv.investorExperience.value === null) {
    out['PUB_09_SERVICE_EXCELLENCE_GAP'] = floor('firms or investors');
  }
  if (c.institutional.length === 0) {
    out['PUB_10_INSTITUTIONAL_PERSPECTIVES'] = 'No institution has given its reading.';
  }
  return out;
}

/**
 * The indices a report shows: the signed scoring run's own figures when that
 * run was made under the approved methodology, otherwise the pending notice.
 * Never a placeholder value: a run that is not approved shows no score.
 */
async function buildIndices(
  pool: Pool,
  editionId: string,
  firmId: string | null,
): Promise<Indices> {
  const signoff = await getAuthoritativeSignoff(pool, editionId);
  const run = signoff ? await getCalculationRun(pool, signoff.calculationRunId) : null;
  if (!run || run.methodologyStatus !== 'APPROVED') return INDICES_PENDING;

  const results = await listCalculatedResults(pool, run.id);
  const firmFloor =
    (await listSampleFloors(pool, editionId)).find((f) => f.category === 'firm')?.floorValue ??
    null;
  const round = (v: number | null) => (v === null ? null : Math.round(v));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  const industry = INDEX_NAMES.map(([code, name]): IndexScore => {
    const row = results.find(
      (r) => r.subjectType === 'market' && r.subjectId === 'INDUSTRY' && r.metricCode === code,
    );
    const n = row?.n ?? null;
    let note: string | null = null;
    if (!row || row.value === null) {
      note = row?.reason ?? 'Not calculable from this edition’s responses.';
    } else if ((code === 'OMI' || code === 'DMI') && n !== null) {
      note =
        firmFloor !== null && n < firmFloor
          ? `From ${plural(n, 'firm', 'firms')}, below the ${firmFloor}-firm floor — indicative only.`
          : `From ${plural(n, 'firm', 'firms')}.`;
    } else if (n !== null) {
      note = `Pooled from ${plural(n, 'investor', 'investors')} in segments that clear their floor.`;
    }
    return { code, name, value: round(row?.value ?? null), n, note };
  });

  const firm =
    firmId === null
      ? null
      : INDEX_NAMES.map(([code, name]): IndexScore => {
          const row = results.find(
            (r) => r.subjectType === 'firm' && r.subjectId === firmId && r.metricCode === code,
          );
          const n = row?.n ?? null;
          let note: string | null = null;
          if (!row || row.value === null) {
            note = 'Not calculable from your firm’s responses this edition.';
          } else if ((code === 'IEI' || code === 'ICI') && n !== null && n < SUPPRESS_BELOW) {
            note = `From ${plural(n, 'investor rating', 'investor ratings')} — fewer than ten, read with caution.`;
          }
          return { code, name, value: round(row?.value ?? null), n, note };
        });

  const units = await investorSegmentUnitScores(pool, editionId);
  const segments = (
    [
      ['retail', 'Retail investors', units.retail],
      ['local_institution', 'Local institutional investors', units.local],
      ['foreign_institution', 'Foreign institutional investors', units.foreign],
    ] as const
  ).map(([segment, label, u]) => ({ segment, label, iei: rating(u.iei), ici: rating(u.ici) }));

  // Maturity tiers: thirds by Firm_OMI, highest first.
  const firmValues = (code: string) =>
    new Map(
      results
        .filter((r) => r.subjectType === 'firm' && r.metricCode === code && r.value !== null)
        .map((r) => [r.subjectId, r.value as number]),
    );
  const omiByFirm = firmValues('OMI');
  const dmiByFirm = firmValues('DMI');
  const ranked = [...omiByFirm.entries()].sort((a, b) => b[1] - a[1]);
  let tiers: IndicesReported['tiers'] = null;
  let tiersNote: string | null = null;
  if (ranked.length < MIN_FIRMS_PER_TIER * 3) {
    tiersNote =
      `Tiers need at least ${MIN_FIRMS_PER_TIER * 3} firms with an operational-maturity score ` +
      `(${MIN_FIRMS_PER_TIER} per third), so that no tier's average points at a single firm; ` +
      `this edition has ${ranked.length}.`;
  } else {
    const size = Math.ceil(ranked.length / 3);
    tiers = ['Top third', 'Middle third', 'Bottom third'].map((tier, i) => {
      const group = ranked.slice(i * size, (i + 1) * size);
      const dmi = group
        .map(([id]) => dmiByFirm.get(id))
        .filter((v): v is number => v !== undefined);
      return {
        tier,
        firms: group.length,
        omi: Math.round(group.reduce((a, [, v]) => a + v, 0) / group.length),
        dmi: dmi.length ? Math.round(dmi.reduce((a, b) => a + b, 0) / dmi.length) : null,
      };
    });
    if (tiers.some((t) => t.firms < MIN_FIRMS_PER_TIER)) {
      tiers = null;
      tiersNote = `A tier would hold fewer than ${MIN_FIRMS_PER_TIER} firms, so tiers are not drawn.`;
    }
  }

  return {
    state: 'reported',
    methodology: run.methodologyVersion ?? 'approved methodology',
    runId: run.id,
    industry,
    firm,
    segments,
    tiers,
    tiersNote,
  };
}
