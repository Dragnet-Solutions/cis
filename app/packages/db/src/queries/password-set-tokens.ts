import { Pool, PoolClient } from 'pg';
import { query } from '../client';

/**
 * Single-use links that let an operator choose their own password. Only the
 * SHA-256 of the token is stored (`token_hash`); the raw token is only ever in
 * the email. A token is usable while `used_at` and `revoked_at` are null and
 * `expires_at` is in the future. `used_at` means a password was set with it;
 * `revoked_at` means a newer link replaced it.
 */
export type PasswordSetPurpose = 'invite' | 'reset';

type Db = Pool | PoolClient;
const asPool = (db: Db): Pool => db as Pool;

export interface PasswordSetToken {
  id: string;
  userId: string;
  purpose: PasswordSetPurpose;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

interface RawTokenRow {
  id: string;
  user_id: string;
  purpose: PasswordSetPurpose;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

const mapToken = (r: RawTokenRow): PasswordSetToken => ({
  id: r.id,
  userId: r.user_id,
  purpose: r.purpose,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
  revokedAt: r.revoked_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** Revokes every open link for a user, so only the newest one works. */
export async function revokeOpenPasswordSetTokens(db: Db, userId: string): Promise<number> {
  const res = await query(
    asPool(db),
    `UPDATE password_set_tokens SET revoked_at = NOW()
      WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
    [userId],
  );
  return res.rowCount ?? 0;
}

export async function insertPasswordSetToken(
  db: Db,
  data: {
    userId: string;
    tokenHash: string;
    purpose: PasswordSetPurpose;
    expiresAt: Date;
    createdBy: string | null;
  },
): Promise<PasswordSetToken> {
  const res = await query<RawTokenRow>(
    asPool(db),
    `INSERT INTO password_set_tokens (user_id, token_hash, purpose, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, purpose, expires_at, used_at, revoked_at, created_by, created_at`,
    [data.userId, data.tokenHash, data.purpose, data.expiresAt, data.createdBy],
  );
  const row = res.rows[0];
  if (!row) throw new Error('password_set_tokens insert returned no rows');
  return mapToken(row);
}

/** The link with this hash, whatever its state. `forUpdate` locks the row. */
export async function getPasswordSetTokenByHash(
  db: Db,
  tokenHash: string,
  opts: { forUpdate?: boolean } = {},
): Promise<PasswordSetToken | null> {
  const res = await query<RawTokenRow>(
    asPool(db),
    `SELECT id, user_id, purpose, expires_at, used_at, revoked_at, created_by, created_at
       FROM password_set_tokens WHERE token_hash = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`,
    [tokenHash],
  );
  const row = res.rows[0];
  return row ? mapToken(row) : null;
}

export async function markPasswordSetTokenUsed(db: Db, id: string): Promise<void> {
  await query(asPool(db), 'UPDATE password_set_tokens SET used_at = NOW() WHERE id = $1', [id]);
}

/** Users (of `userIds`) who have ever completed a password-set link. */
export async function usersWhoSetPasswordByLink(db: Db, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const res = await query<{ user_id: string }>(
    asPool(db),
    `SELECT DISTINCT user_id FROM password_set_tokens
      WHERE user_id = ANY($1::uuid[]) AND used_at IS NOT NULL`,
    [userIds],
  );
  return new Set(res.rows.map((r) => r.user_id));
}

export async function setUserPasswordHash(db: Db, userId: string, passwordHash: string) {
  await query(asPool(db), 'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
    passwordHash,
    userId,
  ]);
}
