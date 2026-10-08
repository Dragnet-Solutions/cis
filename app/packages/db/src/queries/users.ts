import { Pool } from 'pg';
import type { User, Role, Permission, PermissionType } from '@cis/shared-types';
import { query } from '../client';

// ─── Row mappers ──────────────────────────────────────────────────────────────

interface RawUserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  organization: string | null;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RawRoleRow {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
}

interface RawPermissionRow {
  id: string;
  code: string;
  description: string | null;
  permission_type: string;
  action_scope: string | null;
  created_at: Date;
}

function mapUser(row: RawUserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    organization: row.organization,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRole(row: RawRoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
  };
}

function mapPermission(row: RawPermissionRow): Permission {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    permissionType: row.permission_type as PermissionType,
    actionScope: row.action_scope,
    createdAt: row.created_at,
  };
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function createUser(
  pool: Pool,
  data: { email: string; passwordHash: string; displayName: string; organization?: string | null },
): Promise<User> {
  const result = await query<RawUserRow>(
    pool,
    `INSERT INTO users (email, password_hash, display_name, organization)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.email, data.passwordHash, data.displayName, data.organization ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('User insert returned no rows');
  return mapUser(row);
}

export async function getUserByEmail(pool: Pool, email: string): Promise<User | null> {
  const result = await query<RawUserRow>(
    pool,
    'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
    [email],
  );
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

export async function getUserById(pool: Pool, id: string): Promise<User | null> {
  const result = await query<RawUserRow>(
    pool,
    'SELECT * FROM users WHERE id = $1 AND is_active = TRUE',
    [id],
  );
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

/**
 * Display names for operator identifiers recorded on sign-off rows. Those
 * columns are TEXT and normally hold the operator's email, but older rows may
 * hold a user id, so both are matched. Deactivated users are included — a
 * historical approval still names who gave it. Unmatched identifiers are
 * simply absent from the result.
 */
export async function getDisplayNamesByIdentifier(
  pool: Pool,
  identifiers: string[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(identifiers.filter((i) => i.length > 0))];
  if (wanted.length === 0) return {};
  const result = await query<{ id: string; email: string; display_name: string }>(
    pool,
    'SELECT id::text AS id, email, display_name FROM users WHERE email = ANY($1) OR id::text = ANY($1)',
    [wanted],
  );
  const names: Record<string, string> = {};
  for (const row of result.rows) {
    if (wanted.includes(row.email)) names[row.email] = row.display_name;
    if (wanted.includes(row.id)) names[row.id] = row.display_name;
  }
  return names;
}

export async function updateLastLogin(pool: Pool, userId: string): Promise<void> {
  await query(pool, 'UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);
}

// ─── Roles ────────────────────────────────────────────────────────────────────

export async function createRole(
  pool: Pool,
  data: { name: string; description?: string },
): Promise<Role> {
  const result = await query<RawRoleRow>(
    pool,
    `INSERT INTO roles (name, description) VALUES ($1, $2) RETURNING *`,
    [data.name, data.description ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Role insert returned no rows');
  return mapRole(row);
}

export async function assignRoleToUser(
  pool: Pool,
  userId: string,
  roleId: string,
  grantedBy: string | null,
): Promise<void> {
  await query(
    pool,
    `INSERT INTO user_roles (user_id, role_id, granted_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId, roleId, grantedBy],
  );
}

// ─── Permissions ──────────────────────────────────────────────────────────────

export async function createPermission(
  pool: Pool,
  data: {
    code: string;
    description?: string;
    permissionType?: PermissionType;
    actionScope?: string;
  },
): Promise<Permission> {
  const result = await query<RawPermissionRow>(
    pool,
    `INSERT INTO permissions (code, description, permission_type, action_scope)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      data.code,
      data.description ?? null,
      data.permissionType ?? 'standard',
      data.actionScope ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Permission insert returned no rows');
  return mapPermission(row);
}

export async function assignPermissionToRole(
  pool: Pool,
  roleId: string,
  permissionId: string,
): Promise<void> {
  await query(
    pool,
    `INSERT INTO role_permissions (role_id, permission_id)
     VALUES ($1, $2)
     ON CONFLICT (role_id, permission_id) DO NOTHING`,
    [roleId, permissionId],
  );
}

/**
 * Returns every permission a user holds, from BOTH their roles and any direct
 * per-person grants (`user_permissions`, added in Phase 8). The union means the
 * People & Access surface can grant a right directly to one person while the
 * Phase 0/1 role-based maker-checker path keeps resolving the same permission
 * set — neither has to know about the other.
 */
export async function getUserPermissions(pool: Pool, userId: string): Promise<Permission[]> {
  const result = await query<RawPermissionRow>(
    pool,
    `SELECT DISTINCT p.* FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
      WHERE ur.user_id = $1
     UNION
     SELECT DISTINCT p.* FROM permissions p
       JOIN user_permissions up ON up.permission_id = p.id
      WHERE up.user_id = $1`,
    [userId],
  );
  return result.rows.map(mapPermission);
}

// ─── People & Access (Phase 8) ─────────────────────────────────────────────────

export async function getPermissionByCode(pool: Pool, code: string): Promise<Permission | null> {
  const result = await query<RawPermissionRow>(pool, 'SELECT * FROM permissions WHERE code = $1', [
    code,
  ]);
  const row = result.rows[0];
  return row ? mapPermission(row) : null;
}

/** Every active person who can sign in to study operations. */
export async function listActiveUsers(pool: Pool): Promise<User[]> {
  const result = await query<RawUserRow>(
    pool,
    'SELECT * FROM users WHERE is_active = TRUE ORDER BY created_at',
  );
  return result.rows.map(mapUser);
}

/** Whether an email already belongs to an active person, optionally excluding
 *  one user id (the record currently being edited). */
export async function emailInUse(
  pool: Pool,
  email: string,
  excludeUserId?: string | null,
): Promise<boolean> {
  const result = await query<{ n: string }>(
    pool,
    `SELECT COUNT(*)::text AS n FROM users
      WHERE lower(email) = lower($1) AND is_active = TRUE AND ($2::uuid IS NULL OR id <> $2)`,
    [email, excludeUserId ?? null],
  );
  return parseInt(result.rows[0]?.n ?? '0', 10) > 0;
}

export async function updateUserProfile(
  pool: Pool,
  userId: string,
  data: { displayName: string; email: string; organization: string | null },
): Promise<User> {
  const result = await query<RawUserRow>(
    pool,
    `UPDATE users
        SET display_name = $2, email = $3, organization = $4, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [userId, data.displayName, data.email, data.organization],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`User ${userId} not found`);
  return mapUser(row);
}

/** Deactivate a person (they can no longer sign in) and drop their direct
 *  grants. Deactivation rather than hard delete: users are referenced by
 *  editions.locked_by and audit history. */
export async function deactivateUser(pool: Pool, userId: string): Promise<void> {
  await query(pool, 'DELETE FROM user_permissions WHERE user_id = $1', [userId]);
  await query(pool, 'UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [
    userId,
  ]);
}

export async function grantPermissionToUser(
  pool: Pool,
  userId: string,
  permissionId: string,
  grantedBy: string | null,
): Promise<void> {
  await query(
    pool,
    `INSERT INTO user_permissions (user_id, permission_id, granted_by)
     VALUES ($1,$2,$3)
     ON CONFLICT (user_id, permission_id) DO NOTHING`,
    [userId, permissionId, grantedBy],
  );
}

export async function revokePermissionFromUser(
  pool: Pool,
  userId: string,
  permissionId: string,
): Promise<void> {
  await query(pool, 'DELETE FROM user_permissions WHERE user_id = $1 AND permission_id = $2', [
    userId,
    permissionId,
  ]);
}

/** The permission codes a user holds directly (Phase 8 per-person grants only,
 *  not role-derived) — the write model this surface manages. */
export async function getDirectPermissionCodes(pool: Pool, userId: string): Promise<string[]> {
  const result = await query<{ code: string }>(
    pool,
    `SELECT p.code FROM permissions p
       JOIN user_permissions up ON up.permission_id = p.id
      WHERE up.user_id = $1`,
    [userId],
  );
  return result.rows.map((r) => r.code);
}

/**
 * The seven access rights (UX-OPS-006), mapped to canonical permission codes.
 * `setup` reuses Phase 1's real `edition:manage`; `request`/`approve` reuse
 * Phase 0's critical-action permission TYPES with a NULL action_scope (= any of
 * the six actions), so granting them actually gates the maker-checker flow. The
 * three that gate not-yet-built surfaces (send/regs/dragnet) exist now so no
 * second RBAC migration is needed when those surfaces arrive.
 */
export const ACCESS_RIGHTS = [
  { key: 'view', code: 'access:view', type: 'standard', scope: null },
  { key: 'send', code: 'access:send', type: 'standard', scope: null },
  { key: 'regs', code: 'access:regs', type: 'standard', scope: null },
  { key: 'setup', code: 'edition:manage', type: 'standard', scope: null },
  { key: 'request', code: 'critical:request', type: 'can_request_critical_action', scope: null },
  { key: 'approve', code: 'critical:approve', type: 'can_approve_critical_action', scope: null },
  { key: 'dragnet', code: 'access:dragnet', type: 'standard', scope: null },
] as const;

/** Seed the seven canonical access-right permission rows (idempotent). */
export async function seedAccessRights(pool: Pool): Promise<void> {
  for (const r of ACCESS_RIGHTS) {
    await query(
      pool,
      `INSERT INTO permissions (code, description, permission_type, action_scope)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO NOTHING`,
      [r.code, `Access right: ${r.key}`, r.type, r.scope],
    );
  }
}

/** Count active people who hold a given permission code (directly or via a
 *  role) — used for the two-approver floor. */
export async function countActiveUsersWithPermission(pool: Pool, code: string): Promise<number> {
  const result = await query<{ n: string }>(
    pool,
    `SELECT COUNT(*)::text AS n FROM (
       SELECT ur.user_id AS uid FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE p.code = $1
       UNION
       SELECT up.user_id AS uid FROM user_permissions up
         JOIN permissions p ON p.id = up.permission_id
        WHERE p.code = $1
     ) held
     JOIN users u ON u.id = held.uid
     WHERE u.is_active = TRUE`,
    [code],
  );
  return parseInt(result.rows[0]?.n ?? '0', 10);
}
