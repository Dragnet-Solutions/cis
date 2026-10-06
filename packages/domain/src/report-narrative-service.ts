import { Pool } from 'pg';
import {
  getLatestReportNarrative,
  getReportNarrativeById,
  getReportPublication,
  insertReportNarrative,
  type NarrativeFact,
  type NarrativeSentence,
  type ReportNarrative,
} from '@cis/db';
import { DomainError } from './errors';
import { checkSentence } from './national-report-service';
import {
  buildFirmReportContent,
  buildIndustryReportContent,
  type FirmReportContent,
  type IndustryReportContent,
} from './report-content-service';

/**
 * The AI-drafted prose of the two report documents.
 *
 * The model WRITES; it never computes. It is given the report's own computed
 * figures as a numbered list of facts and must return sentences that each cite
 * the fact ids they rest on. Every sentence is then checked before it can be
 * shown:
 *  - the existing adversarial checker (`checkSentence`): a sentence with no
 *    fact behind it, a BANDED figure quoted as a point value, or a causal claim
 *    the study cannot make is held back;
 *  - number grounding: every number in the sentence must be one its cited facts
 *    actually carry, so the model cannot introduce or alter a figure;
 *  - unknown fact ids and unknown sections are held back too.
 * A held-back sentence is stored with its finding (so an operator can see what
 * was withheld and why) but never rendered.
 *
 * Privacy: facts are aggregates only. A firm's name is never sent to the model
 * — it writes about "the firm", and the name is added when the report renders.
 */

export class ReportNarrativeError extends DomainError {
  constructor(message: string, code = 'REPORT_NARRATIVE') {
    super(message, code);
  }
}

/** A published document is frozen: its narrative can no longer be redrafted. */
export class ReportPublicationError extends DomainError {
  constructor(message: string, code = 'REPORT_PUBLICATION') {
    super(message, code);
  }
}

/** Whatever drafts the prose — the Azure AI Foundry client in production, a fake in tests. */
export interface NarrativeModel {
  /** The model / deployment name, recorded with every generation. */
  name: string;
  complete(system: string, user: string): Promise<string>;
}

// ─── Facts ─────────────────────────────────────────────────────────────────────

function fact(
  id: string,
  statement: string,
  numbers: number[],
  state = 'REPORTABLE',
): NarrativeFact {
  return { id, state, statement, numbers };
}

export function industryFacts(c: IndustryReportContent): NarrativeFact[] {
  const facts: NarrativeFact[] = [];
  for (const p of c.participation) {
    facts.push(
      fact(
        `PART.${p.segment}`,
        `${p.label}: ${p.achieved} took part against a study target of ${p.target}${p.meets ? ' (target met)' : ' (target not met)'}.`,
        [p.achieved, p.target],
      ),
    );
  }
  const fx = c.frictions;
  fx?.items.forEach((i, k) =>
    facts.push(
      fact(
        `FRICTION.${k + 1}`,
        `${i.pct}% of firms (${i.count} of ${fx.base}) cite "${i.label}" among the processes consuming the most staff time (rank ${k + 1}).`,
        [i.pct, i.count, fx.base, k + 1],
      ),
    ),
  );
  const fr = c.frustrations;
  fr?.items.forEach((i, k) =>
    facts.push(
      fact(
        `FRUSTRATION.${k + 1}`,
        `${i.pct}% of retail investors (${i.count} of ${fr.base}) cite "${i.label}" among their top three frustrations with a firm (rank ${k + 1}).`,
        [i.pct, i.count, fr.base, k + 1],
      ),
    ),
  );
  const pi = c.participationImpact;
  pi?.items.forEach((i, k) =>
    facts.push(
      fact(
        `IMPACT.${k + 1}`,
        `${i.pct}% of retail investors (${i.count} of ${pi.base}) report that service frustration led them to: ${i.label.toLowerCase()}.`,
        [i.pct, i.count, pi.base],
      ),
    ),
  );
  const lv = c.confidenceLevers;
  lv?.items.forEach((i, k) =>
    facts.push(
      fact(
        `LEVER.${k + 1}`,
        `${i.pct}% of local institutions (${i.count} of ${lv.base}) say "${i.label}" would most increase their confidence in Nigerian firms.`,
        [i.pct, i.count, lv.base],
      ),
    ),
  );
  c.localVsForeign.rows.forEach((r, k) => {
    if (r.local.value === null || r.foreign.value === null) return;
    const gap = r.foreign.value - r.local.value;
    facts.push(
      fact(
        `LVF.${k + 1}`,
        `${r.label}: local institutions rate ${r.local.value}/100, foreign institutions ${r.foreign.value}/100 (foreign ${gap >= 0 ? 'higher' : 'lower'} by ${Math.abs(gap)}).`,
        [r.local.value, r.foreign.value, Math.abs(gap), 100],
      ),
    );
  });
  c.comparators?.rows.forEach((r, k) =>
    facts.push(
      fact(
        `COMPARE.${k + 1}`,
        `Against "${r.comparator}", ${r.better}% of retail investors rate their stockbroker better, ${r.same}% about the same and ${r.worse}% worse (${r.n} comparisons).`,
        [r.better, r.same, r.worse, r.n],
      ),
    ),
  );
  const s = c.selfVsInvestors;
  if (s.firmSelfBelief.value !== null && s.investorExperience.value !== null) {
    const gap = s.firmSelfBelief.value - s.investorExperience.value;
    facts.push(
      fact(
        'SELF.1',
        `Firms rate their own success at meeting investor expectations ${s.firmSelfBelief.value}/100; investors rate their experience ${s.investorExperience.value}/100 — a gap of ${Math.abs(gap)} points, firms ${gap >= 0 ? 'higher' : 'lower'}.`,
        [s.firmSelfBelief.value, s.investorExperience.value, Math.abs(gap), 100],
      ),
    );
  }
  c.institutional.forEach((i) =>
    facts.push(
      fact(
        `INST.${i.familyCode}`,
        `${i.role}${i.familyCode === 'D' ? ' (depository role)' : ''} most often sees: ${i.topIssues.map((t) => t.label).join('; ') || 'no recurring issue named'}. It rates the profession's overall capability as "${i.capability ?? 'not stated'}".`,
        [],
        // A handful of institutions — qualitative only, never a figure.
        'BANDED',
      ),
    ),
  );
  return facts;
}

export function firmFacts(c: FirmReportContent): NarrativeFact[] {
  const facts: NarrativeFact[] = [];
  for (const d of c.dimensions) {
    if (d.firm.value === null || d.industry.value === null) continue;
    const gap = d.firm.value - d.industry.value;
    const reading =
      Math.abs(gap) < c.margin
        ? 'within the comparison margin, so no difference can be claimed'
        : gap > 0
          ? 'above the industry'
          : 'below the industry';
    facts.push(
      fact(
        `DIM.${d.key}`,
        `${d.label}: the firm's investors rate it ${d.firm.value}/100 against an industry ${d.industry.value}/100 (${gap >= 0 ? '+' : '−'}${Math.abs(gap)}; ${reading}).`,
        [d.firm.value, d.industry.value, Math.abs(gap), c.margin, 100],
      ),
    );
  }
  const s = c.selfVsInvestors;
  if (s.firmSelfBelief.value !== null && s.investorExperience.value !== null) {
    const gap = s.firmSelfBelief.value - s.investorExperience.value;
    const industryGap =
      s.industrySelfBelief.value !== null && s.industryInvestorExperience.value !== null
        ? s.industrySelfBelief.value - s.industryInvestorExperience.value
        : null;
    facts.push(
      fact(
        'SELF.1',
        `The firm's leadership rates its own success at meeting investor expectations ${s.firmSelfBelief.value}/100; its investors rate their experience ${s.investorExperience.value}/100 — a gap of ${Math.abs(gap)} points, leadership ${gap >= 0 ? 'higher' : 'lower'}${industryGap === null ? '' : `; across the industry the gap is ${Math.abs(industryGap)} points, firms ${industryGap >= 0 ? 'higher' : 'lower'} than their investors`}.`,
        [
          s.firmSelfBelief.value,
          s.investorExperience.value,
          Math.abs(gap),
          100,
          ...(industryGap === null ? [] : [Math.abs(industryGap)]),
        ],
      ),
    );
  }
  const cut = c.retailCut;
  facts.push(
    fact(
      'RETAIL.STATE',
      `The firm has ${cut.n} retail responses, so its retail cut is ${cut.state === 'unlocked' ? 'unlocked (30 or more)' : cut.state === 'directional' ? 'directional only (10 to 29)' : 'not shown (fewer than 10)'}.`,
      [cut.n, 10, 29, 30],
    ),
  );
  cut.dimensions.forEach((d, k) => {
    if (d.firm.value === null || d.industry.value === null) return;
    facts.push(
      fact(
        `RETAIL.${k + 1}`,
        `${d.label}: retail investors rate the firm ${d.firm.value}/100 against an industry ${d.industry.value}/100.`,
        [d.firm.value, d.industry.value, Math.abs(d.firm.value - d.industry.value), 100],
        // Directional only below 30 responses: an indication, never a point value.
        cut.state === 'unlocked' ? 'REPORTABLE' : 'BANDED',
      ),
    );
  });
  c.agenda.forEach((a, k) =>
    facts.push(
      fact(`AGENDA.${k + 1}`, `Priority ${k + 1} (${a.priority}): ${a.title}. ${a.detail}`, [
        k + 1,
        100,
        ...(a.detail.match(/\d+/g) ?? []).map(Number),
      ]),
    ),
  );
  return facts;
}

// ─── Sections the model writes for ─────────────────────────────────────────────

interface SectionBrief {
  key: string;
  brief: string;
}

const INDUSTRY_SECTIONS: SectionBrief[] = [
  {
    key: 'EXEC',
    brief: 'The headline: 2–3 sentences drawing the clearest pattern across all the facts.',
  },
  {
    key: 'PUB_03_OPERATIONAL_FRICTIONS',
    brief: 'Operational frictions (FRICTION.*): what firms report, and where it clusters.',
  },
  {
    key: 'PUB_04_INVESTOR_FRUSTRATIONS',
    brief: 'Investor frustrations (FRUSTRATION.*): what investors cite most.',
  },
  {
    key: 'PUB_06_CONFIDENCE_AND_PARTICIPATION',
    brief: 'Participation impact (IMPACT.*) and institutional confidence levers (LEVER.*).',
  },
  {
    key: 'PUB_07_LOCAL_VS_FOREIGN',
    brief: 'Local versus foreign institutional readings (LVF.*).',
  },
  {
    key: 'PUB_08_CROSS_INDUSTRY_BENCHMARK',
    brief: 'Stockbrokers against banks and fintechs (COMPARE.*).',
  },
  {
    key: 'PUB_09_SERVICE_EXCELLENCE_GAP',
    brief: 'Firms’ self-view against investors’ experience (SELF.1).',
  },
  {
    key: 'PUB_10_INSTITUTIONAL_PERSPECTIVES',
    brief: 'Institutional perspectives (INST.*), qualitatively — no figures.',
  },
  { key: 'CLOSING', brief: 'A closing reflection, 2 sentences: from a reading to a trajectory.' },
];

const FIRM_SECTIONS: SectionBrief[] = [
  {
    key: 'SUMMARY',
    brief: 'The firm’s signature: 2–3 sentences on its clearest strength and gap.',
  },
  { key: 'F2', brief: 'How the firm’s own investors experience it against the industry (DIM.*).' },
  { key: 'F3', brief: 'The firm’s self-view against its investors’ experience (SELF.1).' },
  { key: 'F4', brief: 'The retail cut (RETAIL.*), respecting its state.' },
  { key: 'AGENDA', brief: 'One or two sentences introducing the 90-day agenda (AGENDA.*).' },
];

const BANNED_CAUSAL = [
  'because',
  'so that',
  'would reduce',
  'reduces complaints',
  'leads to',
  'causes',
  'due to',
  'drives',
];

export function buildNarrativePrompt(
  audience: string,
  facts: NarrativeFact[],
  sections: SectionBrief[],
): { system: string; user: string } {
  const system = [
    `You draft the prose for ${audience} of the CIS-Dragnet benchmark study of Nigerian stockbroking.`,
    'Write in calm, plain, authoritative British English, like a professional benchmark report.',
    'Rules — a sentence that breaks any of them is discarded:',
    '1. Use ONLY the facts provided. Never add a figure, a comparison, or a claim that is not in them.',
    '2. Every sentence must cite, in "factIds", the id of every fact it relies on.',
    '3. Write every figure in digits (e.g. "33%", "5 points") — never as words such as "a third" or "four in five" — and only figures that appear in a fact you cite. Do no new arithmetic.',
    '4. A fact marked BANDED must never be quoted as a number or a percentage.',
    `5. Report what respondents say; never claim cause, effect or what will happen. Never use: ${BANNED_CAUSAL.map((w) => `"${w}"`).join(', ')}, "eroding", "results in", "contributes to", "could", "will".`,
    '6. Whenever you quote a gap, say which side is higher (e.g. "firms rate themselves 4 points lower than their investors").',
    '7. Never name or rank any firm. Never invent a firm, person or institution.',
    'Return ONLY a JSON object, no prose around it, shaped exactly as:',
    '{"sections": {"<SECTION KEY>": [{"text": "<one sentence>", "factIds": ["<fact id>"]}]}}',
    'Write 2–4 sentences per section. Omit a section entirely if no fact supports it.',
  ].join('\n');
  const user = [
    'SECTIONS TO WRITE:',
    ...sections.map((s) => `- ${s.key}: ${s.brief}`),
    '',
    'FACTS:',
    ...facts.map((f) => `[${f.id}] (${f.state}) ${f.statement}`),
  ].join('\n');
  return { system, user };
}

// ─── Parsing & checking ────────────────────────────────────────────────────────

/** The model's JSON — tolerant of a reasoning preamble or a fenced block around it. */
export function parseModelSections(
  raw: string,
): Record<string, Array<{ text: string; factIds: string[] }>> {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = withoutThinking.indexOf('{');
  const end = withoutThinking.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new ReportNarrativeError('The model did not return a JSON narrative', 'MODEL_BAD_OUTPUT');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutThinking.slice(start, end + 1));
  } catch {
    throw new ReportNarrativeError('The model returned malformed JSON', 'MODEL_BAD_OUTPUT');
  }
  const sections = (parsed as { sections?: unknown }).sections;
  if (!sections || typeof sections !== 'object') {
    throw new ReportNarrativeError('The model returned no sections', 'MODEL_BAD_OUTPUT');
  }
  const out: Record<string, Array<{ text: string; factIds: string[] }>> = {};
  for (const [key, value] of Object.entries(sections as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    out[key] = value
      .filter((s): s is { text?: unknown; factIds?: unknown } => !!s && typeof s === 'object')
      .map((s) => ({
        text: typeof s.text === 'string' ? s.text.trim() : '',
        factIds: Array.isArray(s.factIds)
          ? s.factIds.filter((x): x is string => typeof x === 'string')
          : [],
      }))
      .filter((s) => s.text.length > 0);
  }
  return out;
}

/** Every number written in a sentence, digits only. */
function numbersIn(text: string): number[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** Figures written as words — invisible to the digit check, so held back unless
 *  the cited facts themselves use the same words ("top three"). */
const NUMBER_WORDS =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|third|thirds|quarter|quarters|fifth|fifths|majority|minority)\b/gi;

/** Causal, consequential or speculative wording the narrow causal list misses. */
const SPECULATIVE =
  /\b(?:erod\w*|results? in|resulting in|contribut\w* to|could|will|undermin\w*|caus\w*|driv\w*)\b/gi;

/** A gap quoted without its direction: "a gap of 4" reads the same whether firms
 *  rate themselves 4 above their investors or 4 below. When a cited fact says
 *  which way a gap runs, the sentence must say so too. */
const GAP = /\bgaps?\b/i;
const FACT_DIRECTION = /\b(?:higher|lower)\b/i;
const DIRECTION =
  /\b(?:higher|lower|above|below|ahead|behind|exceed\w*|under\w*|over\w*|more|less)\b/i;

/** Words of a pattern in the sentence that none of its cited facts' statements contain. */
function unsupportedWords(text: string, pattern: RegExp, statements: string): string[] {
  const facts = statements.toLowerCase();
  return [...new Set((text.match(pattern) ?? []).map((w) => w.toLowerCase()))].filter(
    (w) => !new RegExp(`\\b${w}\\b`).test(facts),
  );
}

/**
 * Check one drafted sentence. Returns why it is held back, or null.
 * `alwaysAllowed` covers numbers that need no fact (the edition year).
 */
export function checkNarrativeSentence(
  sentence: { text: string; factIds: string[] },
  factsById: Map<string, NarrativeFact>,
  alwaysAllowed: number[] = [],
): { kind: string; why: string } | null {
  const unknown = sentence.factIds.filter((id) => !factsById.has(id));
  if (unknown.length) {
    return {
      kind: 'UNKNOWN FACT ID',
      why: `Cites ${unknown.join(', ')}, which is not one of the facts it was given.`,
    };
  }
  const existing = checkSentence(
    { ordinal: 0, text: sentence.text, factIds: sentence.factIds },
    new Map([...factsById].map(([id, f]) => [id, { id, state: f.state }])),
  );
  if (existing) return existing;
  const allowed = new Set([
    ...alwaysAllowed,
    ...sentence.factIds.flatMap((id) => factsById.get(id)?.numbers ?? []),
  ]);
  const stray = numbersIn(sentence.text).filter((n) => !allowed.has(n));
  if (stray.length) {
    return {
      kind: 'NUMBER NOT IN CITED FACTS',
      why: `States ${stray.join(', ')}, which none of its cited facts carries.`,
    };
  }
  const statements = sentence.factIds.map((id) => factsById.get(id)?.statement ?? '').join(' ');
  const wordFigures = unsupportedWords(sentence.text, NUMBER_WORDS, statements);
  if (wordFigures.length) {
    return {
      kind: 'FIGURE WRITTEN IN WORDS',
      why: `Writes "${wordFigures.join('", "')}" as words, which the figure check cannot verify.`,
    };
  }
  const speculative = unsupportedWords(sentence.text, SPECULATIVE, statements);
  if (speculative.length) {
    return {
      kind: 'UNSUPPORTED CAUSAL CLAIM',
      why: `"${speculative.join('", "')}" asserts a cause, effect or outcome the study does not measure.`,
    };
  }
  if (
    GAP.test(sentence.text) &&
    FACT_DIRECTION.test(statements) &&
    !DIRECTION.test(sentence.text)
  ) {
    return {
      kind: 'GAP WITHOUT DIRECTION',
      why: 'Quotes a gap without saying which side is higher, which its cited facts state.',
    };
  }
  return null;
}

async function draft(
  model: NarrativeModel,
  audience: string,
  facts: NarrativeFact[],
  sections: SectionBrief[],
  alwaysAllowed: number[],
): Promise<NarrativeSentence[]> {
  if (facts.length === 0) {
    throw new ReportNarrativeError(
      'There are no figures to write about yet — too few responses have been received.',
      'NO_FACTS',
    );
  }
  const { system, user } = buildNarrativePrompt(audience, facts, sections);
  const bySection = parseModelSections(await model.complete(system, user));
  const allowedSections = new Set(sections.map((s) => s.key));
  const factsById = new Map(facts.map((f) => [f.id, f]));
  const sentences: NarrativeSentence[] = [];
  for (const [section, items] of Object.entries(bySection)) {
    for (const item of items) {
      const finding = allowedSections.has(section)
        ? checkNarrativeSentence(item, factsById, alwaysAllowed)
        : { kind: 'UNKNOWN SECTION', why: `"${section}" is not a section of this report.` };
      sentences.push({ section, text: item.text, factIds: item.factIds, finding });
    }
  }
  if (sentences.length === 0) {
    throw new ReportNarrativeError('The model returned no sentences', 'MODEL_BAD_OUTPUT');
  }
  return sentences;
}

// ─── Generation ────────────────────────────────────────────────────────────────

export async function generateIndustryNarrative(
  pool: Pool,
  editionId: string,
  model: NarrativeModel,
  createdBy: string,
): Promise<ReportNarrative> {
  await assertNotPublished(pool, editionId, 'industry', null);
  return draftIndustry(
    pool,
    editionId,
    await buildIndustryReportContent(pool, editionId),
    model,
    createdBy,
  );
}

async function draftIndustry(
  pool: Pool,
  editionId: string,
  content: IndustryReportContent,
  model: NarrativeModel,
  createdBy: string,
): Promise<ReportNarrative> {
  // Never ask for prose about a section the national report suppressed.
  const suppressed = new Set(
    (content.sections ?? []).filter((s) => s.disposition === 'suppressed').map((s) => s.id),
  );
  const facts = industryFacts(content);
  const sentences = await draft(
    model,
    'the public Industry report',
    facts,
    INDUSTRY_SECTIONS.filter((s) => !suppressed.has(s.key)),
    [Number(content.edition.label)].filter(Number.isFinite),
  );
  return insertReportNarrative(pool, {
    editionId,
    kind: 'industry',
    subjectId: null,
    sentences,
    facts,
    model: model.name,
    createdBy,
  });
}

export async function generateFirmNarrative(
  pool: Pool,
  editionId: string,
  firmId: string,
  model: NarrativeModel,
  createdBy: string,
): Promise<ReportNarrative> {
  await assertNotPublished(pool, editionId, 'firm', firmId);
  const content = await buildFirmReportContent(pool, editionId, firmId);
  return draftFirm(pool, editionId, firmId, content, model, createdBy);
}

async function draftFirm(
  pool: Pool,
  editionId: string,
  firmId: string,
  content: FirmReportContent,
  model: NarrativeModel,
  createdBy: string,
): Promise<ReportNarrative> {
  const facts = firmFacts(content);
  const sentences = await draft(
    model,
    'a single firm’s private report (refer to it only as "the firm" or "your firm")',
    facts,
    FIRM_SECTIONS.filter((s) => s.key !== 'F4' || content.retailCut.state !== 'none'),
    [Number(content.edition.label)].filter(Number.isFinite),
  );
  return insertReportNarrative(pool, {
    editionId,
    kind: 'firm',
    subjectId: firmId,
    sentences,
    facts,
    model: model.name,
    createdBy,
  });
}

/**
 * The narrative in force: the one frozen into the document when it was
 * published (released to its firm, or the Industry report made public), else
 * the latest drafted.
 */
async function narrativeInForce(
  pool: Pool,
  editionId: string,
  kind: 'industry' | 'firm',
  subjectId: string | null,
): Promise<ReportNarrative | null> {
  const published = await getReportPublication(pool, editionId, kind, subjectId);
  if (published) return getReportNarrativeById(pool, published.narrativeId);
  return getLatestReportNarrative(pool, editionId, kind, subjectId);
}

async function assertNotPublished(
  pool: Pool,
  editionId: string,
  kind: 'industry' | 'firm',
  subjectId: string | null,
): Promise<void> {
  if (await getReportPublication(pool, editionId, kind, subjectId)) {
    throw new ReportPublicationError(
      kind === 'firm'
        ? 'This report has been released to its firm, so its analysis is final and cannot be redrafted.'
        : 'The Industry report has been published, so its analysis is final and cannot be redrafted.',
      'ALREADY_PUBLISHED',
    );
  }
}

export function getIndustryNarrative(pool: Pool, editionId: string) {
  return narrativeInForce(pool, editionId, 'industry', null);
}

export function getFirmNarrative(pool: Pool, editionId: string, firmId: string) {
  return narrativeInForce(pool, editionId, 'firm', firmId);
}

// ─── Drafted by default ───────────────────────────────────────────────────────

/**
 * Whether a report needs (re)drafting: it has figures to write about, and the
 * narrative in force is missing or was written from figures that have since
 * changed. Compared field by field, since the stored facts round-trip through
 * jsonb and lose their key order.
 */
export function narrativeDue(current: NarrativeFact[], narrative: ReportNarrative | null): boolean {
  if (current.length === 0) return false;
  if (!narrative) return true;
  const key = (f: NarrativeFact) => `${f.id}|${f.state}|${f.statement}|${f.numbers.join(',')}`;
  const a = current.map(key);
  const b = narrative.facts.map(key);
  return a.length !== b.length || a.some((k, i) => k !== b[i]);
}

/** One drafting per report at a time: concurrent callers share the same call. */
const inFlight = new Map<string, Promise<ReportNarrative | null>>();
function once(
  key: string,
  run: () => Promise<ReportNarrative | null>,
): Promise<ReportNarrative | null> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * The narrative in force, drafted first if it is due — so nobody has to ask
 * for it. Null only while there are no figures to write about yet.
 */
export function ensureIndustryNarrative(
  pool: Pool,
  editionId: string,
  model: () => NarrativeModel,
  createdBy: string,
): Promise<ReportNarrative | null> {
  return once(`industry:${editionId}`, async () => {
    if (await getReportPublication(pool, editionId, 'industry', null)) {
      return getIndustryNarrative(pool, editionId);
    }
    const content = await buildIndustryReportContent(pool, editionId);
    const narrative = await getIndustryNarrative(pool, editionId);
    if (!narrativeDue(industryFacts(content), narrative)) return narrative;
    return draftIndustry(pool, editionId, content, model(), createdBy);
  });
}

export function ensureFirmNarrative(
  pool: Pool,
  editionId: string,
  firmId: string,
  model: () => NarrativeModel,
  createdBy: string,
): Promise<ReportNarrative | null> {
  return once(`firm:${editionId}:${firmId}`, async () => {
    if (await getReportPublication(pool, editionId, 'firm', firmId)) {
      return getFirmNarrative(pool, editionId, firmId);
    }
    const content = await buildFirmReportContent(pool, editionId, firmId);
    const narrative = await getFirmNarrative(pool, editionId, firmId);
    if (!narrativeDue(firmFacts(content), narrative)) return narrative;
    return draftFirm(pool, editionId, firmId, content, model(), createdBy);
  });
}
