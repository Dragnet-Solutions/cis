import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import {
  createCoordinator,
  getCoordinatorById,
  getCoordinatorPinHash,
  getActiveLead,
  listActiveCoordinators,
  setCoordinatorPinHash,
  setCoordinatorLead,
  revokeCoordinator,
  withTransaction,
} from '@cis/db';
import { hashPassword, verifyPassword } from '@cis/auth';
import type { FirmCoordinator } from '@cis/shared-types';
import { DomainError } from './errors';

/**
 * Firm coordinator (team) administration — UX-FRM-007.
 *
 * This is ORDINARY ACCOUNT ADMINISTRATION, deliberately NOT the maker-checker
 * flow: a firm managing its own coordinators does not go through the
 * request/approve critical-action machinery. The rules that DO hold, and are
 * enforced here rather than left to the UI:
 *
 *  - Lead handover is immediate and is NOT reversible by the outgoing lead:
 *    only the current (new) lead can hand the role on. The outgoing lead keeps
 *    ordinary coordinator access — it is a demotion, not a removal.
 *  - A PIN change requires the current PIN (once one is set).
 *  - Removing a coordinator is immediate; a later re-add issues a brand-new
 *    access code (a fresh row), never reactivating the old credential.
 *  - No coordinator ever gains visibility of another respondent's answers —
 *    that boundary lives at the query layer (getFirmRespondentStatuses returns
 *    status only), so nothing here can widen it.
 */

/** An account-admin rule for a firm coordinator was violated. */
export class FirmTeamError extends DomainError {
  constructor(message: string, code = 'FIRM_TEAM') {
    super(message, code);
  }
}

/** A PIN change was attempted without the correct current PIN. */
export class PinVerificationError extends FirmTeamError {
  constructor() {
    super('The current PIN is required and must be correct to change it', 'PIN_VERIFICATION');
  }
}

/** A short, human-transcribable access code (not a secret PIN). */
function generateAccessCode(): string {
  // 8 upper-case alphanumerics, unambiguous set (no O/0/I/1).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (const b of bytes) {
    code += alphabet[b % alphabet.length] ?? '';
  }
  return code;
}

/**
 * Create the firm's first coordinator, who becomes the lead. This is the
 * sole-coordinator default: with one coordinator there is nothing to hand over,
 * and that consequence is surfaced by the caller.
 */
export async function createLeadCoordinator(
  pool: Pool,
  data: {
    organizationId: string;
    name: string;
    email: string;
    role?: string | null;
    phone?: string | null;
  },
): Promise<FirmCoordinator> {
  const existingLead = await getActiveLead(pool, data.organizationId);
  if (existingLead) {
    throw new FirmTeamError('This firm already has an active lead coordinator', 'LEAD_EXISTS');
  }
  return createCoordinator(pool, {
    organizationId: data.organizationId,
    name: data.name,
    email: data.email,
    role: data.role ?? null,
    phone: data.phone ?? null,
    isLead: true,
    accessCode: generateAccessCode(),
  });
}

/**
 * Add an additional (non-lead) coordinator. Every add mints a fresh access
 * code, so a re-add after removal never reuses the previous credential.
 */
export async function addCoordinator(
  pool: Pool,
  data: {
    organizationId: string;
    name: string;
    email: string;
    role?: string | null;
    phone?: string | null;
  },
): Promise<FirmCoordinator> {
  return createCoordinator(pool, {
    organizationId: data.organizationId,
    name: data.name,
    email: data.email,
    role: data.role ?? null,
    phone: data.phone ?? null,
    isLead: false,
    accessCode: generateAccessCode(),
  });
}

/**
 * Set or change a coordinator's PIN. If a PIN is already set, the correct
 * current PIN MUST be supplied — this is not maker-checker, but a self-service
 * credential change still proves possession of the existing PIN.
 */
export async function setCoordinatorPin(
  pool: Pool,
  coordinatorId: string,
  data: { newPin: string; currentPin?: string },
): Promise<void> {
  const coordinator = await getCoordinatorById(pool, coordinatorId);
  if (!coordinator || coordinator.revokedAt) {
    throw new FirmTeamError('Coordinator not found', 'COORDINATOR_NOT_FOUND');
  }
  if (!data.newPin || data.newPin.length < 4) {
    throw new FirmTeamError('A PIN of at least 4 digits is required', 'INVALID_PIN');
  }

  const existingHash = await getCoordinatorPinHash(pool, coordinatorId);
  if (existingHash) {
    if (!data.currentPin || !(await verifyPassword(data.currentPin, existingHash))) {
      throw new PinVerificationError();
    }
  }

  const hash = await hashPassword(data.newPin);
  await setCoordinatorPinHash(pool, coordinatorId, hash);
}

/**
 * Hand the lead role from the current lead to another active coordinator.
 *
 * Enforces the UX-FRM-007 rule set: the acting coordinator MUST be the current
 * lead (so an outgoing lead cannot reverse a handover — after handing over they
 * are no longer the lead, and only the lead may hand over). The change is
 * immediate and atomic, and the outgoing lead is demoted to an ordinary
 * coordinator, NOT removed — they keep their access.
 */
export async function handOverLead(
  pool: Pool,
  data: { organizationId: string; actingCoordinatorId: string; newLeadCoordinatorId: string },
): Promise<{ outgoing: FirmCoordinator; incoming: FirmCoordinator }> {
  const currentLead = await getActiveLead(pool, data.organizationId);
  if (!currentLead) {
    throw new FirmTeamError('This firm has no active lead coordinator', 'NO_LEAD');
  }
  // Only the current lead can hand over — this is what makes a handover
  // irreversible by the outgoing lead.
  if (currentLead.id !== data.actingCoordinatorId) {
    throw new FirmTeamError(
      'Only the current lead coordinator can hand over the lead role',
      'NOT_LEAD',
    );
  }
  if (data.newLeadCoordinatorId === currentLead.id) {
    throw new FirmTeamError('The lead role is already held by this coordinator', 'ALREADY_LEAD');
  }

  const incoming = await getCoordinatorById(pool, data.newLeadCoordinatorId);
  if (!incoming || incoming.revokedAt || incoming.organizationId !== data.organizationId) {
    throw new FirmTeamError(
      'The new lead must be an active coordinator of this firm',
      'INVALID_NEW_LEAD',
    );
  }

  await withTransaction(pool, async (client) => {
    // Demote current lead first — the partial unique index forbids two active
    // leads, so the old flag must clear before the new one is set.
    await setCoordinatorLead(client as unknown as Pool, currentLead.id, false);
    await setCoordinatorLead(client as unknown as Pool, incoming.id, true);
  });

  const outgoing = await getCoordinatorById(pool, currentLead.id);
  const newLead = await getCoordinatorById(pool, incoming.id);
  if (!outgoing || !newLead) throw new Error('Coordinator disappeared during handover');
  return { outgoing, incoming: newLead };
}

/**
 * Remove a coordinator, immediately. The active lead cannot be removed directly
 * — the lead must be handed over first (otherwise the firm would be left with
 * no lead). A subsequent re-add of the same person creates a NEW row with a NEW
 * access code via addCoordinator.
 */
export async function removeCoordinator(
  pool: Pool,
  data: { organizationId: string; coordinatorId: string },
): Promise<void> {
  const coordinator = await getCoordinatorById(pool, data.coordinatorId);
  if (!coordinator || coordinator.revokedAt || coordinator.organizationId !== data.organizationId) {
    throw new FirmTeamError('Coordinator not found', 'COORDINATOR_NOT_FOUND');
  }
  if (coordinator.isLead) {
    throw new FirmTeamError(
      'The lead coordinator must hand over the lead role before being removed',
      'CANNOT_REMOVE_LEAD',
    );
  }
  await revokeCoordinator(pool, data.coordinatorId);
}

/** List a firm's active coordinators (lead first). Never exposes answers. */
export async function listCoordinators(
  pool: Pool,
  organizationId: string,
): Promise<FirmCoordinator[]> {
  return listActiveCoordinators(pool, organizationId);
}
