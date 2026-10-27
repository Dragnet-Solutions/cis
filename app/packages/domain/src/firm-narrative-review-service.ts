import { Pool } from 'pg';
import {
  getLatestReportNarrative,
  getReportNarrativeById,
  getReportPublication,
  insertFirmNarrativeDecision,
  listFirmNarrativeDecisions,
  type FirmNarrativeDecision,
  type ReportNarrative,
} from '@cis/db';
import { writeAudit } from '@cis/audit';
import { DomainError } from './errors';

/**
 * The firm report's fact-check decision step (BUG-20 / BUG-03), the same step
 * the national report has. The narrative checker (report-narrative-service.ts)
 * holds back any sentence it cannot verify and records why — a FINDING. Before
 * a firm report can be released, a person decides on every finding in its
 * narrative: agree it stays out (SUPPRESS_CLAIM), or overturn it with a reason
 * (REJECT_WITH_REASON), which puts the sentence back. A redraft is a new
 * narrative with a fresh review: a decision never carries over to new words.
 */

export class FirmNarrativeReviewError extends DomainError {
  constructor(message: string, code = 'FIRM_NARRATIVE_REVIEW') {
    super(message, code);
  }
}

export type FirmFindingDisposition = 'SUPPRESS_CLAIM' | 'REJECT_WITH_REASON';

export interface FirmNarrativeFinding {
  narrativeIndex: number;
  section: string;
  text: string;
  finding: { kind: string; why: string };
  decision: Omit<FirmNarrativeDecision, 'narrativeId' | 'narrativeIndex'> | null;
}

export interface FirmNarrativeReview {
  /** The narrative under review; null while nothing has been drafted. */
  narrativeId: string | null;
  model: string | null;
  draftedAt: Date | null;
  findings: FirmNarrativeFinding[];
  undecided: number;
  /** Released: the review is final. */
  released: boolean;
}

function findingsOf(
  narrative: ReportNarrative,
  decisions: FirmNarrativeDecision[],
): FirmNarrativeFinding[] {
  const byIndex = new Map(decisions.map((d) => [d.narrativeIndex, d]));
  const out: FirmNarrativeFinding[] = [];
  narrative.sentences.forEach((s, i) => {
    if (!s.finding) return;
    const d = byIndex.get(i);
    out.push({
      narrativeIndex: i,
      section: s.section,
      text: s.text,
      finding: s.finding,
      decision: d
        ? {
            disposition: d.disposition,
            reason: d.reason,
            decidedBy: d.decidedBy,
            decidedAt: d.decidedAt,
          }
        : null,
    });
  });
  return out;
}

/** The narrative a firm report's review is of: the one frozen at release, else the latest. */
async function narrativeUnderReview(
  pool: Pool,
  editionId: string,
  firmId: string,
): Promise<{ narrative: ReportNarrative | null; released: boolean }> {
  const published = await getReportPublication(pool, editionId, 'firm', firmId);
  if (published) {
    return {
      narrative: await getReportNarrativeById(pool, published.narrativeId),
      released: true,
    };
  }
  return {
    narrative: await getLatestReportNarrative(pool, editionId, 'firm', firmId),
    released: false,
  };
}

export async function getFirmNarrativeReview(
  pool: Pool,
  editionId: string,
  firmId: string,
): Promise<FirmNarrativeReview> {
  const { narrative, released } = await narrativeUnderReview(pool, editionId, firmId);
  if (!narrative) {
    return {
      narrativeId: null,
      model: null,
      draftedAt: null,
      findings: [],
      undecided: 0,
      released,
    };
  }
  const findings = findingsOf(narrative, await listFirmNarrativeDecisions(pool, narrative.id));
  return {
    narrativeId: narrative.id,
    model: narrative.model,
    draftedAt: narrative.createdAt,
    findings,
    undecided: findings.filter((f) => f.decision === null).length,
    released,
  };
}

/** How many findings in this narrative still wait for a person's decision. */
export async function undecidedFirmFindings(
  pool: Pool,
  narrative: ReportNarrative,
): Promise<number> {
  return findingsOf(narrative, await listFirmNarrativeDecisions(pool, narrative.id)).filter(
    (f) => f.decision === null,
  ).length;
}

/** The sentence indices whose finding was overturned: they are shown after all. */
export async function overturnedFirmSentences(
  pool: Pool,
  narrativeId: string,
): Promise<Set<number>> {
  return new Set(
    (await listFirmNarrativeDecisions(pool, narrativeId))
      .filter((d) => d.disposition === 'REJECT_WITH_REASON')
      .map((d) => d.narrativeIndex),
  );
}

/**
 * A person's decision on one finding. The decider comes from the session.
 * Refused once the report is released (its review is final), for a narrative
 * that is no longer the one under review, for a sentence with no finding, and
 * for a second decision on the same finding. Overturning needs a reason.
 */
export async function decideFirmNarrativeFinding(
  pool: Pool,
  data: {
    editionId: string;
    firmId: string;
    narrativeId: string;
    narrativeIndex: number;
    disposition: FirmFindingDisposition;
    reason: string | null;
    /** Who decided, as recorded on the decision (the session's email). */
    decidedBy: string;
    /** The decider's user id, for the audit trail. */
    decidedById?: string | null;
  },
  ctx: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<FirmNarrativeReview> {
  const { narrative, released } = await narrativeUnderReview(pool, data.editionId, data.firmId);
  if (released) {
    throw new FirmNarrativeReviewError(
      'This report has been released, so its review is final.',
      'RELEASED',
    );
  }
  if (!narrative || narrative.id !== data.narrativeId) {
    throw new FirmNarrativeReviewError(
      'The analysis has been redrafted since this was shown. Reload to review the current draft.',
      'STALE',
    );
  }
  const sentence = narrative.sentences[data.narrativeIndex];
  if (!sentence?.finding) {
    throw new FirmNarrativeReviewError('That sentence has no finding to decide.', 'NOT_FOUND');
  }
  const reason = data.reason?.trim() || null;
  if (data.disposition === 'REJECT_WITH_REASON' && (!reason || reason.length < 4)) {
    throw new FirmNarrativeReviewError(
      'Say why the checker was wrong before putting the sentence back.',
      'REASON_REQUIRED',
    );
  }
  const decided = await insertFirmNarrativeDecision(pool, {
    narrativeId: narrative.id,
    narrativeIndex: data.narrativeIndex,
    disposition: data.disposition,
    reason,
    decidedBy: data.decidedBy,
  });
  if (!decided) {
    throw new FirmNarrativeReviewError(
      'A decision has already been recorded on this finding.',
      'DECIDED',
    );
  }
  await writeAudit(pool, {
    actorId: data.decidedById ?? null,
    actionType: 'firm_narrative.finding_decided',
    entityType: 'report_narrative',
    entityId: narrative.id,
    editionId: data.editionId,
    newValue: {
      firmId: data.firmId,
      narrativeIndex: data.narrativeIndex,
      kind: sentence.finding.kind,
      disposition: data.disposition,
      decidedBy: data.decidedBy,
    },
    reason,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });
  return getFirmNarrativeReview(pool, data.editionId, data.firmId);
}
