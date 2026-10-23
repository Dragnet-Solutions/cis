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
  getLatestReportNarrative,
  getReportPublication,
  listReviewItems,
  getNarrativeCheckerHealth,
  recordNationalReportOpening,
  hasOpenedNationalReport,
  createCriticalAction,
  getPendingCriticalActionForEdition,
  withTransaction,
} from '@cis/db';
import { notifyApprovalDecided, notifyApprovalRequested } from './approval-notices';
import {
  canApproveCriticalAction,
  canRequestCriticalAction,
  MakerCheckerViolationError,
  PermissionDeniedError,
  type RbacContext,
} from '@cis/auth';
import { writeAudit } from '@cis/audit';
import type {
  NationalReport,
  NationalReportSection,
  NationalReportSectionId,
  SectionSufficiencyDisposition,
  ReviewDisposition,
  AdversaryHealth,
  CriticalAction,
} from '@cis/shared-types';
import {
  CriticalActionStateError,
  DomainError,
  InvalidReasonError,
  MIN_REASON_LENGTH,
} from './errors';
import type { ActorContext } from './edition-service';
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
  /**
   * Sections the report itself will withhold — no reportable figure (every
   * figure below the 10-response floor) or pending methodology approval — with
   * the reason. A section is never marked publishable when the report would
   * show nothing in it (`withheldSections` in report-content-service.ts).
   */
  withheld?: Partial<Record<string, string>>;
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
  const byRule = evaluateSectionRule(spec, ctx);
  const withheld = ctx.withheld?.[spec.id];
  return byRule.disposition !== 'suppressed' && withheld
    ? { disposition: 'suppressed', reason: withheld }
    : byRule;
}

function evaluateSectionRule(
  spec: SectionSpec,
  ctx: SufficiencyContext,
): { disposition: SectionSufficiencyDisposition; reason: string | null } {
  switch (spec.rule) {
    case 'caveat_when_thin': {
      const thin = Object.values(ctx.segments).some((s) => s.thin);
      return thin
        ? { disposition: 'caveated', reason: 'an investor segment is below its target sample' }
        : { disposition: 'publishable', reason: null };
    }
    case 'suppress_below_floor': {
      const local = ctx.segments['local_institution'];
      const foreign = ctx.segments['foreign_institution'];
      const bothClear = !!local?.meets && !!foreign?.meets;
      // Clear but thin is reported like §2: shown, with the caveat stated.
      if (bothClear && (local?.thin || foreign?.thin)) {
        return {
          disposition: 'caveated',
          reason: 'one or both institutional segments are thin',
        };
      }
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
  /** A written draft exists to review (the AI narrative, recorded for review). */
  draftReviewable: boolean;
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

  // The draft under review is the Industry report's AI narrative in force (the
  // one frozen at publication, else the latest drafted). Its review — every
  // sentence, the checker's findings and their dispositions, and the checker's
  // measured health — belongs to that narrative alone: a redraft starts afresh.
  const narrativeId = await narrativeUnderReview(pool, report.editionId);
  let draftReviewable: boolean;
  let allFindingsDisposed: boolean;
  let checkerHealthy: boolean;
  if (narrativeId) {
    const items = await listReviewItems(pool, reportId, narrativeId);
    draftReviewable = items.length > 0;
    allFindingsDisposed = items.every((i) => !i.finding || i.disposition !== null);
    checkerHealthy = !!(await getNarrativeCheckerHealth(pool, reportId, narrativeId))?.healthy;
  } else {
    // No narrative: only a draft saved directly (saveNationalDraft) can be reviewed.
    const findings = await listFindingsForReport(pool, reportId);
    const dispositions = await listDispositionsForReport(pool, reportId);
    const disposedIds = new Set(dispositions.map((d) => d.findingId));
    draftReviewable = (await listSentences(pool, reportId)).length > 0;
    allFindingsDisposed = findings.every((f) => disposedIds.has(f.id));
    checkerHealthy = !!(await getLatestAdversaryHealth(pool, reportId))?.healthy;
  }

  const reasons: string[] = [];
  if (!signedScoringRun) reasons.push('No signed-off scoring run.');
  if (!draftReviewable) reasons.push('There is no written draft to review yet.');
  if (!report.draftOpened) reasons.push('The draft has not been opened.');
  if (draftReviewable && !allFindingsDisposed) {
    reasons.push('Not every checker finding has a decision.');
  }
  if (draftReviewable && !checkerHealthy) {
    reasons.push('The checker has not yet proved it catches planted errors on this draft.');
  }

  return {
    signedScoringRun,
    draftOpened: report.draftOpened,
    draftReviewable,
    allFindingsDisposed: draftReviewable && allFindingsDisposed,
    checkerHealthy: draftReviewable && checkerHealthy,
    ok: reasons.length === 0,
    reasons,
  };
}

/** The Industry narrative in force for an edition: frozen at publication, else the latest. */
export async function narrativeUnderReview(pool: Pool, editionId: string): Promise<string | null> {
  const published = await getReportPublication(pool, editionId, 'industry', null);
  if (published) return published.narrativeId;
  return (await getLatestReportNarrative(pool, editionId, 'industry', null))?.id ?? null;
}

/**
 * Record that the draft was opened. With `userId`, also who opened it: the
 * approver of the national report must have opened the draft themselves.
 */
export async function openDraft(pool: Pool, reportId: string, userId?: string): Promise<void> {
  const report = await getNationalReport(pool, reportId);
  if (!report) throw new NationalReportError('Report not found', 'NOT_FOUND');
  await markDraftOpened(pool, reportId);
  if (userId) await recordNationalReportOpening(pool, reportId, userId);
}

/**
 * Approving the national report is a critical action on the shared
 * `critical_actions` maker-checker, like releasing the firm reports and
 * approving the methodology:
 *
 *   1. One person REQUESTS approval with a reason, once every precondition
 *      holds. The request names the report and the draft (narrative) it covers.
 *   2. A DIFFERENT person approves. There is no approval without a pending
 *      request for this report and this draft; the approver must have opened
 *      the draft themselves; the preconditions are checked again.
 *
 * Identities come from the session (the RBAC context), never a request body.
 */
export const NATIONAL_REPORT_APPROVAL_ACTION = 'national_report_approval';

/** The pending approval request for this report, if any. */
export async function getPendingNationalApproval(
  pool: Pool,
  reportId: string,
): Promise<CriticalAction | null> {
  const report = await getNationalReport(pool, reportId);
  if (!report) return null;
  const action = await getPendingCriticalActionForEdition(
    pool,
    report.editionId,
    NATIONAL_REPORT_APPROVAL_ACTION,
  );
  return action && action.payload['reportId'] === reportId ? action : null;
}

/** Maker step: request approval of the national report. */
export async function requestNationalApproval(
  pool: Pool,
  rbac: RbacContext,
  reportId: string,
  data: { reason: string; requestedByLabel?: string },
  ctx: ActorContext = {},
): Promise<CriticalAction> {
  const reason = data.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) throw new InvalidReasonError();
  if (!canRequestCriticalAction(rbac, NATIONAL_REPORT_APPROVAL_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `request:${NATIONAL_REPORT_APPROVAL_ACTION}`);
  }
  const report = await getNationalReport(pool, reportId);
  if (!report) throw new NationalReportError('Report not found', 'NOT_FOUND');
  if (report.status === 'approved') {
    throw new NationalReportError('This national report is already approved', 'ALREADY_APPROVED');
  }
  const pre = await nationalApprovalPreconditions(pool, reportId);
  if (!pre.ok) throw new NationalReportError(pre.reasons.join(' '), 'PRECONDITIONS_UNMET');

  const narrativeId = await narrativeUnderReview(pool, report.editionId);
  // One request at a time per edition. A request for this same draft is
  // already waiting; one for another report or an older draft is stale and is
  // withdrawn by the new request.
  const pending = await getPendingCriticalActionForEdition(
    pool,
    report.editionId,
    NATIONAL_REPORT_APPROVAL_ACTION,
  );
  if (
    pending &&
    pending.payload['reportId'] === reportId &&
    (pending.payload['narrativeId'] ?? null) === narrativeId
  ) {
    throw new CriticalActionStateError(
      'A request to approve this national report is already awaiting a decision',
    );
  }

  const action = await withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    await c.query(
      `UPDATE critical_actions SET status = 'cancelled'
        WHERE edition_id = $1 AND action_type = $2 AND status = 'pending'`,
      [report.editionId, NATIONAL_REPORT_APPROVAL_ACTION],
    );
    const created = await createCriticalAction(c, {
      actionType: NATIONAL_REPORT_APPROVAL_ACTION,
      requestedBy: rbac.userId,
      payload: { reportId, narrativeId, reason },
      editionId: report.editionId,
    });
    await setNationalRequest(c, reportId, {
      requestedBy: data.requestedByLabel ?? rbac.userId,
      requestedReason: reason,
    });
    await notifyApprovalRequested(c, {
      actionType: NATIONAL_REPORT_APPROVAL_ACTION,
      refId: created.id,
      requestedBy: rbac.userId,
      requestedAt: created.requestedAt,
    });
    return created;
  });

  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: 'critical_action.requested',
    entityType: 'critical_action',
    entityId: action.id,
    editionId: report.editionId,
    newValue: { actionType: NATIONAL_REPORT_APPROVAL_ACTION, reportId, narrativeId },
    reason,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });
  return action;
}

/**
 * Checker step: approve the national report. Refused unless a request for this
 * report and this draft is pending, the approver is a different person from
 * the requester, the approver has opened the draft, and every precondition
 * still holds.
 */
export async function approveNational(
  pool: Pool,
  rbac: RbacContext,
  reportId: string,
  data: { approvedByLabel?: string } = {},
  ctx: ActorContext = {},
): Promise<NationalReport> {
  const report = await getNationalReport(pool, reportId);
  if (!report) throw new NationalReportError('Report not found', 'NOT_FOUND');
  if (report.status === 'approved') {
    throw new NationalReportError('This national report is already approved', 'ALREADY_APPROVED');
  }

  const pending = await getPendingNationalApproval(pool, reportId);
  if (!pending) {
    throw new NationalReportError(
      'There is no pending request to approve this national report. One person requests approval, then a different person approves it.',
      'NO_PENDING_REQUEST',
    );
  }
  if (!canApproveCriticalAction(rbac, NATIONAL_REPORT_APPROVAL_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `approve:${NATIONAL_REPORT_APPROVAL_ACTION}`);
  }
  if (rbac.userId === pending.requestedBy) {
    throw new MakerCheckerViolationError(rbac.userId, pending.id);
  }
  const narrativeId = await narrativeUnderReview(pool, report.editionId);
  if ((pending.payload['narrativeId'] ?? null) !== narrativeId) {
    throw new NationalReportError(
      'The draft has changed since approval was requested. Ask for a fresh request.',
      'REQUEST_STALE',
    );
  }

  const pre = await nationalApprovalPreconditions(pool, reportId);
  if (!pre.ok) throw new NationalReportError(pre.reasons.join(' '), 'PRECONDITIONS_UNMET');
  if (!(await hasOpenedNationalReport(pool, reportId, rbac.userId))) {
    throw new NationalReportError(
      'Open the draft report yourself before approving it.',
      'NOT_OPENED',
    );
  }

  const approved = await withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const a = await c.query(
      `UPDATE critical_actions
          SET status = 'approved', approved_by = $1, approved_at = NOW()
        WHERE id = $2 AND status = 'pending' AND requested_by <> $1`,
      [rbac.userId, pending.id],
    );
    if (a.rowCount === 0) {
      throw new CriticalActionStateError('The approval request could not be approved');
    }
    await notifyApprovalDecided(c, {
      actionType: NATIONAL_REPORT_APPROVAL_ACTION,
      refId: pending.id,
      requestedBy: pending.requestedBy,
      decidedBy: rbac.userId,
      approved: true,
    });
    return dbApprove(c, reportId, data.approvedByLabel ?? rbac.userId);
  });

  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: 'critical_action.approved',
    entityType: 'critical_action',
    entityId: pending.id,
    editionId: report.editionId,
    oldValue: { status: 'pending' },
    newValue: { status: 'approved', actionType: NATIONAL_REPORT_APPROVAL_ACTION, reportId },
    reason: typeof pending.payload['reason'] === 'string' ? pending.payload['reason'] : null,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });
  return approved;
}

export async function getSections(pool: Pool, reportId: string): Promise<NationalReportSection[]> {
  return listSections(pool, reportId);
}
