import { Pool } from 'pg';
import {
  getConfig,
  createFirmReport,
  getFirmReport,
  listFirmReports,
  latestVersionFor,
  setGenerationState,
  setApprovalState,
  setReleaseState,
  insertReleaseHistory,
  hasApprovedNationalReport,
  hasSignedOffRun,
  countRetailRespondentsRatingFirm,
  insertReportPublication,
  recordFirmReportOpening,
  listFirmReportOpenings,
  createCriticalAction,
  getCriticalActionById,
  getPendingCriticalActionForEdition,
  getOrganizationById,
  withTransaction,
} from '@cis/db';
import {
  canRequestCriticalAction,
  canApproveCriticalAction,
  PermissionDeniedError,
  MakerCheckerViolationError,
  type RbacContext,
} from '@cis/auth';
import { writeAudit } from '@cis/audit';
import type { CriticalAction, FirmReport, FirmReportCutState } from '@cis/shared-types';
import {
  DomainError,
  InvalidReasonError,
  CriticalActionStateError,
  MIN_REASON_LENGTH,
} from './errors';
import type { ActorContext } from './edition-service';
import { eligibleFirmIds } from './eligibility-service';
import { assertRunOfficialUsable } from './candidate-scoring-service';

/**
 * Firm reports — generation, reconciliation, and ATOMIC-PER-REPORT release of
 * 80+ individual reports. The guarantee: FRM_01/02/03 are produced for every
 * participating firm regardless of volume; only the retail cut (FRM_04) is
 * gated. A firm never receives an institutional cut of itself — this module has
 * no code path that could produce one. Nothing released is ever recalled.
 */

export class FirmReportError extends DomainError {
  constructor(message: string, code = 'FIRM_REPORT') {
    super(message, code);
  }
}

/** The FRM_04 retail-cut thresholds are governed configuration, explicitly
 *  provisional — never hardcoded constants. */
export interface RetailCutThresholds {
  directional: number;
  reportable: number;
  provisional?: boolean;
}

const DEFAULT_THRESHOLDS: RetailCutThresholds = {
  directional: 10,
  reportable: 30,
  provisional: true,
};

export async function getRetailCutThresholds(pool: Pool): Promise<RetailCutThresholds> {
  const cfg = await getConfig<RetailCutThresholds>(pool, 'reporting.retail_cut_thresholds');
  return cfg ?? DEFAULT_THRESHOLDS;
}

/** Three states, not two: below `directional` nothing; `directional`..`reportable`-1
 *  DIRECTIONAL only; `reportable`+ unlocked. */
export function cutStateFor(n: number, t: RetailCutThresholds): FirmReportCutState {
  if (n >= t.reportable) return 'unlocked';
  if (n >= t.directional) return 'directional';
  return 'none';
}

export interface GenerationResult {
  zeroFirms: boolean;
  reports: FirmReport[];
  reconciled: boolean;
  expectedCount: number;
  generatedCount: number;
}

/**
 * Generate one report per participating firm (≥1 of S1/S2/S3 complete), as its
 * own tracked phase before any release. Reconciles the produced set against the
 * participating-firm count. Zero participating firms is a real, valid outcome —
 * "nothing to produce" — reported distinctly, never as a suppression.
 *
 * `failFor` lets a caller inject a generation failure for a firm (a recoverable
 * fault) — that report is marked `failed`, held later, never silently excluded.
 */
export async function generateFirmReports(
  pool: Pool,
  data: { editionId: string; scoringRunId: string; failFor?: string[] },
): Promise<GenerationResult> {
  // Hard methodology gate (Phase 11, build note §2): a TEST_UNAPPROVED run can
  // never produce firm reports. Checked before the sign-off gate so an unapproved
  // methodology is refused even in the (impossible) event such a run signed off.
  await assertRunOfficialUsable(pool, data.scoringRunId, 'firm report generation');
  // A run may back a firm report only if it has a genuine signed-off record
  // (UX-ADM-004) — the same rule that gates the national report. A merely
  // completed run is not eligible.
  if (!(await hasSignedOffRun(pool, data.scoringRunId))) {
    throw new FirmReportError(
      'Firm reports can only be generated from a signed-off scoring run',
      'SCORING_RUN_NOT_SIGNED_OFF',
    );
  }
  const firms = await eligibleFirmIds(pool, data.editionId);
  if (firms.length === 0) {
    return { zeroFirms: true, reports: [], reconciled: true, expectedCount: 0, generatedCount: 0 };
  }
  const thresholds = await getRetailCutThresholds(pool);
  const failSet = new Set(data.failFor ?? []);
  const reports: FirmReport[] = [];

  for (const firmId of firms) {
    const retailN = await countRetailRespondentsRatingFirm(pool, data.editionId, firmId);
    const version = (await latestVersionFor(pool, data.editionId, firmId)) + 1;
    const report = await createFirmReport(pool, {
      editionId: data.editionId,
      organizationId: firmId,
      scoringRunId: data.scoringRunId,
      version,
      retailN,
      cutState: cutStateFor(retailN, thresholds),
      generationState: failSet.has(firmId) ? 'failed' : 'generated',
    });
    reports.push(report);
  }

  const generatedCount = reports.filter((r) => r.generationState === 'generated').length;
  return {
    zeroFirms: false,
    reports,
    // The full set was produced (one row per participating firm) even if some
    // rows are in a `failed` state — reconciliation is about coverage, and a
    // failure is named and retriable, never a silent gap.
    reconciled: reports.length === firms.length,
    expectedCount: firms.length,
    generatedCount,
  };
}

// ─── Approval for release: maker-checker ─────────────────────────────────────

/**
 * Releasing the firm reports is one of the critical actions (People and
 * access): every firm sees its report at once, and nothing released is ever
 * recalled. So no one approves a firm report alone. It runs on the same
 * `critical_actions` maker-checker as freezing the instruments and locking the
 * results:
 *
 *   1. One person REQUESTS release of a set of generated reports — usually all
 *      of them, so 80 firms are one request, not 80 clicks — with a reason.
 *   2. A DIFFERENT person approves (or rejects). The maker can never approve
 *      their own request; identities come from the session, never a request
 *      body. Approving marks every covered report approved and releases them.
 *   3. Every covered report must have been OPENED by the requester or the
 *      approver before the approval is accepted — the national report's "open
 *      the draft before approving it" rule, per report. The two people sharing
 *      the decision may split the reading between them, but no report goes out
 *      that neither of them has read.
 *
 * `releaseFirmReports` is unchanged: it releases only reports whose approval
 * state is 'approved', and the only way to reach that state is step 2.
 */
export const FIRM_REPORT_RELEASE_ACTION = 'firm_report_release';

/** Record that an operator opened a report — the "read it before approving it"
 *  record the approval checks. Opening a released report is harmless. */
export async function openFirmReport(pool: Pool, id: string, userId: string): Promise<void> {
  const report = await getFirmReport(pool, id);
  if (!report) throw new FirmReportError('Firm report not found', 'NOT_FOUND');
  await recordFirmReportOpening(pool, id, userId);
}

/** The reports a release request can cover: the latest version of each firm's
 *  report that has generated, is not yet approved, and is not released. */
async function requestableReports(pool: Pool, editionId: string): Promise<FirmReport[]> {
  const reports = await listFirmReports(pool, editionId);
  return reports.filter(
    (r) =>
      r.generationState === 'generated' &&
      r.approvalState !== 'approved' &&
      r.releaseState !== 'released',
  );
}

function reportIdsOf(action: CriticalAction): string[] {
  const ids = action.payload['reportIds'];
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/** The pending release request for an edition, if any. */
export async function getPendingFirmReportRelease(
  pool: Pool,
  editionId: string,
): Promise<CriticalAction | null> {
  return getPendingCriticalActionForEdition(pool, editionId, FIRM_REPORT_RELEASE_ACTION);
}

/**
 * Maker step: request release of a set of generated reports. `reportIds`
 * narrows the request; left out, it covers every report that can be requested.
 */
export async function requestFirmReportRelease(
  pool: Pool,
  rbac: RbacContext,
  editionId: string,
  data: { reason: string; reportIds?: string[] },
  ctx: ActorContext = {},
): Promise<CriticalAction> {
  const reason = data.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) throw new InvalidReasonError();

  if (!canRequestCriticalAction(rbac, FIRM_REPORT_RELEASE_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `request:${FIRM_REPORT_RELEASE_ACTION}`);
  }

  if (await getPendingFirmReportRelease(pool, editionId)) {
    throw new CriticalActionStateError(
      'A request to release firm reports is already awaiting a decision',
    );
  }

  const requestable = await requestableReports(pool, editionId);
  let covered = requestable;
  if (data.reportIds) {
    const byId = new Map(requestable.map((r) => [r.id, r]));
    const unknown = data.reportIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new FirmReportError(
        'Only generated reports that are not yet approved or released can be requested',
        'NOT_REQUESTABLE',
      );
    }
    covered = [...new Set(data.reportIds)].map((id) => byId.get(id)!);
  }
  if (covered.length === 0) {
    throw new FirmReportError('There are no generated reports waiting for approval', 'NOTHING');
  }

  const action = await createCriticalAction(pool, {
    actionType: FIRM_REPORT_RELEASE_ACTION,
    requestedBy: rbac.userId,
    payload: { reason, reportIds: covered.map((r) => r.id) },
    editionId,
  });

  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: 'critical_action.requested',
    entityType: 'critical_action',
    entityId: action.id,
    editionId,
    newValue: { actionType: FIRM_REPORT_RELEASE_ACTION, reportCount: covered.length },
    reason,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });
  return action;
}

export interface FirmReportReleaseDecision {
  approved: boolean;
  rejectionReason?: string;
}

export interface FirmReportReleaseDecisionResult {
  action: CriticalAction;
  /** The release that followed an approval; null after a rejection. */
  release: ReleaseResult | null;
  /** Set when the reports were approved but the release itself then failed —
   *  the approval stands and "Release again" retries. */
  releaseError: string | null;
}

/**
 * Checker step: approve or reject a release request. Approval needs a
 * different person from the requester, the national report approved, and every
 * covered report still waiting and opened by the requester or the approver.
 * Approving marks the covered reports approved and then releases them through
 * `releaseFirmReports` (with `releaseOptions`, if given).
 */
export async function decideFirmReportRelease(
  pool: Pool,
  rbac: RbacContext,
  editionId: string,
  actionId: string,
  decision: FirmReportReleaseDecision,
  ctx: ActorContext = {},
  releaseOptions?: ReleaseOptions,
): Promise<FirmReportReleaseDecisionResult> {
  const action = await getCriticalActionById(pool, actionId);
  if (
    !action ||
    action.actionType !== FIRM_REPORT_RELEASE_ACTION ||
    action.editionId !== editionId
  ) {
    throw new CriticalActionStateError('That release request was not found for this edition');
  }
  if (action.status !== 'pending') {
    throw new CriticalActionStateError(
      `That release request has already been decided (${action.status})`,
    );
  }
  if (!canApproveCriticalAction(rbac, FIRM_REPORT_RELEASE_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `approve:${FIRM_REPORT_RELEASE_ACTION}`);
  }
  if (rbac.userId === action.requestedBy) {
    throw new MakerCheckerViolationError(rbac.userId, actionId);
  }

  if (!decision.approved) {
    const rejectionReason = decision.rejectionReason?.trim() || 'Rejected by checker';
    const a = await pool.query(
      `UPDATE critical_actions
          SET status='rejected', rejected_by=$1, rejected_at=NOW(), rejection_reason=$2
        WHERE id=$3 AND status='pending' AND requested_by <> $1`,
      [rbac.userId, rejectionReason, actionId],
    );
    if (a.rowCount === 0) {
      throw new CriticalActionStateError('The release request could not be rejected');
    }
    await writeAudit(pool, {
      actorId: rbac.userId,
      actionType: 'critical_action.rejected',
      entityType: 'critical_action',
      entityId: actionId,
      editionId,
      oldValue: { status: 'pending' },
      newValue: { status: 'rejected' },
      reason: rejectionReason,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    const rejected = await getCriticalActionById(pool, actionId);
    return { action: rejected ?? action, release: null, releaseError: null };
  }

  // Approving releases, and release waits for the national report.
  if (!(await hasApprovedNationalReport(pool, editionId))) {
    throw new FirmReportError(
      'Firm reports cannot be released until the national report is approved',
      'NATIONAL_NOT_APPROVED',
    );
  }

  const ids = reportIdsOf(action);
  const reports: FirmReport[] = [];
  for (const id of ids) {
    const r = await getFirmReport(pool, id);
    if (!r || r.generationState !== 'generated' || r.releaseState === 'released') {
      throw new FirmReportError(
        'A report in this request has changed since it was requested. Reject it and ask for a fresh request.',
        'REQUEST_STALE',
      );
    }
    reports.push(r);
  }

  // Open before approve: each report read by one of the two people deciding.
  const deciders = new Set([action.requestedBy, rbac.userId]);
  const openedIds = new Set(
    (await listFirmReportOpenings(pool, ids))
      .filter((o) => deciders.has(o.userId))
      .map((o) => o.firmReportId),
  );
  const unopened = reports.filter((r) => !openedIds.has(r.id));
  if (unopened.length > 0) {
    const names: string[] = [];
    for (const r of unopened.slice(0, 5)) {
      names.push((await getOrganizationById(pool, r.organizationId))?.displayName ?? 'a firm');
    }
    const more = unopened.length > 5 ? ` and ${unopened.length - 5} more` : '';
    throw new FirmReportError(
      `${unopened.length} of ${reports.length} ${reports.length === 1 ? 'report has' : 'reports have'} not been opened by you or the person who asked: ${names.join(', ')}${more}. Open each one before approving.`,
      'NOT_OPENED',
    );
  }

  await withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const a = await c.query(
      `UPDATE critical_actions
          SET status='approved', approved_by=$1, approved_at=NOW()
        WHERE id=$2 AND status='pending' AND requested_by <> $1`,
      [rbac.userId, actionId],
    );
    if (a.rowCount === 0) {
      throw new CriticalActionStateError('The release request could not be approved');
    }
    for (const r of reports) await setApprovalState(c, r.id, 'approved');
  });

  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: 'critical_action.approved',
    entityType: 'critical_action',
    entityId: actionId,
    editionId,
    oldValue: { status: 'pending' },
    newValue: { status: 'approved', reportCount: reports.length },
    reason: typeof action.payload['reason'] === 'string' ? action.payload['reason'] : null,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  let release: ReleaseResult | null = null;
  let releaseError: string | null = null;
  try {
    release = await releaseFirmReports(pool, editionId, releaseOptions);
  } catch (err) {
    releaseError = err instanceof Error ? err.message : String(err);
  }
  const approved = await getCriticalActionById(pool, actionId);
  return { action: approved ?? action, release, releaseError };
}

/**
 * Retry a failed (or held) report's generation (a recoverable fault) — never a
 * released one. A released report is immutable structurally (the DB itself
 * refuses any UPDATE to a released row); this checks it first so the refusal
 * is a clean domain error, not a raw trigger exception. A correction to a
 * released report is a new version, never an edit to the released one.
 */
export async function regenerateFirmReport(pool: Pool, id: string): Promise<FirmReport> {
  const report = await getFirmReport(pool, id);
  if (!report) throw new FirmReportError('Firm report not found', 'NOT_FOUND');
  if (report.releaseState === 'released') {
    throw new FirmReportError(
      'A released firm report is immutable and cannot be regenerated',
      'ALREADY_RELEASED',
    );
  }
  const updated = await setGenerationState(pool, id, 'generated');
  await insertReleaseHistory(pool, {
    firmReportId: id,
    editionId: report.editionId,
    organizationId: report.organizationId,
    action: 'regenerated',
  });
  return updated;
}

export interface ReleaseResult {
  released: FirmReport[];
  held: Array<{ report: FirmReport; reason: string }>;
}

/**
 * Release, ATOMIC PER REPORT. Blocked entirely until the national report is
 * approved (firm reports carry the industry aggregate a firm is measured
 * against). Each report that has individually generated AND been approved
 * releases; every other is HELD — not excluded — with a reason, and the release
 * history records which released, which were held, and why. A held report does
 * not block any other firm. An already-released report is left untouched
 * (releasing is not repeated — the DB also forbids editing a released row).
 *
 * With `prepare`, a report goes out only with its written analysis: `prepare`
 * returns the narrative to freeze into it (drafting it if due), and a report
 * whose analysis cannot be prepared is HELD with the reason, like any other
 * report that is not ready. Preparation runs a few reports at a time.
 */
export interface ReleaseOptions {
  prepare: (report: FirmReport) => Promise<{ narrativeId: string }>;
  releasedBy: string;
  concurrency?: number;
}

export async function releaseFirmReports(
  pool: Pool,
  editionId: string,
  options?: ReleaseOptions,
): Promise<ReleaseResult> {
  if (!(await hasApprovedNationalReport(pool, editionId))) {
    throw new FirmReportError(
      'Firm reports cannot be released until the national report is approved',
      'NATIONAL_NOT_APPROVED',
    );
  }

  const reports = await listFirmReports(pool, editionId);
  const released: FirmReport[] = [];
  const held: Array<{ report: FirmReport; reason: string }> = [];

  // Hard methodology gate (Phase 11, build note §2): the release path is the
  // final official-output boundary. No report backed by a TEST_UNAPPROVED run may
  // pass it — a structural failure, checked once per distinct scoring run.
  const gatedRuns = new Set<string>();
  for (const r of reports) {
    if (r.releaseState === 'released' || gatedRuns.has(r.scoringRunId)) continue;
    await assertRunOfficialUsable(pool, r.scoringRunId, 'firm report release');
    gatedRuns.add(r.scoringRunId);
  }

  const isReady = (r: FirmReport) =>
    r.releaseState !== 'released' &&
    r.generationState === 'generated' &&
    r.approvalState === 'approved';
  const prepared = new Map<string, { narrativeId: string } | { failed: string }>();
  if (options) {
    const queue = reports.filter(isReady);
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          prepared.set(r.id, await options.prepare(r));
        } catch (err) {
          prepared.set(r.id, { failed: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: options.concurrency ?? 4 }, worker));
  }

  for (const r of reports) {
    if (r.releaseState === 'released') continue; // never recalled, never re-released
    const prep = prepared.get(r.id);
    const unprepared = prep && 'failed' in prep ? prep.failed : null;
    const ready = isReady(r) && unprepared === null;
    if (ready) {
      const updated = await setReleaseState(pool, r.id, 'released');
      if (prep && 'narrativeId' in prep && options) {
        await insertReportPublication(pool, {
          editionId,
          kind: 'firm',
          subjectId: r.organizationId,
          firmReportId: r.id,
          narrativeId: prep.narrativeId,
          publishedBy: options.releasedBy,
        });
      }
      await insertReleaseHistory(pool, {
        firmReportId: r.id,
        editionId,
        organizationId: r.organizationId,
        action: 'released',
      });
      released.push(updated);
    } else {
      const reason =
        unprepared !== null
          ? `The written analysis could not be prepared — held until it can: ${unprepared}`
          : r.generationState === 'failed'
            ? 'Report failed to generate — held for regeneration, not excluded.'
            : r.generationState !== 'generated'
              ? 'Report has not finished generating.'
              : 'Report has not been approved.';
      const updated = await setReleaseState(pool, r.id, 'held', reason);
      await insertReleaseHistory(pool, {
        firmReportId: r.id,
        editionId,
        organizationId: r.organizationId,
        action: 'held',
        reason,
      });
      held.push({ report: updated, reason });
    }
  }
  return { released, held };
}

/**
 * A correction after release is a NEW, separately-versioned report — never an
 * edit to the released one (the DB blocks that too). The released report stands.
 */
export async function correctFirmReport(
  pool: Pool,
  data: { editionId: string; organizationId: string; scoringRunId: string },
): Promise<FirmReport> {
  // Hard methodology gate (Phase 11): a correction is an official firm report too.
  await assertRunOfficialUsable(pool, data.scoringRunId, 'a firm report correction');
  // A correction is generated from a NEW signed-off run (§ "nothing already
  // released is recalled; a correction is a new, separately-versioned report").
  if (!(await hasSignedOffRun(pool, data.scoringRunId))) {
    throw new FirmReportError(
      'A firm report correction can only be generated from a signed-off scoring run',
      'SCORING_RUN_NOT_SIGNED_OFF',
    );
  }
  const thresholds = await getRetailCutThresholds(pool);
  const retailN = await countRetailRespondentsRatingFirm(pool, data.editionId, data.organizationId);
  const version = (await latestVersionFor(pool, data.editionId, data.organizationId)) + 1;
  return createFirmReport(pool, {
    editionId: data.editionId,
    organizationId: data.organizationId,
    scoringRunId: data.scoringRunId,
    version,
    retailN,
    cutState: cutStateFor(retailN, thresholds),
    generationState: 'generated',
  });
}

export async function getFirmReports(pool: Pool, editionId: string): Promise<FirmReport[]> {
  return listFirmReports(pool, editionId);
}
