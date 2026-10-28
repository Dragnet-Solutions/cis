import { Pool } from 'pg';
import {
  createCriticalAction,
  getCriticalActionById,
  getEditionById,
  getMethodologyMeta,
  listCriticalActionsByType,
} from '@cis/db';
import { notifyApprovalDecided, notifyApprovalRequested } from './approval-notices';
import {
  canApproveCriticalAction,
  canRequestCriticalAction,
  MakerCheckerViolationError,
  PermissionDeniedError,
  type RbacContext,
} from '@cis/auth';
import type { CriticalAction } from '@cis/shared-types';
import { writeAudit } from '@cis/audit';
import { CriticalActionStateError, InvalidReasonError, MIN_REASON_LENGTH } from './errors';
import type { ActorContext } from './edition-service';

/**
 * The record of the scoring methodology's approval for an edition (Runbook
 * §5.2). Per Bobby's 25 Oct direction CIS approves the method offline, so
 * scoring does not wait on this record (BUG-02): it documents, per edition,
 * that the approval was given — who asked, who approved, why, and for which
 * methodology version.
 *
 * The record is the usual two-person critical action: one person requests it
 * with a reason, a DIFFERENT person approves it. It belongs to one edition and
 * one methodology version; a new edition, or a new version of the method,
 * starts with no record of its own. Identities come from the session, never a
 * request body.
 */
export const METHODOLOGY_APPROVAL_ACTION = 'scoring_methodology_approval';

export interface MethodologyApprovalState {
  /** The edition this record is for. */
  editionId: string;
  methodology: { id: string; version: string };
  /** The approval in force for this version, if any. */
  approved: {
    actionId: string;
    requestedBy: string;
    approvedBy: string;
    approvedAt: Date;
    reason: string;
  } | null;
  /** A request awaiting its second person, if any. */
  pending: { actionId: string; requestedBy: string; requestedAt: Date; reason: string } | null;
}

const currentMethodology = () => {
  const m = getMethodologyMeta();
  return { id: m.id, version: m.version };
};

const isFor = (a: CriticalAction, m: { id: string; version: string }) =>
  a.payload['methodologyId'] === m.id && a.payload['version'] === m.version;

const isForEdition = (a: CriticalAction, editionId: string) => a.editionId === editionId;

const reasonOf = (a: CriticalAction) =>
  typeof a.payload['reason'] === 'string' ? (a.payload['reason'] as string) : '';

export async function getMethodologyApproval(
  pool: Pool,
  editionId: string,
): Promise<MethodologyApprovalState> {
  const methodology = currentMethodology();
  const actions = (await listCriticalActionsByType(pool, METHODOLOGY_APPROVAL_ACTION)).filter(
    (a) => isFor(a, methodology) && isForEdition(a, editionId),
  );
  const approved = actions.find((a) => a.status === 'approved' && a.approvedBy && a.approvedAt);
  const pending = actions.find((a) => a.status === 'pending');
  return {
    editionId,
    methodology,
    approved: approved
      ? {
          actionId: approved.id,
          requestedBy: approved.requestedBy,
          approvedBy: approved.approvedBy!,
          approvedAt: approved.approvedAt!,
          reason: reasonOf(approved),
        }
      : null,
    pending: pending
      ? {
          actionId: pending.id,
          requestedBy: pending.requestedBy,
          requestedAt: pending.requestedAt,
          reason: reasonOf(pending),
        }
      : null,
  };
}

/** Whether this edition has a two-person approval record for the version in force. */
export async function isMethodologyApproved(pool: Pool, editionId: string): Promise<boolean> {
  return (await getMethodologyApproval(pool, editionId)).approved !== null;
}

/** Maker step: record that the methodology version in force is approved for this edition. */
export async function requestMethodologyApproval(
  pool: Pool,
  rbac: RbacContext,
  data: { editionId: string; reason: string },
  ctx: ActorContext = {},
): Promise<CriticalAction> {
  const reason = data.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) throw new InvalidReasonError();
  if (!canRequestCriticalAction(rbac, METHODOLOGY_APPROVAL_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `request:${METHODOLOGY_APPROVAL_ACTION}`);
  }
  if (!(await getEditionById(pool, data.editionId))) {
    throw new CriticalActionStateError('That edition was not found');
  }
  const state = await getMethodologyApproval(pool, data.editionId);
  if (state.approved) {
    throw new CriticalActionStateError(
      `${state.methodology.id} v${state.methodology.version} is already approved`,
    );
  }
  if (state.pending) {
    throw new CriticalActionStateError('A request to approve the methodology is already waiting');
  }
  const action = await createCriticalAction(pool, {
    actionType: METHODOLOGY_APPROVAL_ACTION,
    requestedBy: rbac.userId,
    payload: {
      methodologyId: state.methodology.id,
      version: state.methodology.version,
      reason,
    },
    editionId: data.editionId,
  });
  await notifyApprovalRequested(pool, {
    actionType: METHODOLOGY_APPROVAL_ACTION,
    refId: action.id,
    requestedBy: rbac.userId,
    requestedAt: action.requestedAt,
  });
  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: 'critical_action.requested',
    entityType: 'critical_action',
    entityId: action.id,
    editionId: data.editionId,
    newValue: { actionType: METHODOLOGY_APPROVAL_ACTION, ...state.methodology },
    reason,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });
  return action;
}

/** Checker step: a different person approves or rejects the request. */
export async function decideMethodologyApproval(
  pool: Pool,
  rbac: RbacContext,
  actionId: string,
  decision: { approved: boolean; rejectionReason?: string },
  ctx: ActorContext = {},
): Promise<CriticalAction> {
  const action = await getCriticalActionById(pool, actionId);
  if (!action || action.actionType !== METHODOLOGY_APPROVAL_ACTION) {
    throw new CriticalActionStateError('That methodology approval request was not found');
  }
  if (action.status !== 'pending') {
    throw new CriticalActionStateError(`That request has already been decided (${action.status})`);
  }
  if (!canApproveCriticalAction(rbac, METHODOLOGY_APPROVAL_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `approve:${METHODOLOGY_APPROVAL_ACTION}`);
  }
  if (rbac.userId === action.requestedBy) {
    throw new MakerCheckerViolationError(rbac.userId, actionId);
  }
  if (!isFor(action, currentMethodology())) {
    throw new CriticalActionStateError(
      'This request is for a different version of the methodology; ask for a fresh request.',
    );
  }
  const rejectionReason = decision.rejectionReason?.trim() || 'Rejected by checker';
  const res = decision.approved
    ? await pool.query(
        `UPDATE critical_actions SET status='approved', approved_by=$1, approved_at=NOW()
          WHERE id=$2 AND status='pending' AND requested_by <> $1`,
        [rbac.userId, actionId],
      )
    : await pool.query(
        `UPDATE critical_actions
            SET status='rejected', rejected_by=$1, rejected_at=NOW(), rejection_reason=$2
          WHERE id=$3 AND status='pending' AND requested_by <> $1`,
        [rbac.userId, rejectionReason, actionId],
      );
  if (res.rowCount === 0) throw new CriticalActionStateError('The request could not be decided');
  await notifyApprovalDecided(pool, {
    actionType: METHODOLOGY_APPROVAL_ACTION,
    refId: actionId,
    requestedBy: action.requestedBy,
    decidedBy: rbac.userId,
    approved: decision.approved,
    reason: decision.approved ? null : rejectionReason,
  });
  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: decision.approved ? 'critical_action.approved' : 'critical_action.rejected',
    entityType: 'critical_action',
    entityId: actionId,
    editionId: action.editionId,
    oldValue: { status: 'pending' },
    newValue: {
      status: decision.approved ? 'approved' : 'rejected',
      actionType: METHODOLOGY_APPROVAL_ACTION,
      methodologyId: action.payload['methodologyId'],
      version: action.payload['version'],
    },
    reason: decision.approved ? reasonOf(action) : rejectionReason,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });
  return (await getCriticalActionById(pool, actionId)) ?? action;
}
