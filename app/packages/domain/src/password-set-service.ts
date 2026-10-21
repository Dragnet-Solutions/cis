import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  getUserById,
  getPasswordSetTokenByHash,
  insertPasswordSetToken,
  markPasswordSetTokenUsed,
  revokeOpenPasswordSetTokens,
  setUserPasswordHash,
  withTransaction,
  type PasswordSetPurpose,
  type PasswordSetToken,
} from '@cis/db';
import { hashPassword } from '@cis/auth';
import { writeAudit } from '@cis/audit';
import { DomainError } from './errors';
import { queueNotice } from './email-content';
import { siteOrigin } from './notice-links';
import { checkPasswordPolicy } from './password-policy';

/**
 * Operator password-set links. Nobody is ever emailed a password: an operator
 * added on People & access (or one who needs a reset) is emailed a single-use
 * link `/set-password?token=…` and chooses their own.
 *
 * The token is 32 random bytes (base64url). Only its SHA-256 is stored, so a
 * database read cannot be turned into a working link; the raw token exists
 * only in the queued email and is never returned or logged. One usable link
 * per person — issuing a new one revokes the older ones.
 */

/** Outbox kind of the set-password email; ref_id is the user. */
export const OPERATOR_SET_PASSWORD_EMAIL_KIND = 'operator-set-password';

export const INVITE_LINK_TTL_MS = 72 * 60 * 60 * 1000;
export const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export class PasswordSetError extends DomainError {
  constructor(
    message: string,
    code: 'NOT_FOUND' | 'GONE' | 'POLICY' | 'USER_NOT_FOUND',
    public readonly httpStatus: number,
  ) {
    super(message, code);
  }
}

type Db = Pool | PoolClient;

export const hashPasswordSetToken = (raw: string): string =>
  createHash('sha256').update(raw, 'utf8').digest('hex');

/** A token can only be base64url of 32 bytes; anything else is not ours. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Issue a set-password link for a user and queue the email carrying it.
 * Accepts a pool or a transaction client (addPerson issues it atomically with
 * the account). Returns when it expires — never the token.
 */
export async function issuePasswordSetLink(
  db: Db,
  userId: string,
  opts: { purpose: PasswordSetPurpose; createdBy: string | null; portalUrl?: string | null },
): Promise<{ expiresAt: Date; emailId: string }> {
  const user = await getUserById(db as Pool, userId);
  if (!user || !user.isActive) {
    throw new PasswordSetError('Person not found', 'USER_NOT_FOUND', 404);
  }
  const raw = randomBytes(32).toString('base64url');
  const ttl = opts.purpose === 'invite' ? INVITE_LINK_TTL_MS : RESET_LINK_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  await revokeOpenPasswordSetTokens(db, userId);
  await insertPasswordSetToken(db, {
    userId,
    tokenHash: hashPasswordSetToken(raw),
    purpose: opts.purpose,
    expiresAt,
    createdBy: opts.createdBy,
  });

  const link = `${siteOrigin(opts.portalUrl)}/set-password?token=${raw}`;
  const invite = opts.purpose === 'invite';
  const email = await queueNotice(db, {
    kind: OPERATOR_SET_PASSWORD_EMAIL_KIND,
    refId: user.id,
    to: user.email,
    toName: user.displayName,
    subject: invite
      ? 'You have been given access to the CIS × Dragnet study operations site'
      : 'Set a new password for the CIS × Dragnet study operations site',
    heading: invite ? 'You have been given access' : 'Set a new password',
    paragraphs: invite
      ? [
          `Dear ${user.displayName},`,
          'You have been given access to the CIS × Dragnet benchmark study operations site.',
          'To start, choose your own password with the link below. The link works once and ' +
            'expires in 72 hours. You will then sign in with this email address.',
        ]
      : [
          `Dear ${user.displayName},`,
          'A new password was requested for your study operations account.',
          'Choose it with the link below. The link works once and expires in 24 hours. ' +
            'Until you use it, your current password keeps working.',
        ],
    action: { label: invite ? 'Choose your password' : 'Set a new password', url: link },
    footer: invite
      ? 'If you were not expecting this, you can ignore this email.'
      : 'If you did not expect this, you can ignore this email — nothing changes until the link is used.',
  });

  await writeAudit(db as Pool, {
    actorId: opts.createdBy,
    actionType: 'access.password.link_issued',
    entityType: 'user',
    entityId: user.id,
    newValue: { purpose: opts.purpose, expiresAt: expiresAt.toISOString() },
  });

  return { expiresAt, emailId: email.id };
}

async function usableToken(
  db: Db,
  rawToken: string,
  forUpdate: boolean,
): Promise<{
  token: PasswordSetToken;
  user: NonNullable<Awaited<ReturnType<typeof getUserById>>>;
}> {
  if (!TOKEN_RE.test(rawToken)) {
    throw new PasswordSetError('This link is not valid.', 'NOT_FOUND', 404);
  }
  const token = await getPasswordSetTokenByHash(db, hashPasswordSetToken(rawToken), { forUpdate });
  if (!token) throw new PasswordSetError('This link is not valid.', 'NOT_FOUND', 404);
  if (token.usedAt) {
    throw new PasswordSetError(
      'This link has already been used. Sign in with your password, or ask for a new link.',
      'GONE',
      410,
    );
  }
  if (token.revokedAt) {
    throw new PasswordSetError(
      'This link has been replaced by a newer one. Use the latest email you received.',
      'GONE',
      410,
    );
  }
  if (token.expiresAt.getTime() <= Date.now()) {
    throw new PasswordSetError(
      'This link has expired. Ask an administrator to send you a new one.',
      'GONE',
      410,
    );
  }
  const user = await getUserById(db as Pool, token.userId);
  if (!user || !user.isActive) {
    throw new PasswordSetError('This account no longer has access.', 'GONE', 410);
  }
  return { token, user };
}

/** Who a link is for, so the page can greet them. Throws 404/410 errors. */
export async function getPasswordSetLinkInfo(
  pool: Pool,
  rawToken: string,
): Promise<{ email: string; name: string; purpose: PasswordSetPurpose }> {
  const { token, user } = await usableToken(pool, rawToken, false);
  return { email: user.email, name: user.displayName, purpose: token.purpose };
}

/**
 * Set the password with a link: single use (the token row is locked, checked
 * and marked used in one transaction), policy-checked, argon2-hashed, audited.
 * Every other open link for the person is revoked.
 */
export async function consumePasswordSetLink(
  pool: Pool,
  input: { token: string; password: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<{ email: string }> {
  return withTransaction(pool, async (client) => {
    const c = client as unknown as PoolClient;
    const { token, user } = await usableToken(c, input.token, true);
    const problem = checkPasswordPolicy(input.password, user.email);
    if (problem) throw new PasswordSetError(problem.message, 'POLICY', 400);

    await setUserPasswordHash(c, user.id, await hashPassword(input.password));
    await markPasswordSetTokenUsed(c, token.id);
    await revokeOpenPasswordSetTokens(c, user.id);
    await writeAudit(c as unknown as Pool, {
      actorId: user.id,
      actionType: 'access.password.set',
      entityType: 'user',
      entityId: user.id,
      newValue: { purpose: token.purpose, via: 'link' },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { email: user.email };
  });
}
