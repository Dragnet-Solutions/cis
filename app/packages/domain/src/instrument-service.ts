import { Pool } from 'pg';
import {
  getEditionById,
  getCriticalActionById,
  getPendingCriticalActionForEdition,
  createCriticalAction,
  isEditionInstrumentSetFrozen,
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
import type { CriticalAction } from '@cis/shared-types';
import {
  EditionStateError,
  InvalidReasonError,
  CriticalActionStateError,
  DomainError,
  MIN_REASON_LENGTH,
} from './errors';
import type { ActorContext } from './edition-service';

/** Action type for the "freeze the instruments" critical action. */
export const INSTRUMENT_FREEZE_ACTION = 'instrument_freeze';

export async function requestFreeze(
  pool: Pool,
  rbac: RbacContext,
  editionId: string,
  reason: string,
  ctx: ActorContext = {},
): Promise<CriticalAction> {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH) throw new InvalidReasonError();

  if (!canRequestCriticalAction(rbac, INSTRUMENT_FREEZE_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `request:${INSTRUMENT_FREEZE_ACTION}`);
  }

  const edition = await getEditionById(pool, editionId);
  if (!edition) throw new EditionStateError(`Edition ${editionId} not found`);
  if (edition.status !== 'draft') {
    throw new EditionStateError(
      `Instruments can only be frozen while the edition is in draft (current: ${edition.status})`,
    );
  }

  if (await isEditionInstrumentSetFrozen(pool, editionId)) {
    throw new EditionStateError('The instruments are already frozen for this edition');
  }

  const existing = await getPendingCriticalActionForEdition(
    pool,
    editionId,
    INSTRUMENT_FREEZE_ACTION,
  );
  if (existing) {
    throw new CriticalActionStateError(
      'A freeze request is already awaiting a decision for this edition',
    );
  }

  const action = await createCriticalAction(pool, {
    actionType: INSTRUMENT_FREEZE_ACTION,
    requestedBy: rbac.userId,
    payload: { reason: trimmed, editionLabel: edition.label },
    editionId,
  });

  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: 'critical_action.requested',
    entityType: 'critical_action',
    entityId: action.id,
    editionId,
    newValue: { actionType: INSTRUMENT_FREEZE_ACTION },
    reason: trimmed,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return action;
}

export interface FreezeDecision {
  approved: boolean;
  rejectionReason?: string;
}

export async function decideFreeze(
  pool: Pool,
  rbac: RbacContext,
  editionId: string,
  actionId: string,
  decision: FreezeDecision,
  ctx: ActorContext = {},
): Promise<{ action: CriticalAction; frozen: boolean }> {
  const action = await getCriticalActionById(pool, actionId);
  if (!action) throw new CriticalActionStateError(`Critical action ${actionId} not found`);
  if (action.actionType !== INSTRUMENT_FREEZE_ACTION || action.editionId !== editionId) {
    throw new CriticalActionStateError(
      `Critical action ${actionId} is not a freeze request for edition ${editionId}`,
    );
  }
  if (action.status !== 'pending') {
    throw new CriticalActionStateError(
      `Critical action ${actionId} is not pending (status: ${action.status})`,
    );
  }

  if (!canApproveCriticalAction(rbac, INSTRUMENT_FREEZE_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `approve:${INSTRUMENT_FREEZE_ACTION}`);
  }
  if (rbac.userId === action.requestedBy) {
    throw new MakerCheckerViolationError(rbac.userId, actionId);
  }

  if (decision.approved) {
    // Approve the action AND freeze every instrument into an immutable snapshot,
    // atomically. If any part fails, none of it takes effect.
    await withTransaction(pool, async (client) => {
      const a = await client.query(
        `UPDATE critical_actions
         SET status='approved', approved_by=$1, approved_at=NOW()
         WHERE id=$2 AND status='pending' AND requested_by <> $1`,
        [rbac.userId, actionId],
      );
      if (a.rowCount === 0) {
        throw new CriticalActionStateError('Freeze request could not be approved');
      }

      const defs = await client.query<{ id: string }>(
        `SELECT id FROM instrument_definitions ORDER BY code`,
      );
      if (defs.rowCount === 0) {
        throw new DomainError('No instruments exist to freeze', 'NO_INSTRUMENTS');
      }

      for (const def of defs.rows) {
        const versionResult = await client.query<{ id: string }>(
          `SELECT id FROM instrument_definition_versions
           WHERE instrument_definition_id = $1
           ORDER BY version_number DESC
           LIMIT 1`,
          [def.id],
        );
        const version = versionResult.rows[0];
        if (!version) {
          throw new DomainError(
            `Instrument ${def.id} has no version to freeze`,
            'INSTRUMENT_NO_VERSION',
          );
        }
        await client.query(
          `UPDATE instrument_definition_versions
           SET is_frozen = TRUE, frozen_at = NOW(), frozen_by = $1
           WHERE id = $2`,
          [rbac.userId, version.id],
        );
        await client.query(
          `INSERT INTO edition_instrument_snapshots
             (edition_id, instrument_definition_version_id, frozen_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (edition_id, instrument_definition_version_id) DO NOTHING`,
          [editionId, version.id, rbac.userId],
        );
      }
    });

    await writeAudit(pool, {
      actorId: rbac.userId,
      actionType: 'critical_action.approved',
      entityType: 'critical_action',
      entityId: actionId,
      editionId,
      oldValue: { status: 'pending' },
      newValue: { status: 'approved' },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    await writeAudit(pool, {
      actorId: rbac.userId,
      actionType: 'instruments.frozen',
      entityType: 'edition',
      entityId: editionId,
      editionId,
      newValue: { frozen: true },
      reason: typeof action.payload['reason'] === 'string' ? action.payload['reason'] : null,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } else {
    const rejectionReason = decision.rejectionReason?.trim() || 'Rejected by checker';
    await withTransaction(pool, async (client) => {
      const a = await client.query(
        `UPDATE critical_actions
         SET status='rejected', rejected_by=$1, rejected_at=NOW(), rejection_reason=$2
         WHERE id=$3 AND status='pending' AND requested_by <> $1`,
        [rbac.userId, rejectionReason, actionId],
      );
      if (a.rowCount === 0) {
        throw new CriticalActionStateError('Freeze request could not be rejected');
      }
    });

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
  }

  const updatedAction = await getCriticalActionById(pool, actionId);
  if (!updatedAction) throw new CriticalActionStateError('Action disappeared after decision');
  const frozen = await isEditionInstrumentSetFrozen(pool, editionId);
  return { action: updatedAction, frozen };
}
