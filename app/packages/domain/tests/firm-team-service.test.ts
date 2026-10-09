/**
 * Firm coordinator (team) administration integration tests — UX-FRM-007.
 * This is ORDINARY account admin, NOT maker-checker. The graded rules:
 *  - Lead handover is immediate and NOT reversible by the outgoing lead
 *    (only the new lead can hand it on).
 *  - The outgoing lead keeps ordinary coordinator access (demotion, not removal).
 *  - A PIN change requires the correct current PIN once one is set.
 *  - Removal is immediate; a re-add issues a NEW access code (a fresh row).
 *  - No coordinator gains visibility of another respondent's answers (boundary
 *    lives at the query layer — asserted in the journey-service suite).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createOrganization, listActiveCoordinators, getActiveLead } from '@cis/db';
import { verifyPassword } from '@cis/auth';
import {
  createLeadCoordinator,
  addCoordinator,
  setCoordinatorPin,
  handOverLead,
  removeCoordinator,
  FirmTeamError,
  PinVerificationError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let orgId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const org = await createOrganization(pool, {
    slug: 'team-firm',
    displayName: 'Team Firm',
    orgType: 'firm',
  });
  orgId = org.id;
});
afterAll(async () => {
  await closeTestPool();
});

describe('Lead handover', () => {
  it('is immediate, demotes the outgoing lead (who keeps access), and promotes the new lead', async () => {
    const lead = await createLeadCoordinator(pool, {
      organizationId: orgId,
      name: 'Lead One',
      email: 'lead1@firm.example',
    });
    const other = await addCoordinator(pool, {
      organizationId: orgId,
      name: 'Coord Two',
      email: 'coord2@firm.example',
    });

    const { outgoing, incoming } = await handOverLead(pool, {
      organizationId: orgId,
      actingCoordinatorId: lead.id,
      newLeadCoordinatorId: other.id,
    });

    expect(incoming.id).toBe(other.id);
    expect(incoming.isLead).toBe(true);
    expect(outgoing.isLead).toBe(false);

    // Exactly one active lead, and it is the new one.
    const activeLead = await getActiveLead(pool, orgId);
    expect(activeLead?.id).toBe(other.id);

    // Outgoing lead retains ordinary coordinator access (still active).
    const active = await listActiveCoordinators(pool, orgId);
    expect(active.map((c) => c.id).sort()).toEqual([lead.id, other.id].sort());
  });

  it('is NOT reversible by the outgoing lead — only the new lead can hand it back', async () => {
    const lead = await createLeadCoordinator(pool, {
      organizationId: orgId,
      name: 'Lead One',
      email: 'lead1@firm.example',
    });
    const other = await addCoordinator(pool, {
      organizationId: orgId,
      name: 'Coord Two',
      email: 'coord2@firm.example',
    });
    await handOverLead(pool, {
      organizationId: orgId,
      actingCoordinatorId: lead.id,
      newLeadCoordinatorId: other.id,
    });

    // The outgoing lead can no longer initiate a handover.
    await expect(
      handOverLead(pool, {
        organizationId: orgId,
        actingCoordinatorId: lead.id,
        newLeadCoordinatorId: lead.id,
      }),
    ).rejects.toBeInstanceOf(FirmTeamError);

    // But the NEW lead can hand it back.
    const { incoming } = await handOverLead(pool, {
      organizationId: orgId,
      actingCoordinatorId: other.id,
      newLeadCoordinatorId: lead.id,
    });
    expect(incoming.id).toBe(lead.id);
    expect((await getActiveLead(pool, orgId))?.id).toBe(lead.id);
  });
});

describe('PIN change requires the current PIN', () => {
  it('sets an initial PIN, then refuses a change without the correct current PIN', async () => {
    const lead = await createLeadCoordinator(pool, {
      organizationId: orgId,
      name: 'Lead One',
      email: 'lead1@firm.example',
    });

    // First set: no current PIN required.
    await setCoordinatorPin(pool, lead.id, { newPin: '1234' });

    // Wrong current PIN is rejected.
    await expect(
      setCoordinatorPin(pool, lead.id, { newPin: '5678', currentPin: '0000' }),
    ).rejects.toBeInstanceOf(PinVerificationError);

    // Missing current PIN is rejected.
    await expect(setCoordinatorPin(pool, lead.id, { newPin: '5678' })).rejects.toBeInstanceOf(
      PinVerificationError,
    );

    // Correct current PIN succeeds and the new PIN is what is now stored.
    await setCoordinatorPin(pool, lead.id, { newPin: '5678', currentPin: '1234' });
    const hash = (await listActiveCoordinators(pool, orgId)).find((c) => c.id === lead.id);
    expect(hash).toBeTruthy();
    // Verify the stored hash matches the new PIN (not the old).
    const row = await pool.query<{ pin_hash: string }>(
      'SELECT pin_hash FROM firm_coordinators WHERE id = $1',
      [lead.id],
    );
    expect(await verifyPassword('5678', row.rows[0]!.pin_hash)).toBe(true);
    expect(await verifyPassword('1234', row.rows[0]!.pin_hash)).toBe(false);
  });
});

describe('Removal', () => {
  it('is immediate and a re-add issues a NEW access code (a fresh row)', async () => {
    await createLeadCoordinator(pool, {
      organizationId: orgId,
      name: 'Lead One',
      email: 'lead1@firm.example',
    });
    const coord = await addCoordinator(pool, {
      organizationId: orgId,
      name: 'Coord Two',
      email: 'coord2@firm.example',
    });
    const firstCode = coord.accessCode;

    await removeCoordinator(pool, { organizationId: orgId, coordinatorId: coord.id });
    // No longer active.
    expect((await listActiveCoordinators(pool, orgId)).some((c) => c.id === coord.id)).toBe(false);

    // Re-add the same person → a brand-new row with a new access code.
    const readded = await addCoordinator(pool, {
      organizationId: orgId,
      name: 'Coord Two',
      email: 'coord2@firm.example',
    });
    expect(readded.id).not.toBe(coord.id);
    expect(readded.accessCode).not.toBe(firstCode);
  });

  it('refuses to remove the active lead directly (must hand over first)', async () => {
    const lead = await createLeadCoordinator(pool, {
      organizationId: orgId,
      name: 'Lead One',
      email: 'lead1@firm.example',
    });
    await expect(
      removeCoordinator(pool, { organizationId: orgId, coordinatorId: lead.id }),
    ).rejects.toBeInstanceOf(FirmTeamError);
  });
});
