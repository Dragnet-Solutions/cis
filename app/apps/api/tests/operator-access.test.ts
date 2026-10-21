/**
 * Operator access over HTTP.
 *  - The self-grant hole is closed: a plain operator cannot give themselves
 *    (or anyone) approval rights; nobody changes their own access; an access
 *    manager can change others, only with rights they hold.
 *  - Adding a person emails a set-password link (never a password); the public
 *    set-password routes read and consume it once, refuse an expired, reused
 *    or unknown link and a weak password; the new password signs in.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, listEmailsFor } from '@cis/db';
import { hashPassword } from '@cis/auth';
import { seedReferenceData, OPERATOR_SET_PASSWORD_EMAIL_KIND } from '@cis/domain';
import { buildServer } from '../src/server';
import { redactUrl } from '../src/plugins/redact-url';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';
const NEW_PASSWORD = 'a much longer passphrase';
const ADMIN = 'adaeze.okoro@cis.example';

let app: FastifyInstance;
let makerId: string;
let checkerId: string;

let savedAuthMax: string | undefined;

beforeAll(async () => {
  // These tests sign in many times; the sign-in limit itself is tested elsewhere.
  savedAuthMax = process.env['RATE_LIMIT_AUTH_MAX'];
  process.env['RATE_LIMIT_AUTH_MAX'] = '1000';
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  const seeded = await seedReferenceData(getTestPool());
  makerId = seeded.makerUserId;
  checkerId = seeded.checkerUserId;
});

afterAll(async () => {
  if (savedAuthMax === undefined) delete process.env['RATE_LIMIT_AUTH_MAX'];
  else process.env['RATE_LIMIT_AUTH_MAX'] = savedAuthMax;
  await app.close();
  await closeTestPool();
});

async function login(email: string, password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
}
async function tokenFor(email: string): Promise<string> {
  const res = await login(email);
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const person = (email: string, rights: Record<string, boolean>, name = 'Plain Operator') => ({
  name,
  email,
  organization: 'CIS' as const,
  rights,
});

/** Adds a plain operator (see-the-study only) and gives them a known password. */
async function addPlain(adminToken: string): Promise<{ id: string; token: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/people',
    headers: auth(adminToken),
    payload: person('plain@cis.example', {}),
  });
  expect(res.statusCode).toBe(201);
  const id = res.json<{ person: { userId: string } }>().person.userId;
  await getTestPool().query('UPDATE users SET password_hash = $1 WHERE id = $2', [
    await hashPassword(PASSWORD),
    id,
  ]);
  return { id, token: await tokenFor('plain@cis.example') };
}

async function linkTokens(userId: string): Promise<string[]> {
  const emails = await listEmailsFor(getTestPool(), OPERATOR_SET_PASSWORD_EMAIL_KIND, [userId]);
  return emails.map((e) => /\/set-password\?token=([A-Za-z0-9_-]{43})/.exec(e.bodyText)![1]!);
}

describe('People & access — who may change access', () => {
  it('a plain user gets 403 granting themselves critical:approve', async () => {
    const admin = await tokenFor(ADMIN);
    const plain = await addPlain(admin);
    const res = await app.inject({
      method: 'PATCH',
      url: `/people/${plain.id}`,
      headers: auth(plain.token),
      payload: person('plain@cis.example', { approve: true }),
    });
    expect(res.statusCode).toBe(403);
    const { rows } = await getTestPool().query(
      `SELECT 1 FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
        WHERE up.user_id = $1 AND p.code = 'critical:approve'`,
      [plain.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('a plain user cannot add people, grant others or send password links', async () => {
    const admin = await tokenFor(ADMIN);
    const plain = await addPlain(admin);
    const add = await app.inject({
      method: 'POST',
      url: '/people',
      headers: auth(plain.token),
      payload: person('friend@cis.example', { approve: true }, 'Friend'),
    });
    expect(add.statusCode).toBe(403);
    const link = await app.inject({
      method: 'POST',
      url: `/people/${checkerId}/password-link`,
      headers: auth(plain.token),
    });
    expect(link.statusCode).toBe(403);
    const view = await app.inject({ method: 'GET', url: '/people', headers: auth(plain.token) });
    expect(view.statusCode).toBe(200);
    expect(view.json().viewer).toEqual({ canManage: false, grantable: [] });
  });

  it('an admin cannot edit their own rights', async () => {
    const admin = await tokenFor(ADMIN);
    const res = await app.inject({
      method: 'PATCH',
      url: `/people/${makerId}`,
      headers: auth(admin),
      payload: {
        name: 'Adaeze Okoro',
        email: ADMIN,
        organization: 'CIS',
        rights: { send: true, regs: true, setup: true, request: true, approve: true },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('You cannot change your own access');
  });

  it('an admin can grant others the rights they hold, audited', async () => {
    const admin = await tokenFor(ADMIN);
    const plain = await addPlain(admin);
    const res = await app.inject({
      method: 'PATCH',
      url: `/people/${plain.id}`,
      headers: auth(admin),
      payload: person('plain@cis.example', { approve: true, request: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().person.rights.approve).toBe(true);
    const audit = await getTestPool().query(
      `SELECT actor_id FROM audit_log
        WHERE action_type = 'access.person.rights_changed' AND entity_id = $1`,
      [plain.id],
    );
    expect(audit.rows).toEqual([{ actor_id: makerId }]);

    // …but not a right they do not hold (the maker has no Dragnet right).
    const dragnet = await app.inject({
      method: 'POST',
      url: '/people',
      headers: auth(admin),
      payload: { ...person('d@dragnet.example', { dragnet: true }, 'D'), organization: 'Dragnet' },
    });
    expect(dragnet.statusCode).toBe(403);
  });

  it('last-admin guard: the only access manager can be neither stripped nor removed', async () => {
    const pool = getTestPool();
    // Leave the maker as the only holder of the access-manager right.
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [checkerId]);
    await pool.query(
      `DELETE FROM user_permissions WHERE user_id = $1
         AND permission_id = (SELECT id FROM permissions WHERE code = 'edition:manage')`,
      [checkerId],
    );
    const checker = await tokenFor('segun.oyegbesan@dragnet.example');
    const strip = await app.inject({
      method: 'PATCH',
      url: `/people/${makerId}`,
      headers: auth(checker),
      payload: { name: 'Adaeze Okoro', email: ADMIN, organization: 'CIS', rights: {} },
    });
    expect(strip.statusCode).toBe(403);
    const remove = await app.inject({
      method: 'DELETE',
      url: `/people/${makerId}`,
      headers: auth(checker),
    });
    expect(remove.statusCode).toBe(403);
    const admin = await tokenFor(ADMIN);
    const self = await app.inject({
      method: 'PATCH',
      url: `/people/${makerId}`,
      headers: auth(admin),
      payload: { name: 'Adaeze Okoro', email: ADMIN, organization: 'CIS', rights: {} },
    });
    expect(self.statusCode).toBe(403);
    const view = await app.inject({ method: 'GET', url: '/people', headers: auth(admin) });
    expect(view.json().viewer.canManage).toBe(true);
  });
});

describe('Set-password link', () => {
  async function invite(): Promise<{ userId: string; token: string }> {
    const admin = await tokenFor(ADMIN);
    const res = await app.inject({
      method: 'POST',
      url: '/people',
      headers: auth(admin),
      payload: person('new.op@cis.example', {}, 'New Op'),
    });
    expect(res.statusCode).toBe(201);
    const userId = res.json().person.userId as string;
    expect(res.json().person.awaitingPassword).toBe(true);
    const [token] = await linkTokens(userId);
    return { userId, token: token! };
  }

  it('adding a person emails a link; it reads, sets the password once, and signs in', async () => {
    const { userId, token } = await invite();
    const emails = await listEmailsFor(getTestPool(), OPERATOR_SET_PASSWORD_EMAIL_KIND, [userId]);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.bodyText).toContain('/set-password?token=');

    const info = await app.inject({ method: 'GET', url: `/auth/password-set/${token}` });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({ email: 'new.op@cis.example', name: 'New Op', purpose: 'invite' });

    expect((await login('new.op@cis.example', NEW_PASSWORD)).statusCode).toBe(401);
    const set = await app.inject({
      method: 'POST',
      url: '/auth/password-set',
      payload: { token, password: NEW_PASSWORD },
    });
    expect(set.statusCode).toBe(200);
    expect(set.body).not.toContain(token);
    expect((await login('new.op@cis.example', NEW_PASSWORD)).statusCode).toBe(200);

    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/password-set',
      payload: { token, password: `${NEW_PASSWORD}!` },
    });
    expect(reuse.statusCode).toBe(410);
    expect(
      (await app.inject({ method: 'GET', url: `/auth/password-set/${token}` })).statusCode,
    ).toBe(410);
  });

  it('refuses an expired link (410) and an unknown one (404)', async () => {
    const { token } = await invite();
    await getTestPool().query(
      `UPDATE password_set_tokens SET expires_at = NOW() - INTERVAL '1 second'`,
    );
    const expired = await app.inject({
      method: 'POST',
      url: '/auth/password-set',
      payload: { token, password: NEW_PASSWORD },
    });
    expect(expired.statusCode).toBe(410);
    const unknown = await app.inject({
      method: 'GET',
      url: `/auth/password-set/${'B'.repeat(43)}`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses a password that breaks the policy (400)', async () => {
    const { token } = await invite();
    for (const password of ['too short', 'new.op@cis.example']) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/password-set',
        payload: { token, password },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('an admin can send a new invitation link, which replaces the old one', async () => {
    const { userId, token } = await invite();
    const admin = await tokenFor(ADMIN);
    const res = await app.inject({
      method: 'POST',
      url: `/people/${userId}/password-link`,
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().purpose).toBe('invite');
    expect(res.body).not.toMatch(/token/i);
    expect(
      (await app.inject({ method: 'GET', url: `/auth/password-set/${token}` })).statusCode,
    ).toBe(410);
    const [, fresh] = await linkTokens(userId);
    expect(
      (await app.inject({ method: 'GET', url: `/auth/password-set/${fresh}` })).statusCode,
    ).toBe(200);
  });
});

describe('Set-password tokens stay out of request logs', () => {
  it('redacts the token from the path and from a token= query', () => {
    expect(redactUrl(`/auth/password-set/${'C'.repeat(43)}`)).toBe('/auth/password-set/[REDACTED]');
    expect(redactUrl('/set-password?token=abc&x=1')).toBe('/set-password?token=[REDACTED]&x=1');
    expect(redactUrl('/people')).toBe('/people');
  });
});
