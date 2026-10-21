/**
 * Operator set-password links: issued on addPerson and on request, single use,
 * expiring, superseded by a newer link, policy-checked, audited; only the
 * token's hash is stored and no password is ever emailed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { getUserByEmail, listEmailsFor } from '@cis/db';
import { verifyPassword } from '@cis/auth';
import {
  seedReferenceData,
  addPerson,
  sendPasswordLink,
  listPeople,
  getPasswordSetLinkInfo,
  consumePasswordSetLink,
  hashPasswordSetToken,
  checkPasswordPolicy,
  OPERATOR_SET_PASSWORD_EMAIL_KIND,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

const PORTAL = 'https://cis.example';
const GOOD = 'correct horse battery staple';
let pool: Pool;
let makerId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  makerId = (await seedReferenceData(pool)).makerUserId;
});
afterAll(async () => {
  await closeTestPool();
});

async function linksFor(userId: string): Promise<string[]> {
  const emails = await listEmailsFor(pool, OPERATOR_SET_PASSWORD_EMAIL_KIND, [userId]);
  return emails.map((e) => {
    const m = /\/set-password\?token=([A-Za-z0-9_-]{43})/.exec(e.bodyText);
    if (!m) throw new Error('no link in email');
    return m[1]!;
  });
}

async function newPerson() {
  return addPerson(
    pool,
    {
      name: 'New Op',
      email: 'new.op@cis.example',
      organization: 'CIS',
      rights: {},
      actorId: makerId,
    },
    { portalUrl: PORTAL },
  );
}

describe('Set-password links', () => {
  it('addPerson emails an invitation link; only the hash is stored', async () => {
    const p = await newPerson();
    const [token] = await linksFor(p.userId);
    const emails = await listEmailsFor(pool, OPERATOR_SET_PASSWORD_EMAIL_KIND, [p.userId]);
    expect(emails[0]!.bodyText).toContain(`${PORTAL}/set-password?token=`);
    const { rows } = await pool.query('SELECT token_hash, purpose FROM password_set_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashPasswordSetToken(token!));
    expect(rows[0].token_hash).not.toContain(token!);
    expect(rows[0].purpose).toBe('invite');
    const listed = (await listPeople(pool)).find((x) => x.userId === p.userId);
    expect(listed!.awaitingPassword).toBe(true);
    expect(await getPasswordSetLinkInfo(pool, token!)).toEqual({
      email: 'new.op@cis.example',
      name: 'New Op',
      purpose: 'invite',
    });
  });

  it('sets the password once; the link cannot be reused; audited', async () => {
    const p = await newPerson();
    const [token] = await linksFor(p.userId);
    await consumePasswordSetLink(pool, { token: token!, password: GOOD });
    const user = await getUserByEmail(pool, 'new.op@cis.example');
    expect(await verifyPassword(GOOD, user!.passwordHash)).toBe(true);
    await expect(
      consumePasswordSetLink(pool, { token: token!, password: `${GOOD}!` }),
    ).rejects.toMatchObject({ code: 'GONE', httpStatus: 410 });
    const audit = await pool.query(
      `SELECT 1 FROM audit_log WHERE action_type = 'access.password.set' AND entity_id = $1`,
      [p.userId],
    );
    expect(audit.rowCount).toBe(1);
    const listed = (await listPeople(pool)).find((x) => x.userId === p.userId);
    expect(listed!.awaitingPassword).toBe(false);
  });

  it('refuses an expired link', async () => {
    const p = await newPerson();
    const [token] = await linksFor(p.userId);
    await pool.query(`UPDATE password_set_tokens SET expires_at = NOW() - INTERVAL '1 minute'`);
    await expect(getPasswordSetLinkInfo(pool, token!)).rejects.toMatchObject({ httpStatus: 410 });
    await expect(
      consumePasswordSetLink(pool, { token: token!, password: GOOD }),
    ).rejects.toMatchObject({ httpStatus: 410 });
  });

  it('refuses an unknown or malformed token', async () => {
    await expect(getPasswordSetLinkInfo(pool, 'nope')).rejects.toMatchObject({ httpStatus: 404 });
    await expect(getPasswordSetLinkInfo(pool, 'A'.repeat(43))).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it('refuses a password that breaks the policy and leaves the link usable', async () => {
    const p = await newPerson();
    const [token] = await linksFor(p.userId);
    for (const bad of ['short', 'new.op@cis.example', 'aaaaaaaaaaaaaaaa']) {
      await expect(
        consumePasswordSetLink(pool, { token: token!, password: bad }),
      ).rejects.toMatchObject({ code: 'POLICY', httpStatus: 400 });
    }
    await consumePasswordSetLink(pool, { token: token!, password: GOOD });
  });

  it('a new link supersedes the older one; a reset link once a password exists', async () => {
    const p = await newPerson();
    const [first] = await linksFor(p.userId);
    const again = await sendPasswordLink(
      pool,
      { userId: p.userId, actorId: makerId },
      { portalUrl: PORTAL },
    );
    expect(again.purpose).toBe('invite');
    const [, second] = await linksFor(p.userId);
    await expect(getPasswordSetLinkInfo(pool, first!)).rejects.toMatchObject({ httpStatus: 410 });
    await consumePasswordSetLink(pool, { token: second!, password: GOOD });

    const reset = await sendPasswordLink(
      pool,
      { userId: p.userId, actorId: makerId },
      { portalUrl: PORTAL },
    );
    expect(reset.purpose).toBe('reset');
  });
});

describe('checkPasswordPolicy (pure)', () => {
  it('accepts a long passphrase and names each problem', () => {
    expect(checkPasswordPolicy(GOOD, 'a@b.example')).toBeNull();
    expect(checkPasswordPolicy('elevenchars', 'a@b.example')?.problem).toBe('too_short');
    expect(checkPasswordPolicy('x'.repeat(201) + 'y', 'a@b.example')?.problem).toBe('too_long');
    expect(checkPasswordPolicy('Someone@Example.org', 'someone@example.org')?.problem).toBe(
      'is_email',
    );
    expect(checkPasswordPolicy('longlocalpart', 'longlocalpart@example.org')?.problem).toBe(
      'is_email',
    );
    expect(checkPasswordPolicy('zzzzzzzzzzzzzz', 'a@b.example')?.problem).toBe('one_character');
  });
});
