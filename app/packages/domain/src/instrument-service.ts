import { Pool } from 'pg';
import {
  getEditionById,
  getCriticalActionById,
  getPendingCriticalActionForEdition,
  createCriticalAction,
  isEditionInstrumentSetFrozen,
  listInstrumentsNotFrozenForEdition,
  listQuestionsContaining,
  REGISTER_TODO_MARKER,
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

/** The Register still holds placeholder content: the controlled document has
 *  not been loaded for these items, so the instruments cannot be frozen. */
export class RegisterContentIncompleteError extends DomainError {
  constructor(public readonly questionCodes: string[]) {
    super(
      `The instruments cannot be frozen: ${questionCodes.length} survey item${questionCodes.length === 1 ? '' : 's'} ` +
        `still carr${questionCodes.length === 1 ? 'ies' : 'y'} placeholder content marked ${REGISTER_TODO_MARKER} ` +
        `(${questionCodes.join(', ')}). Load the controlled wording into the Survey Register first.`,
      'REGISTER_CONTENT_INCOMPLETE',
    );
  }
}

async function assertNoPlaceholderContent(db: Pick<Pool, 'query'>): Promise<void> {
  const codes = await listQuestionsContaining(db, REGISTER_TODO_MARKER);
  if (codes.length > 0) throw new RegisterContentIncompleteError(codes);
}

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

  // Two kinds of freeze, one maker-checker action:
  //  - initial: a draft edition's whole instrument set;
  //  - add: instruments registered after the edition was frozen (e.g. I-LCFE
  //    joining an open edition). Only instruments with no snapshot in this
  //    edition are added; existing snapshots are never touched.
  const alreadyFrozen = await isEditionInstrumentSetFrozen(pool, editionId);
  const pendingCodes = await listInstrumentsNotFrozenForEdition(pool, editionId);
  if (alreadyFrozen) {
    if (edition.status !== 'draft' && edition.status !== 'open') {
      throw new EditionStateError(
        `New instruments can only be added while the edition is in draft or open (current: ${edition.status})`,
      );
    }
    if (pendingCodes.length === 0) {
      throw new EditionStateError('The instruments are already frozen for this edition');
    }
  } else if (edition.status !== 'draft') {
    throw new EditionStateError(
      `Instruments can only be frozen while the edition is in draft (current: ${edition.status})`,
    );
  }
  await assertNoPlaceholderContent(pool);

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
    payload: {
      reason: trimmed,
      editionLabel: edition.label,
      mode: alreadyFrozen ? 'add' : 'initial',
      instrumentCodes: pendingCodes,
    },
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
    const edition = await getEditionById(pool, editionId);
    if (!edition || (edition.status !== 'draft' && edition.status !== 'open')) {
      throw new EditionStateError(
        `Instruments can only be frozen while the edition is in draft or open (current: ${edition?.status ?? 'missing'})`,
      );
    }
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
      // Re-checked at approval: placeholder content loaded after the request
      // must not be frozen either.
      await assertNoPlaceholderContent(client);

      // Only instruments with no snapshot in this edition — and, for an
      // "add" request, only the ones that request named — are frozen. An
      // existing snapshot is never touched.
      const pending = new Set(await listInstrumentsNotFrozenForEdition(client, editionId));
      const requested = Array.isArray(action.payload['instrumentCodes'])
        ? new Set(action.payload['instrumentCodes'] as string[])
        : null;
      const all = await client.query<{ id: string; code: string }>(
        `SELECT id, code FROM instrument_definitions ORDER BY code`,
      );
      if (all.rowCount === 0) {
        throw new DomainError('No instruments exist to freeze', 'NO_INSTRUMENTS');
      }
      const defs = {
        rows: all.rows.filter((d) => pending.has(d.code) && (!requested || requested.has(d.code))),
      };
      if (defs.rows.length === 0) {
        throw new CriticalActionStateError('Nothing is left to freeze for this request');
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
           WHERE id = $2 AND is_frozen = FALSE`,
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
      newValue: {
        frozen: true,
        mode: action.payload['mode'] ?? 'initial',
        instrumentCodes: action.payload['instrumentCodes'] ?? null,
      },
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
