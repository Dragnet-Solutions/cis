/**
 * Mail health for operators over HTTP: GET /mail/status names the mail
 * service (or says none is configured — notices only recorded), never a
 * secret, and summarises the outbox with masked failure addresses; POST
 * /mail/test needs the "write to people" right and reports what happened to
 * the test email.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getPool, queueEmail, markEmailFailed } from '@cis/db';
import { hashPassword } from '@cis/auth';
import { seedReferenceData, addPerson } from '@cis/domain';
import { buildServer } from '../src/server';
import {
  deliverQueuedEmails,
  setMailTransportForTests,
  resetMailTransportForTests,
} from '../src/mail/mailer';
import { MailSendError, type MailMessage, type MailTransport } from '../src/mail/transport';
import { maskAddress } from '../src/routes/mail';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';
const ENV_KEYS = [
  'ZEPTOMAIL_API_TOKEN',
  'ZEPTOMAIL_API_URL',
  'ZEPTOMAIL_WEBHOOK_SECRET',
  'SMTP_URL',
  'MAIL_FROM',
];
const FAKE_TOKEN = 'fake-token-for-tests-only';

let app: FastifyInstance;
let makerId: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  makerId = (await seedReferenceData(getTestPool())).makerUserId;
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetMailTransportForTests();
});

afterAll(async () => {
  await app.close();
  await closeTestPool();
});

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function fakeTransport(behave: (m: MailMessage) => { messageId?: string } | Error): MailTransport {
  return {
    name: 'fake',
    async send(m) {
      const r = behave(m);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('GET /mail/status', () => {
  it('says plainly when no mail service is configured', async () => {
    const token = await login('adaeze.okoro@cis.example');
    const res = await app.inject({ method: 'GET', url: '/mail/status', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transport).toBe('none');
    expect(body.apiHost).toBeNull();
    expect(body.webhookConfigured).toBe(false);
    expect(body.dispatcherRunning).toBe(false);
  });

  it('names ZeptoMail, its host and the sender, never the token; masks failures', async () => {
    process.env['ZEPTOMAIL_API_TOKEN'] = FAKE_TOKEN;
    process.env['ZEPTOMAIL_API_URL'] = 'https://api.zeptomail.eu/v1.1/email';
    process.env['ZEPTOMAIL_WEBHOOK_SECRET'] = 'fake-webhook-secret';
    process.env['MAIL_FROM'] = 'CIS Study <study@cis.example>';
    const pool = getPool();
    const failed = await queueEmail(pool, {
      kind: 'firm-invitation',
      refId: null,
      toAddress: 'traore@outlook.com',
      subject: 's',
      bodyText: 'b',
    });
    await markEmailFailed(pool, failed.id, 'Mailbox does not exist');
    await queueEmail(pool, {
      kind: 'x',
      refId: null,
      toAddress: 'q@x.example',
      subject: 's',
      bodyText: 'b',
    });

    const token = await login('adaeze.okoro@cis.example');
    const res = await app.inject({ method: 'GET', url: '/mail/status', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(FAKE_TOKEN);
    expect(res.body).not.toContain('fake-webhook-secret');
    const body = res.json();
    expect(body).toMatchObject({
      transport: 'zeptomail',
      from: 'study@cis.example',
      apiHost: 'api.zeptomail.eu',
      webhookConfigured: true,
      outbox: { queued: 1, sent: 0, logged: 0, failed: 1 },
    });
    expect(body.oldestQueuedAt).not.toBeNull();
    expect(body.recentFailures).toEqual([
      {
        kind: 'firm-invitation',
        to: 'tr***@outlook.com',
        error: 'Mailbox does not exist',
        at: expect.any(String),
      },
    ]);
  });

  it('says why each "recorded, not sent" email was held back (exception #7)', async () => {
    // A governance notice to a demo operator at a reserved test domain, and a
    // real recipient: the first is held back by design, the second is sent.
    const pool = getPool();
    for (const to of ['segun.oyegbesan@dragnet.example', 'md@realfirm.com']) {
      await queueEmail(pool, {
        kind: 'signoff-requested',
        refId: null,
        toAddress: to,
        subject: 's',
        bodyText: 'b',
      });
    }
    const quiet = { info: () => {}, warn: () => {} };
    await deliverQueuedEmails(pool, quiet, {
      transport: fakeTransport(() => ({ messageId: 'm-1' })),
    });
    // One more with no mail service configured at all.
    await queueEmail(pool, {
      kind: 'x',
      refId: null,
      toAddress: 'q@realfirm.com',
      subject: 's',
      bodyText: 'b',
    });
    await deliverQueuedEmails(pool, quiet, { transport: null });

    const token = await login('adaeze.okoro@cis.example');
    const body = (
      await app.inject({ method: 'GET', url: '/mail/status', headers: auth(token) })
    ).json();
    expect(body.outbox).toMatchObject({ sent: 1, logged: 2 });
    expect(body.loggedByReason).toEqual({ testAddress: 1, noMailService: 1 });
    const reasons = body.recentHeld.map((h: { to: string; reason: string }) => [h.to, h.reason]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        ['se***@dragnet.example', expect.stringMatching(/^Test address/)],
        ['q***@realfirm.com', expect.stringMatching(/^No mail service/)],
      ]),
    );
  });

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/mail/status' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /mail/test', () => {
  it('sends through the mail service and reports the provider message id', async () => {
    let sentTo = '';
    setMailTransportForTests(
      fakeTransport((m) => {
        sentTo = m.to;
        return { messageId: 'zm-123' };
      }),
    );
    const token = await login('adaeze.okoro@cis.example');
    const res = await app.inject({
      method: 'POST',
      url: '/mail/test',
      headers: auth(token),
      payload: { to: 'ops@cis-mailtest.ng' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'sent',
      provider: 'fake',
      providerMessageId: 'zm-123',
      error: null,
    });
    expect(sentTo).toBe('ops@cis-mailtest.ng');
  });

  it('reports "logged" (recorded, not sent) when there is no mail service', async () => {
    setMailTransportForTests(null);
    const token = await login('adaeze.okoro@cis.example');
    const res = await app.inject({
      method: 'POST',
      url: '/mail/test',
      headers: auth(token),
      payload: { to: 'ops@cis-mailtest.ng' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'logged', providerMessageId: null });
  });

  it('reports a refusal with its reason', async () => {
    setMailTransportForTests(
      fakeTransport(() => new MailSendError('Sender not verified', { permanent: true })),
    );
    const token = await login('adaeze.okoro@cis.example');
    const res = await app.inject({
      method: 'POST',
      url: '/mail/test',
      headers: auth(token),
      payload: { to: 'ops@cis-mailtest.ng' },
    });
    expect(res.json()).toMatchObject({ status: 'failed', error: 'Sender not verified' });
  });

  it('needs the "write to people" right', async () => {
    const pool = getTestPool();
    const plain = await addPerson(pool, {
      name: 'Plain',
      email: 'plain@cis.example',
      organization: 'CIS',
      rights: {},
      actorId: makerId,
    });
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await hashPassword(PASSWORD),
      plain.userId,
    ]);
    const token = await login('plain@cis.example');
    const res = await app.inject({
      method: 'POST',
      url: '/mail/test',
      headers: auth(token),
      payload: { to: 'ops@cis-mailtest.ng' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a malformed address', async () => {
    const token = await login('adaeze.okoro@cis.example');
    const res = await app.inject({
      method: 'POST',
      url: '/mail/test',
      headers: auth(token),
      payload: { to: 'not-an-address' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('maskAddress', () => {
  it('keeps enough to recognise, not to harvest', () => {
    expect(maskAddress('traore@outlook.com')).toBe('tr***@outlook.com');
    expect(maskAddress('ab@x.example')).toBe('a***@x.example');
    expect(maskAddress('nonsense')).toBe('***');
  });
});
