import { Pool } from 'pg';
import {
  createCriticalAction,
  getCriticalActionById,
  getMethodologyMeta,
  listCriticalActionsByType,
} from '@cis/db';
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
 * Approving the scoring methodology (Runbook §5.2: the method must be
 * externally approved before official use). Until it is, every scoring run is
 * TEST_UNAPPROVED and no index score reaches a report.
 *
 * The approval is the usual two-person critical action: one person requests
 * it with a reason, a DIFFERENT person approves it. The record keeps who
 * requested and approved, when, and which methodology version — an approval
 * covers that version only; a new version of the method needs its own.
 * Identities come from the session, never a request body.
 */
export const METHODOLOGY_APPROVAL_ACTION = 'scoring_methodology_approval';

export interface MethodologyApprovalState {
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

const reasonOf = (a: CriticalAction) =>
  typeof a.payload['reason'] === 'string' ? (a.payload['reason'] as string) : '';

export async function getMethodologyApproval(pool: Pool): Promise<MethodologyApprovalState> {
  const methodology = currentMethodology();
  const actions = (await listCriticalActionsByType(pool, METHODOLOGY_APPROVAL_ACTION)).filter((a) =>
    isFor(a, methodology),
  );
  const approved = actions.find((a) => a.status === 'approved' && a.approvedBy && a.approvedAt);
  const pending = actions.find((a) => a.status === 'pending');
  return {
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

/** Whether the methodology version in force has been approved by two people. */
export async function isMethodologyApproved(pool: Pool): Promise<boolean> {
  return (await getMethodologyApproval(pool)).approved !== null;
}

/** Maker step: ask for the methodology version in force to be approved. */
export async function requestMethodologyApproval(
  pool: Pool,
  rbac: RbacContext,
  data: { reason: string },
  ctx: ActorContext = {},
): Promise<CriticalAction> {
  const reason = data.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) throw new InvalidReasonError();
  if (!canRequestCriticalAction(rbac, METHODOLOGY_APPROVAL_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `request:${METHODOLOGY_APPROVAL_ACTION}`);
  }
  const state = await getMethodologyApproval(pool);
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
    editionId: null,
  });
  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: 'critical_action.requested',
    entityType: 'critical_action',
    entityId: action.id,
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
  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: decision.approved ? 'critical_action.approved' : 'critical_action.rejected',
    entityType: 'critical_action',
    entityId: actionId,
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
