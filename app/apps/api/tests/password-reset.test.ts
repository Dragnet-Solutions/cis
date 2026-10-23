/**
 * "Forgot password?" over HTTP: the same neutral answer whether or not the
 * address has an account; when it has, a reset link (O-02) is emailed, and it
 * sets a new password once. Capped per account.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getUserById } from '@cis/db';
import {
  seedReferenceData,
  OPERATOR_SET_PASSWORD_EMAIL_KIND,
  SELF_SERVICE_RESETS_PER_HOUR,
} from '@cis/domain';
import { buildServer } from '../src/server';
import { settlePasswordResets } from '../src/routes/password-set';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

let app: FastifyInstance;
let makerEmail: string;
let makerId: string;
let saved: string | undefined;

beforeAll(async () => {
  saved = process.env['RATE_LIMIT_RESET_MAX'];
  process.env['RATE_LIMIT_RESET_MAX'] = '1000';
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  const seeded = await seedReferenceData(getTestPool());
  makerId = seeded.makerUserId;
  makerEmail = (await getUserById(getTestPool(), makerId))!.email;
});

afterAll(async () => {
  if (saved === undefined) delete process.env['RATE_LIMIT_RESET_MAX'];
  else process.env['RATE_LIMIT_RESET_MAX'] = saved;
  await app.close();
  await closeTestPool();
});

/** Asks, then waits for the work done after the response. */
async function ask(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/password-reset/request',
    payload: { email },
  });
  await settlePasswordResets();
  return res;
}

async function resetEmails() {
  const { rows } = await getTestPool().query<{
    to_address: string;
    subject: string;
    body_text: string;
    body_html: string;
  }>(
    'SELECT to_address, subject, body_text, body_html FROM email_outbox WHERE kind = $1 ORDER BY created_at',
    [OPERATOR_SET_PASSWORD_EMAIL_KIND],
  );
  return rows;
}

describe('POST /auth/password-reset/request', () => {
  it('answers the same for an account and for a stranger; only the account is emailed', async () => {
    const known = await ask(makerEmail);
    const unknown = await ask('nobody@nowhere.example');
    const malformed = await ask('not-an-address');
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(malformed.statusCode).toBe(200);
    expect(unknown.json()).toEqual(known.json());
    expect(malformed.json()).toEqual(known.json());
    expect(known.json().message).toMatch(/If that address has an account/);

    const emails = await resetEmails();
    expect(emails).toHaveLength(1);
    const [email] = emails;
    expect(email!.to_address).toBe(makerEmail);
    expect(email!.subject).toBe('Reset your Study Operations password');
    expect(email!.body_text).toContain(`password for ${makerEmail}`);
    expect(email!.body_text).toContain('expires in 24 hours');
    expect(email!.body_html).toContain('/cis-logo.png');

    // The link sets a new password, once.
    const token = /set-password\?token=([A-Za-z0-9_-]{43})/.exec(email!.body_text)![1]!;
    const set = await app.inject({
      method: 'POST',
      url: '/auth/password-set',
      payload: { token, password: 'a brand new long passphrase' },
    });
    expect(set.statusCode).toBe(200);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: makerEmail, password: 'a brand new long passphrase' },
    });
    expect(login.statusCode).toBe(200);
    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/password-set',
      payload: { token, password: 'another long passphrase!' },
    });
    expect(reuse.statusCode).toBe(410);
  });

  it(`emails one account at most ${SELF_SERVICE_RESETS_PER_HOUR} times an hour, answering the same`, async () => {
    const first = await ask(makerEmail);
    for (let i = 1; i < SELF_SERVICE_RESETS_PER_HOUR + 2; i++) {
      const res = await ask(makerEmail);
      expect(res.json()).toEqual(first.json());
    }
    expect(await resetEmails()).toHaveLength(SELF_SERVICE_RESETS_PER_HOUR);
  });

  it('answers before doing any work, so an account and a stranger take the same time', async () => {
    const timed = async (email: string) => {
      const t0 = performance.now();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/password-reset/request',
        payload: { email },
      });
      const ms = performance.now() - t0;
      expect(res.statusCode).toBe(200);
      return ms;
    };
    // Warm up, then compare several of each (loosely: no lookup, hashing or
    // email is on either path, so neither is slower by more than noise).
    await timed('warm@nowhere.example');
    await settlePasswordResets();
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      unknown.push(await timed(`stranger${i}@nowhere.example`));
      known.push(await timed(makerEmail));
      await settlePasswordResets();
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[1]!;
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(50);
    // The account was still emailed (capped at the hourly limit).
    expect((await resetEmails()).length).toBeGreaterThan(0);
  });

  it('is audited without naming an address that has no account', async () => {
    await ask('nobody@nowhere.example');
    const { rows } = await getTestPool().query<{ entity_id: string | null; new_value: unknown }>(
      "SELECT entity_id, new_value FROM audit_log WHERE action_type = 'access.password.reset_requested'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBeNull();
    expect(JSON.stringify(rows[0]!.new_value)).not.toContain('nobody@');
  });
});
