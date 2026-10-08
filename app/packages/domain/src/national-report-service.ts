import { Pool } from 'pg';
import {
  createNationalReport,
  getNationalReport,
  markDraftOpened,
  setNationalRequest,
  approveNationalReport as dbApprove,
  insertSection,
  listSections,
  insertSentence,
  listSentences,
  insertFinding,
  listFindingsForReport,
  insertDisposition,
  listDispositionsForReport,
  insertAdversaryHealth,
  getLatestAdversaryHealth,
  getCalculationRun,
  hasSignedOffRun,
} from '@cis/db';
import type {
  NationalReport,
  NationalReportSection,
  NationalReportSectionId,
  SectionSufficiencyDisposition,
  ReviewDisposition,
  AdversaryHealth,
} from '@cis/shared-types';
import { DomainError } from './errors';
import { assertRunOfficialUsable } from './candidate-scoring-service';

/**
 * National report — one report, ten fixed sections, generator + adversarial
 * sentence-level review + human disposition + approval. Deliberately NOT the
 * same pipeline as the firm reports (UX-ADM-006): the guarantee semantics differ.
 */

export class NationalReportError extends DomainError {
  constructor(message: string, code = 'NATIONAL_REPORT') {
    super(message, code);
  }
}

// ─── The ten sections — a closed set the generator may not extend ────────────

export interface SectionSpec {
  id: NationalReportSectionId;
  name: string;
  provenance: string;
  /** How this section's sufficiency behaves — the two adjacent rules that look
   *  alike and are not (§2 caveats, §7 suppresses), plus §10's all-three rule. */
  rule: 'standard' | 'caveat_when_thin' | 'suppress_below_floor' | 'requires_all_regulators';
}

export const NATIONAL_SECTIONS: readonly SectionSpec[] = [
  {
    id: 'PUB_01_HEADLINE_INDICES',
    name: 'The five headline scores',
    provenance: 'Signed',
    rule: 'standard',
  },
  {
    id: 'PUB_02_SEGMENT_IEI_ICI',
    name: 'IEI and ICI by investor segment',
    provenance: 'Signed',
    rule: 'caveat_when_thin',
  },
  {
    id: 'PUB_03_OPERATIONAL_FRICTIONS',
    name: 'Top operational frictions',
    provenance: 'Signed',
    rule: 'standard',
  },
  {
    id: 'PUB_04_INVESTOR_FRUSTRATIONS',
    name: 'Top investor frustrations',
    provenance: 'Signed',
    rule: 'standard',
  },
  {
    id: 'PUB_05_MATURITY_HEATMAP',
    name: 'Maturity heatmap by firm tier',
    provenance: 'Signed, Design tiering',
    rule: 'standard',
  },
  {
    id: 'PUB_06_CONFIDENCE_AND_PARTICIPATION',
    name: 'Confidence drivers, barriers, and participation impact',
    provenance: 'Signed',
    rule: 'standard',
  },
  {
    id: 'PUB_07_LOCAL_VS_FOREIGN',
    name: 'Local vs. foreign institutional comparison',
    provenance: 'Signed',
    rule: 'suppress_below_floor',
  },
  {
    id: 'PUB_08_CROSS_INDUSTRY_BENCHMARK',
    name: 'Brokers against banks and fintechs',
    provenance: 'Signed',
    rule: 'standard',
  },
  {
    id: 'PUB_09_SERVICE_EXCELLENCE_GAP',
    name: 'The Service Excellence gap',
    provenance: 'Signed',
    rule: 'standard',
  },
  {
    id: 'PUB_10_INSTITUTIONAL_PERSPECTIVES',
    name: 'Institutional Perspectives',
    provenance: 'Signed, contextual',
    rule: 'requires_all_regulators',
  },
] as const;

const SECTION_IDS = new Set<string>(NATIONAL_SECTIONS.map((s) => s.id));

/** The generator may only emit a section from the closed set. */
export function assertSectionId(id: string): asserts id is NationalReportSectionId {
  if (!SECTION_IDS.has(id)) {
    throw new NationalReportError(`${id} is not one of the ten report sections`, 'UNKNOWN_SECTION');
  }
}

export interface SufficiencyContext {
  /** Distinct-count vs floor per investor segment. */
  segments: Record<string, { meets: boolean; thin: boolean }>;
  /** How many of the three regulators (SEC/NGX/CSCS) have engaged (0–3). */
  regulatorsEngaged: number;
}

/**
 * Evaluate one section's sufficiency by ITS OWN rule. §2 caveats a thin segment
 * (still published, marked); §7 suppresses outright below floor (a comparison
 * against a below-floor segment reads as a finding about the segment, not the
 * sample); §10 requires all three regulators (two is not the module).
 */
export function evaluateSection(
  spec: SectionSpec,
  ctx: SufficiencyContext,
): { disposition: SectionSufficiencyDisposition; reason: string | null } {
  switch (spec.rule) {
    case 'caveat_when_thin': {
      const thin = Object.values(ctx.segments).some((s) => s.thin);
      return thin
        ? { disposition: 'caveated', reason: 'A thin investor segment is caveated, not dropped.' }
        : { disposition: 'publishable', reason: null };
    }
    case 'suppress_below_floor': {
      const local = ctx.segments['local_institution'];
      const foreign = ctx.segments['foreign_institution'];
      const bothClear = !!local?.meets && !!foreign?.meets;
      return bothClear
        ? { disposition: 'publishable', reason: null }
        : {
            disposition: 'suppressed',
            reason:
              'A comparison against a segment below its floor reads as a finding about that ' +
              'segment rather than about the sample, so it is suppressed rather than caveated.',
          };
    }
    case 'requires_all_regulators': {
      return ctx.regulatorsEngaged >= 3
        ? { disposition: 'publishable', reason: null }
        : {
            disposition: 'suppressed',
            reason:
              `Institutional Perspectives needs all three regulators; ` +
              `${ctx.regulatorsEngaged} of 3 engaged. Two of three is not the module — omitting ` +
              `clearing and settlement would misrepresent it rather than shorten it.`,
          };
    }
    default:
      return { disposition: 'publishable', reason: null };
  }
}

/** Create a report and evaluate all ten sections against the current context.
 *  Iterates the fixed catalogue, so it can never produce an eleventh section. */
export async function generateNationalReport(
  pool: Pool,
  data: { editionId: string; scoringRunId: string; context: SufficiencyContext },
): Promise<{ report: NationalReport; sections: NationalReportSection[] }> {
  // Hard methodology gate (Phase 11, build note §2): AI report generation is an
  // official-output path. A TEST_UNAPPROVED scoring run can never be its input.
  await assertRunOfficialUsable(pool, data.scoringRunId, 'national report generation');

  const report = await createNationalReport(pool, {
    editionId: data.editionId,
    scoringRunId: data.scoringRunId,
  });
  const sections: NationalReportSection[] = [];
  for (const spec of NATIONAL_SECTIONS) {
    const { disposition, reason } = evaluateSection(spec, data.context);
    sections.push(
      await insertSection(pool, {
        nationalReportId: report.id,
        sectionId: spec.id,
        disposition,
        ...(reason !== null ? { reason } : {}),
      }),
    );
  }
  return { report, sections };
}

// ─── Sentence-level adversarial checker ──────────────────────────────────────

export interface DraftFact {
  id: string;
  state: string; // REPORTABLE | BANDED | ...
}
export interface DraftSentence {
  ordinal: number;
  text: string;
  factIds: string[];
}

const CAUSAL_MARKERS =
  /\b(because|so that|would reduce|reduces complaints|leads to|causes|due to|drives)\b/i;
const POINT_VALUE = /(\d+(\.\d+)?\s*(%|per cent))|nearly \d+/i;

/** A factual sentence with no fact IDs is unsupported BY CONSTRUCTION — not by
 *  adversary opinion. This is deterministic and is the anchor of adversary health. */
export function isUnsupportedByConstruction(sentence: DraftSentence): boolean {
  return sentence.factIds.length === 0;
}

/**
 * The adversarial checker. It flags; it never rewrites. Returns a finding or null.
 * A numeric check cannot see a causal sentence, so the checker reads the sentence
 * as well as its fact states.
 */
export function checkSentence(
  sentence: DraftSentence,
  factsById: Map<string, DraftFact>,
): { kind: string; why: string } | null {
  if (isUnsupportedByConstruction(sentence)) {
    return {
      kind: 'NO SUPPORTING FACT IDS',
      why: 'A factual sentence with nothing behind it is unsupported by definition.',
    };
  }
  const cited = sentence.factIds.map((id) => factsById.get(id)).filter(Boolean) as DraftFact[];
  if (cited.some((f) => f.state === 'BANDED') && POINT_VALUE.test(sentence.text)) {
    return {
      kind: 'BANDED FACT REPORTED AS A POINT VALUE',
      why: 'A BANDED fact carries no point value; at this sample a proportion approaches identifiability.',
    };
  }
  if (CAUSAL_MARKERS.test(sentence.text)) {
    return {
      kind: 'UNSUPPORTED CAUSAL CLAIM',
      why: 'The sentence asserts a relationship the pack does not contain. The study measures; it does not establish cause.',
    };
  }
  return null;
}

/** Persist a generated draft (the AI generator's output; it computes nothing). */
export async function saveNationalDraft(
  pool: Pool,
  nationalReportId: string,
  sentences: DraftSentence[],
): Promise<void> {
  for (const s of sentences) {
    await insertSentence(pool, {
      nationalReportId,
      ordinal: s.ordinal,
      text: s.text,
      factIds: s.factIds,
    });
  }
}

/** Run the checker over the saved draft, persisting a finding per flagged sentence. */
export async function runChecker(
  pool: Pool,
  nationalReportId: string,
  facts: DraftFact[],
): Promise<number> {
  const factsById = new Map(facts.map((f) => [f.id, f]));
  const sentences = await listSentences(pool, nationalReportId);
  let flagged = 0;
  for (const s of sentences) {
    const finding = checkSentence(
      { ordinal: s.ordinal, text: s.text, factIds: s.factIds },
      factsById,
    );
    if (finding) {
      await insertFinding(pool, { sentenceId: s.id, kind: finding.kind, why: finding.why });
      flagged += 1;
    }
  }
  return flagged;
}

// ─── Adversary health ─────────────────────────────────────────────────────────

/** A seeded claim the checker SHOULD flag, with the fact context to judge it. */
export interface SeededClaim {
  sentence: DraftSentence;
  facts: DraftFact[];
}

export const ADVERSARY_HEALTH_THRESHOLD = 0.8;

/**
 * Measure the checker against a seeded set of known-unsupported claims. A clean
 * draft and a broken checker look identical, so a zero-finding run is only
 * reassuring when the checker is known to be finding things. Persists the result;
 * the health gates approval.
 */
export async function runAdversaryHealth(
  pool: Pool,
  nationalReportId: string,
  seeded: SeededClaim[],
  threshold: number = ADVERSARY_HEALTH_THRESHOLD,
): Promise<AdversaryHealth> {
  let detected = 0;
  for (const claim of seeded) {
    const finding = checkSentence(claim.sentence, new Map(claim.facts.map((f) => [f.id, f])));
    if (finding) detected += 1;
  }
  const rate = seeded.length === 0 ? 0 : detected / seeded.length;
  const healthy = rate >= threshold;
  return insertAdversaryHealth(pool, {
    nationalReportId,
    seededTotal: seeded.length,
    detected,
    thresholdRate: threshold,
    healthy,
  });
}

// ─── Dispositions ──────────────────────────────────────────────────────────────

export async function disposeFinding(
  pool: Pool,
  data: {
    findingId: string;
    disposition: ReviewDisposition;
    reason?: string | null;
    disposedBy: string;
  },
): Promise<void> {
  if (data.disposition === 'REJECT_WITH_REASON' && !(data.reason && data.reason.trim())) {
    throw new NationalReportError(
      'Rejecting a finding requires a reason',
      'REJECT_REASON_REQUIRED',
    );
  }
  await insertDisposition(pool, data);
}

// ─── Approval preconditions & approval ───────────────────────────────────────

export interface ApprovalPreconditions {
  signedScoringRun: boolean;
  draftOpened: boolean;
  allFindingsDisposed: boolean;
  checkerHealthy: boolean;
  ok: boolean;
  reasons: string[];
}

/** The four preconditions, each independently reported. */
export async function nationalApprovalPreconditions(
  pool: Pool,
  reportId: string,
): Promise<ApprovalPreconditions> {
  const report = await getNationalReport(pool, reportId);
  if (!report) throw new NationalReportError('Report not found', 'NOT_FOUND');

  // A run backs a report only if it carries a GENUINE signed-off record from the
  // UX-ADM-004 maker-checker flow — not merely a `completed` status (the Phase 6
  // stopgap this replaces). Signing a run off is the deliberate act that makes
  // its numbers official; a completed-but-unsigned run must not back a report.
  const run = await getCalculationRun(pool, report.scoringRunId);
  const signedScoringRun =
    !!run &&
    run.runType === 'scoring' &&
    run.status === 'complete' &&
    (await hasSignedOffRun(pool, run.id));

  const findings = await listFindingsForReport(pool, reportId);
  const dispositions = await listDispositionsForReport(pool, reportId);
  const disposedIds = new Set(dispositions.map((d) => d.findingId));
  const allFindingsDisposed = findings.every((f) => disposedIds.has(f.id));

  const health = await getLatestAdversaryHealth(pool, reportId);
  const checkerHealthy = !!health && health.healthy;

  const reasons: string[] = [];
  if (!signedScoringRun) reasons.push('No signed-off scoring run.');
  if (!report.draftOpened) reasons.push('The draft has not been opened.');
  if (!allFindingsDisposed) reasons.push('Not every checker finding has a disposition.');
  if (!checkerHealthy) reasons.push('The checker is below its detection threshold.');

  return {
    signedScoringRun,
    draftOpened: report.draftOpened,
    allFindingsDisposed,
    checkerHealthy,
    ok: reasons.length === 0,
    reasons,
  };
}

export async function openDraft(pool: Pool, reportId: string): Promise<void> {
  await markDraftOpened(pool, reportId);
}

export async function requestNationalApproval(
  pool: Pool,
  reportId: string,
  data: { requestedBy: string; reason: string },
): Promise<void> {
  const pre = await nationalApprovalPreconditions(pool, reportId);
  if (!pre.ok) throw new NationalReportError(pre.reasons.join(' '), 'PRECONDITIONS_UNMET');
  await setNationalRequest(pool, reportId, {
    requestedBy: data.requestedBy,
    requestedReason: data.reason,
  });
}

/**
 * Approve for release. All four preconditions must hold, and the approver must be
 * a different person from the requester (maker-checker).
 */
export async function approveNational(
  pool: Pool,
  reportId: string,
  approvedBy: string,
): Promise<NationalReport> {
  const report = await getNationalReport(pool, reportId);
  if (!report) throw new NationalReportError('Report not found', 'NOT_FOUND');

  const pre = await nationalApprovalPreconditions(pool, reportId);
  if (!pre.ok) throw new NationalReportError(pre.reasons.join(' '), 'PRECONDITIONS_UNMET');

  if (report.requestedBy && report.requestedBy === approvedBy) {
    throw new NationalReportError(
      'The approver must be a different person from the requester',
      'SELF_APPROVAL',
    );
  }
  return dbApprove(pool, reportId, approvedBy);
}

export async function getSections(pool: Pool, reportId: string): Promise<NationalReportSection[]> {
  return listSections(pool, reportId);
}
