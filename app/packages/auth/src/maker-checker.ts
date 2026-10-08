import { Pool } from 'pg';
import {
  createCriticalAction,
  approveCriticalAction,
  rejectCriticalAction,
  getCriticalActionById,
} from '@cis/db';
import { canRequestCriticalAction, canApproveCriticalAction, RbacContext } from './rbac';
import type { CriticalAction } from '@cis/shared-types';

export { getCriticalActionById };

/**
 * Request a critical action (maker step).
 * The caller must hold can_request_critical_action for the given actionType.
 */
export async function requestCriticalAction(
  pool: Pool,
  rbac: RbacContext,
  data: {
    actionType: string;
    payload: Record<string, unknown>;
    editionId?: string | null;
  },
): Promise<CriticalAction> {
  if (!canRequestCriticalAction(rbac, data.actionType)) {
    throw new Error(
      'You do not have permission to request this — it needs the “Request a critical action” right.',
    );
  }
  return createCriticalAction(pool, {
    actionType: data.actionType,
    requestedBy: rbac.userId,
    payload: data.payload,
    editionId: data.editionId ?? null,
  });
}

/**
 * Approve a critical action (checker step).
 * Enforces maker-checker: the approver must differ from the requester.
 * The caller must hold can_approve_critical_action for the action's type.
 */
export async function approveCriticalActionWithRbac(
  pool: Pool,
  rbac: RbacContext,
  criticalActionId: string,
): Promise<CriticalAction> {
  const action = await getCriticalActionById(pool, criticalActionId);
  if (!action) throw new Error(`Critical action ${criticalActionId} not found`);

  if (!canApproveCriticalAction(rbac, action.actionType)) {
    throw new Error(
      'You do not have permission to approve this — it needs the “Approve a critical action” right.',
    );
  }

  // Maker-checker: same person cannot be both requester and approver.
  // This is also enforced at the DB level (CHECK constraint), but the service
  // layer provides a meaningful error message before hitting the DB.
  if (rbac.userId === action.requestedBy) {
    throw new MakerCheckerViolationError(rbac.userId, criticalActionId);
  }

  return approveCriticalAction(pool, criticalActionId, rbac.userId);
}

/**
 * Reject a critical action.
 * Maker-checker: the rejector must differ from the requester.
 */
export async function rejectCriticalActionWithRbac(
  pool: Pool,
  rbac: RbacContext,
  criticalActionId: string,
  reason: string,
): Promise<CriticalAction> {
  const action = await getCriticalActionById(pool, criticalActionId);
  if (!action) throw new Error(`Critical action ${criticalActionId} not found`);

  if (!canApproveCriticalAction(rbac, action.actionType)) {
    throw new Error(
      'You do not have permission to reject this — it needs the “Approve a critical action” right.',
    );
  }

  if (rbac.userId === action.requestedBy) {
    throw new MakerCheckerViolationError(rbac.userId, criticalActionId);
  }

  return rejectCriticalAction(pool, criticalActionId, rbac.userId, reason);
}

export class MakerCheckerViolationError extends Error {
  constructor(
    public readonly userId: string,
    public readonly criticalActionId: string,
  ) {
    super(
      `Maker-checker violation: user ${userId} cannot both request and approve/reject critical action ${criticalActionId}`,
    );
    this.name = 'MakerCheckerViolationError';
  }
}
