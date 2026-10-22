import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  getUserById,
  getUserByEmail,
  countRecentSelfServiceResets,
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
import { queueTemplate } from './email-content';
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
  opts: {
    purpose: PasswordSetPurpose;
    createdBy: string | null;
    portalUrl?: string | null;
    /** The person's rights as People & access names them, for the invitation (O-01). */
    rights?: string[];
  },
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
  const linkExpiry = invite ? '72 hours' : '24 hours';
  let email;
  if (invite) {
    const adder = opts.createdBy ? await getUserById(db as Pool, opts.createdBy) : null;
    const rights = opts.rights?.length ? opts.rights : ['See the study'];
    email = await queueTemplate(db, {
      kind: OPERATOR_SET_PASSWORD_EMAIL_KIND,
      refId: user.id,
      to: user.email,
      toName: user.displayName,
      template: 'O-01',
      fields: {
        person_name: user.displayName,
        person_email: user.email,
        added_by: adder?.displayName ?? 'The study team',
        rights: rights.join(', '),
        set_password_url: link,
        link_expiry: linkExpiry,
      },
    });
  } else {
    email = await queueTemplate(db, {
      kind: OPERATOR_SET_PASSWORD_EMAIL_KIND,
      refId: user.id,
      to: user.email,
      toName: user.displayName,
      template: 'O-02',
      fields: { person_email: user.email, reset_url: link, link_expiry: linkExpiry },
    });
  }

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

/** At most this many "Forgot password?" emails per account per hour. */
export const SELF_SERVICE_RESETS_PER_HOUR = 3;

/**
 * "Forgot password?" on the sign-in page. Always answers the same way, so it
 * never reveals whether an account exists: when the address belongs to an
 * active person, a reset link (24 hours, single use) is emailed (O-02) —
 * unless they were already sent SELF_SERVICE_RESETS_PER_HOUR in the last
 * hour; otherwise nothing happens. The request is audited either way, without
 * the address of an unknown account.
 */
export async function requestPasswordReset(
  pool: Pool,
  input: {
    email: string;
    portalUrl?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<{ queued: boolean }> {
  const email = input.email.trim();
  const user =
    (await getUserByEmail(pool, email)) ?? (await getUserByEmail(pool, email.toLowerCase()));
  if (!user) {
    await writeAudit(pool, {
      actorId: null,
      actionType: 'access.password.reset_requested',
      entityType: 'user',
      entityId: null,
      newValue: { matched: false },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { queued: false };
  }
  const recent = await countRecentSelfServiceResets(pool, user.id, 3_600_000);
  const queued = recent < SELF_SERVICE_RESETS_PER_HOUR;
  await withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    await writeAudit(c, {
      actorId: null,
      actionType: 'access.password.reset_requested',
      entityType: 'user',
      entityId: user.id,
      newValue: { matched: true, queued },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
    if (queued) {
      await issuePasswordSetLink(c, user.id, {
        purpose: 'reset',
        createdBy: null,
        portalUrl: input.portalUrl ?? null,
      });
    }
  });
  return { queued };
}
