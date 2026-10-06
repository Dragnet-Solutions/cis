/**
 * Maker-checker integration tests — proves:
 *  1. A user can request a critical action.
 *  2. A different user can approve it.
 *  3. The same user as the requester CANNOT approve or reject the action.
 *  4. The DB CHECK constraint enforces maker-checker even on direct SQL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createUser,
  createRole,
  createPermission,
  assignRoleToUser,
  assignPermissionToRole,
  createCriticalAction,
} from '@cis/db';
import {
  loadRbacContext,
  requestCriticalAction,
  approveCriticalActionWithRbac,
  rejectCriticalActionWithRbac,
  MakerCheckerViolationError,
  PermissionDeniedError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});

beforeEach(async () => {
  await truncateAllTables(pool);
});

afterAll(async () => {
  await closeTestPool();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function seedUsersWithPermissions() {
  const maker = await createUser(pool, {
    email: 'maker@example.com',
    passwordHash: '$argon2id$test',
    displayName: 'Maker',
  });
  const checker = await createUser(pool, {
    email: 'checker@example.com',
    passwordHash: '$argon2id$test',
    displayName: 'Checker',
  });
  const makerRole = await createRole(pool, { name: 'maker' });
  const checkerRole = await createRole(pool, { name: 'checker' });

  const reqPerm = await createPermission(pool, {
    code: 'edition:lock:request',
    permissionType: 'can_request_critical_action',
    actionScope: 'edition:lock',
  });
  const appPerm = await createPermission(pool, {
    code: 'edition:lock:approve',
    permissionType: 'can_approve_critical_action',
    actionScope: 'edition:lock',
  });

  await assignPermissionToRole(pool, makerRole.id, reqPerm.id);
  await assignPermissionToRole(pool, checkerRole.id, appPerm.id);
  await assignRoleToUser(pool, maker.id, makerRole.id, null);
  await assignRoleToUser(pool, checker.id, checkerRole.id, null);

  return { maker, checker };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Maker-checker workflow', () => {
  it('maker can request a critical action', async () => {
    const { maker } = await seedUsersWithPermissions();
    const rbac = await loadRbacContext(pool, maker.id);

    const action = await requestCriticalAction(pool, rbac, {
      actionType: 'edition:lock',
      payload: { editionId: 'fake-id' },
    });

    expect(action.status).toBe('pending');
    expect(action.requestedBy).toBe(maker.id);
    expect(action.approvedBy).toBeNull();
  });

  it('checker (different user) can approve a pending critical action', async () => {
    const { maker, checker } = await seedUsersWithPermissions();
    const makerRbac = await loadRbacContext(pool, maker.id);
    const checkerRbac = await loadRbacContext(pool, checker.id);

    const action = await requestCriticalAction(pool, makerRbac, {
      actionType: 'edition:lock',
      payload: {},
    });

    const approved = await approveCriticalActionWithRbac(pool, checkerRbac, action.id);

    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe(checker.id);
    expect(approved.requestedBy).toBe(maker.id);
    expect(approved.approvedAt).not.toBeNull();
  });

  it('checker (different user) can reject a pending critical action', async () => {
    const { maker, checker } = await seedUsersWithPermissions();
    const makerRbac = await loadRbacContext(pool, maker.id);
    const checkerRbac = await loadRbacContext(pool, checker.id);

    const action = await requestCriticalAction(pool, makerRbac, {
      actionType: 'edition:lock',
      payload: {},
    });

    const rejected = await rejectCriticalActionWithRbac(
      pool,
      checkerRbac,
      action.id,
      'Not ready for lock',
    );

    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectedBy).toBe(checker.id);
    expect(rejected.rejectionReason).toBe('Not ready for lock');
  });

  it('REJECTS self-approval — requester cannot be the approver (service layer)', async () => {
    const { maker } = await seedUsersWithPermissions();

    // Give maker the approve permission too (single user with both)
    const checkerRole = await createRole(pool, { name: 'also-checker' });
    const appPerm = await createPermission(pool, {
      code: 'edition:lock:approve:2',
      permissionType: 'can_approve_critical_action',
      actionScope: 'edition:lock',
    });
    await assignPermissionToRole(pool, checkerRole.id, appPerm.id);
    await assignRoleToUser(pool, maker.id, checkerRole.id, null);

    const rbac = await loadRbacContext(pool, maker.id);
    const action = await requestCriticalAction(pool, rbac, {
      actionType: 'edition:lock',
      payload: {},
    });

    await expect(approveCriticalActionWithRbac(pool, rbac, action.id)).rejects.toThrow(
      MakerCheckerViolationError,
    );
  });

  it('REJECTS self-approval at the DATABASE level (CHECK constraint)', async () => {
    const { maker } = await seedUsersWithPermissions();

    // Insert critical action directly
    const action = await createCriticalAction(pool, {
      actionType: 'edition:lock',
      requestedBy: maker.id,
      payload: {},
    });

    // Attempt a direct UPDATE that sets approved_by = requested_by — must fail
    await expect(
      pool.query(
        `UPDATE critical_actions
         SET status = 'approved', approved_by = $1, approved_at = NOW()
         WHERE id = $2`,
        [maker.id, action.id],
      ),
    ).rejects.toThrow(/maker_checker_no_self_approval/);
  });

  it('user without can_request permission cannot create a critical action', async () => {
    const maker = await createUser(pool, {
      email: 'noperms@example.com',
      passwordHash: '$argon2id$test',
      displayName: 'No Perms',
    });
    const rbac = await loadRbacContext(pool, maker.id);

    await expect(
      requestCriticalAction(pool, rbac, { actionType: 'edition:lock', payload: {} }),
    ).rejects.toThrow(/do not have permission/);
  });

  it('user without can_approve permission cannot approve', async () => {
    const { maker } = await seedUsersWithPermissions();
    const noPermsUser = await createUser(pool, {
      email: 'noperms@example.com',
      passwordHash: '$argon2id$test',
      displayName: 'No Perms',
    });

    const makerRbac = await loadRbacContext(pool, maker.id);
    const noPermsRbac = await loadRbacContext(pool, noPermsUser.id);

    const action = await requestCriticalAction(pool, makerRbac, {
      actionType: 'edition:lock',
      payload: {},
    });

    await expect(approveCriticalActionWithRbac(pool, noPermsRbac, action.id)).rejects.toThrow(
      /do not have permission/,
    );
  });
});

// Regression (E2E, 2026-09-30): refusals reached the screen as
// "User <uuid> does not have permission: access:regs".
describe('Permission refusals read as plain language', () => {
  it('names the right, never the user id or the permission code', () => {
    const err = new PermissionDeniedError('0bdc2eca-4bcc-4554-a472-e17c454ccb73', 'access:regs');
    expect(err.message).toContain('Manage regulator engagement');
    expect(err.message).not.toMatch(/0bdc2eca|access:regs/);
    expect(err.userId).toBe('0bdc2eca-4bcc-4554-a472-e17c454ccb73');
    expect(err.requiredPermission).toBe('access:regs');
  });
});
