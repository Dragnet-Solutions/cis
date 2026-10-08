import { Pool } from 'pg';
import {
  getEditionById,
  updateClosingDate,
  updatePlannedOpenAt,
  openEditionFromDraft,
  upsertSampleFloor,
  getSampleFloor,
  isEditionInstrumentSetFrozen,
  getCriticalActionById,
  createCriticalAction,
  withTransaction,
} from '@cis/db';
import {
  requirePermission,
  canRequestCriticalAction,
  canApproveCriticalAction,
  PermissionDeniedError,
  MakerCheckerViolationError,
  type RbacContext,
} from '@cis/auth';
import { writeAudit } from '@cis/audit';
import type {
  Edition,
  CriticalAction,
  EditionSampleFloor,
  SampleFloorCategory,
} from '@cis/shared-types';
import {
  EditionStateError,
  InstrumentsNotFrozenError,
  InvalidReasonError,
  CriticalActionStateError,
  MIN_REASON_LENGTH,
} from './errors';

/** Action type for the "lock the results" critical action on the edition surface. */
export const EDITION_LOCK_ACTION = 'edition:lock';

/** Standard permission required to edit an edition's floors / closing date. */
export const EDITION_MANAGE_PERMISSION = 'edition:manage';

export interface ActorContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

// ─── Closing date ───────────────────────────────────────────────────────────
// Editable while the edition is not locked (draft OR open) — the "last day for
// returns" can be moved while collection runs, per UX-ADM-001. Locked editions
// are read-only history.

export async function setClosingDate(
  pool: Pool,
  rbac: RbacContext,
  editionId: string,
  closesAt: Date,
  ctx: ActorContext = {},
): Promise<Edition> {
  requirePermission(rbac, EDITION_MANAGE_PERMISSION);

  const edition = await getEditionById(pool, editionId);
  if (!edition) throw new EditionStateError(`Edition ${editionId} not found`);
  if (edition.status === 'locked' || edition.status === 'archived') {
    throw new EditionStateError(
      `The closing date cannot be changed once the edition is ${edition.status}`,
    );
  }

  const updated = await updateClosingDate(pool, editionId, closesAt);

  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: 'edition.closing_date.changed',
    entityType: 'edition',
    entityId: editionId,
    editionId,
    oldValue: { surveyCloseAt: edition.surveyCloseAt?.toISOString() ?? null },
    newValue: { surveyCloseAt: updated.surveyCloseAt?.toISOString() ?? null },
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return updated;
}

// ─── Planned opening date (Phase 19, item 2 — the edition-opening trigger) ────
// `survey_open_at` already existed (initial schema) as the timestamp of the
// REAL draft→open transition, set by `openEditionFromDraft`/`markOpened` —
// but nothing ever called that path, so the edition genuinely had no way to
// open. `plannedOpenAt` is the NEW study-team-configured launch instant;
// `evaluateAutoOpen` below is the lazy-evaluation trigger that compares it
// against `asOf` on every edition read, favoured over a cron job (matching
// this codebase's existing precedent — e.g. Phase 13's reminder engine is a
// manually/read-triggered `run`, not a scheduler).

/** Editable only while the edition is still in draft — a launch plan is
 *  meaningless once the edition has actually opened. */
export async function setSurveyOpenAt(
  pool: Pool,
  rbac: RbacContext,
  editionId: string,
  plannedOpenAt: Date | null,
  ctx: ActorContext = {},
): Promise<Edition> {
  requirePermission(rbac, EDITION_MANAGE_PERMISSION);

  const edition = await getEditionById(pool, editionId);
  if (!edition) throw new EditionStateError(`Edition ${editionId} not found`);
  if (edition.status !== 'draft') {
    throw new EditionStateError(
      `The planned opening date can only be set while the edition is in draft (current: ${edition.status})`,
    );
  }

  const updated = await updatePlannedOpenAt(pool, editionId, plannedOpenAt);

  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: 'edition.planned_open_at.changed',
    entityType: 'edition',
    entityId: editionId,
    editionId,
    oldValue: { plannedOpenAt: edition.plannedOpenAt?.toISOString() ?? null },
    newValue: { plannedOpenAt: updated.plannedOpenAt?.toISOString() ?? null },
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return updated;
}

export interface AutoOpenResult {
  edition: Edition;
  /** True only when this call actually transitioned the edition to open. */
  opened: boolean;
  /** Set when the planned launch instant has passed but the instrument set
   *  is not frozen — a loud, surfaceable problem, never a silent no-op. */
  problem: 'launch_date_passed_not_frozen' | null;
}

/**
 * Lazy-evaluate the opening trigger: if the edition is still draft and its
 * planned launch instant has passed, attempt to open it (reusing `markOpened`,
 * which itself enforces the frozen-instrument-set gate). Called on every
 * edition read (the API route), so no cron is needed — the check simply runs
 * whenever anyone looks at the edition. A no-op (returns `opened: false,
 * problem: null`) when there is nothing to evaluate (not draft, or no plan
 * set, or the plan has not yet arrived).
 */
export async function evaluateAutoOpen(
  pool: Pool,
  editionId: string,
  asOf: Date = new Date(),
): Promise<AutoOpenResult> {
  const edition = await getEditionById(pool, editionId);
  if (!edition) throw new EditionStateError(`Edition ${editionId} not found`);
  if (edition.status !== 'draft' || !edition.plannedOpenAt || asOf < edition.plannedOpenAt) {
    return { edition, opened: false, problem: null };
  }

  const frozen = await isEditionInstrumentSetFrozen(pool, editionId);
  if (!frozen) {
    return { edition, opened: false, problem: 'launch_date_passed_not_frozen' };
  }

  const opened = await markOpened(pool, editionId, {});
  return { edition: opened, opened: true, problem: null };
}

// ─── Sample floors ────────────────────────────────────────────────────────────
// Editable ONLY while the edition is in draft. Changing a floor after collection
// opens is prohibited — it would let someone choose what is reportable after
// seeing what the data says. Enforced here at the service layer.

export async function setSampleFloor(
  pool: Pool,
  rbac: RbacContext,
  editionId: string,
  category: SampleFloorCategory,
  floorValue: number,
  ctx: ActorContext = {},
): Promise<EditionSampleFloor> {
  requirePermission(rbac, EDITION_MANAGE_PERMISSION);

  if (!Number.isInteger(floorValue) || floorValue < 1) {
    throw new EditionStateError('A sample floor must be an integer of at least 1');
  }

  const edition = await getEditionById(pool, editionId);
  if (!edition) throw new EditionStateError(`Edition ${editionId} not found`);
  if (edition.status !== 'draft') {
    throw new EditionStateError(
      `Sample floors can only be changed while the edition is in draft (current: ${edition.status})`,
    );
  }

  const previous = await getSampleFloor(pool, editionId, category);
  const floor = await upsertSampleFloor(pool, { editionId, category, floorValue });

  await writeAudit(pool, {
    actorId: rbac.userId,
    actionType: 'edition.sample_floor.changed',
    entityType: 'edition_sample_floor',
    entityId: floor.id,
    editionId,
    oldValue: { category, floorValue: previous?.floorValue ?? null },
    newValue: { category, floorValue },
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return floor;
}

// ─── markOpened (internal, not a user-facing endpoint) ──────────────────────────
// The edition opens as a side effect of the first invitation going out (owned by
// UX-OPS-002). This hook is what that future service calls. It is deliberately
// NOT wired to any HTTP route in this phase. It:
//   - fires only from draft (so it can happen exactly once),
//   - hard-fails unless the instrument set is frozen.

export async function markOpened(
  pool: Pool,
  editionId: string,
  opts: ActorContext & { actorId?: string | null } = {},
): Promise<Edition> {
  const edition = await getEditionById(pool, editionId);
  if (!edition) throw new EditionStateError(`Edition ${editionId} not found`);
  if (edition.status !== 'draft') {
    throw new EditionStateError(
      `Edition ${editionId} can only be opened from draft (current: ${edition.status})`,
    );
  }

  const frozen = await isEditionInstrumentSetFrozen(pool, editionId);
  if (!frozen) {
    throw new InstrumentsNotFrozenError(editionId);
  }

  const opened = await openEditionFromDraft(pool, editionId);

  await writeAudit(pool, {
    actorId: opts.actorId ?? null,
    actionType: 'edition.opened',
    entityType: 'edition',
    entityId: editionId,
    editionId,
    oldValue: { status: 'draft' },
    newValue: { status: 'open' },
    reason: 'First invitations dispatched',
    ipAddress: opts.ipAddress ?? null,
    userAgent: opts.userAgent ?? null,
  });

  return opened;
}

// ─── Lock the results (critical action) ─────────────────────────────────────────

export async function requestLock(
  pool: Pool,
  rbac: RbacContext,
  editionId: string,
  reason: string,
  ctx: ActorContext = {},
): Promise<CriticalAction> {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH) throw new InvalidReasonError();

  if (!canRequestCriticalAction(rbac, EDITION_LOCK_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `request:${EDITION_LOCK_ACTION}`);
  }

  const edition = await getEditionById(pool, editionId);
  if (!edition) throw new EditionStateError(`Edition ${editionId} not found`);
  if (edition.status !== 'open') {
    throw new EditionStateError(`Only an open edition can be locked (current: ${edition.status})`);
  }

  const action = await createCriticalAction(pool, {
    actionType: EDITION_LOCK_ACTION,
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
    newValue: { actionType: EDITION_LOCK_ACTION },
    reason: trimmed,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  return action;
}

export interface LockDecision {
  approved: boolean;
  rejectionReason?: string;
}

export async function decideLock(
  pool: Pool,
  rbac: RbacContext,
  editionId: string,
  actionId: string,
  decision: LockDecision,
  ctx: ActorContext = {},
): Promise<{ action: CriticalAction; edition: Edition }> {
  const action = await getCriticalActionById(pool, actionId);
  if (!action) throw new CriticalActionStateError(`Critical action ${actionId} not found`);
  if (action.actionType !== EDITION_LOCK_ACTION || action.editionId !== editionId) {
    throw new CriticalActionStateError(
      `Critical action ${actionId} is not a lock request for edition ${editionId}`,
    );
  }
  if (action.status !== 'pending') {
    throw new CriticalActionStateError(
      `Critical action ${actionId} is not pending (status: ${action.status})`,
    );
  }

  if (!canApproveCriticalAction(rbac, EDITION_LOCK_ACTION)) {
    throw new PermissionDeniedError(rbac.userId, `approve:${EDITION_LOCK_ACTION}`);
  }
  // Maker-checker: the decider must be a different person than the requester.
  // Also enforced by DB CHECK; this gives a meaningful error before the write.
  if (rbac.userId === action.requestedBy) {
    throw new MakerCheckerViolationError(rbac.userId, actionId);
  }

  if (decision.approved) {
    // Approve the action and lock the edition atomically.
    await withTransaction(pool, async (client) => {
      const a = await client.query(
        `UPDATE critical_actions
         SET status='approved', approved_by=$1, approved_at=NOW()
         WHERE id=$2 AND status='pending' AND requested_by <> $1`,
        [rbac.userId, actionId],
      );
      if (a.rowCount === 0) {
        throw new CriticalActionStateError('Lock request could not be approved');
      }
      const e = await client.query(
        `UPDATE editions
         SET status='locked', locked_at=NOW(), locked_by=$1, updated_at=NOW()
         WHERE id=$2 AND status <> 'locked'`,
        [rbac.userId, editionId],
      );
      if (e.rowCount === 0) {
        throw new EditionStateError(`Edition ${editionId} could not be locked`);
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
      actionType: 'edition.locked',
      entityType: 'edition',
      entityId: editionId,
      editionId,
      oldValue: { status: 'open' },
      newValue: { status: 'locked' },
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
        throw new CriticalActionStateError('Lock request could not be rejected');
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
  const updatedEdition = await getEditionById(pool, editionId);
  if (!updatedAction || !updatedEdition) {
    throw new CriticalActionStateError('State disappeared after lock decision');
  }
  return { action: updatedAction, edition: updatedEdition };
}
