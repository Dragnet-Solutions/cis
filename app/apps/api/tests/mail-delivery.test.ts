/**
 * Delivering the email outbox: what is sent, recorded (no mail service),
 * failed or retried with back-off, the attempts cap, and that concurrent
 * claims (several API pods) never hand out the same notice twice.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { claimDueEmails, queueEmail } from '@cis/db';
import { deliverDueEmails, deliverQueuedEmails, backoffMs } from '../src/mail/mailer';
import { MailSendError, type MailMessage, type MailTransport } from '../src/mail/transport';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

let pool: Pool;
const log = { info: () => {}, warn: () => {} };

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

function fakeTransport(
  behave: (m: MailMessage) => { messageId?: string } | Error,
): MailTransport & {
  sent: MailMessage[];
} {
  const sent: MailMessage[] = [];
  return {
    name: 'fake',
    sent,
    async send(m) {
      sent.push(m);
      const r = behave(m);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

const queue = (to: string, extra: { toName?: string; bodyHtml?: string } = {}) =>
  queueEmail(pool, {
    kind: 'test',
    refId: null,
    toAddress: to,
    subject: `Hi ${to}`,
    bodyText: 'text body',
    ...extra,
  });

async function row(id: string) {
  const { rows } = await pool.query(
    `SELECT status, error, attempts, provider, provider_message_id,
            EXTRACT(EPOCH FROM (next_attempt_at - NOW())) AS due_in_s
       FROM email_outbox WHERE id = $1`,
    [id],
  );
  return rows[0] as {
    status: string;
    error: string | null;
    attempts: number;
    provider: string | null;
    provider_message_id: string | null;
    due_in_s: string;
  };
}

describe('deliverDueEmails', () => {
  it('sends through the transport and records the provider and message id', async () => {
    const e = await queue('a@x.example', { toName: 'Ada', bodyHtml: '<p>hi</p>' });
    const t = fakeTransport(() => ({ messageId: 'msg-1' }));
    const s = await deliverDueEmails(pool, log, { transport: t });
    expect(s).toEqual({ sent: 1, logged: 0, failed: 0, retried: 0 });
    expect(t.sent[0]).toEqual({
      to: 'a@x.example',
      toName: 'Ada',
      subject: 'Hi a@x.example',
      text: 'text body',
      html: '<p>hi</p>',
      reference: e.id,
    });
    const r = await row(e.id);
    expect(r).toMatchObject({
      status: 'sent',
      attempts: 1,
      provider: 'fake',
      provider_message_id: 'msg-1',
    });
    // Nothing left to do.
    expect(await deliverDueEmails(pool, log, { transport: t })).toEqual({
      sent: 0,
      logged: 0,
      failed: 0,
      retried: 0,
    });
  });

  it('with no mail service, records the notice as logged', async () => {
    const e = await queue('b@x.example');
    const s = await deliverDueEmails(pool, log, { transport: null });
    expect(s).toEqual({ sent: 0, logged: 1, failed: 0, retried: 0 });
    expect((await row(e.id)).status).toBe('logged');
  });

  it('a permanent refusal fails the notice with the reason', async () => {
    const e = await queue('c@x.example');
    const t = fakeTransport(
      () => new MailSendError('ZeptoMail 400: bad address', { permanent: true }),
    );
    const s = await deliverDueEmails(pool, log, { transport: t });
    expect(s.failed).toBe(1);
    expect(await row(e.id)).toMatchObject({
      status: 'failed',
      error: 'ZeptoMail 400: bad address',
    });
  });

  it('a transient refusal stays queued, backs off, and fails after the fifth attempt', async () => {
    const e = await queue('d@x.example');
    const t = fakeTransport(() => new MailSendError('ZeptoMail 503', { permanent: false }));

    const delays = [60, 300, 900, 3600];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const s = await deliverDueEmails(pool, log, { transport: t });
      expect(s.retried).toBe(1);
      const r = await row(e.id);
      expect(r.status).toBe('queued');
      expect(r.attempts).toBe(attempt);
      expect(r.error).toBe('ZeptoMail 503');
      expect(Number(r.due_in_s)).toBeGreaterThan(delays[attempt - 1]! - 5);
      expect(Number(r.due_in_s)).toBeLessThanOrEqual(delays[attempt - 1]! + 1);
      // Not due yet: a second pass leaves it alone.
      expect((await deliverDueEmails(pool, log, { transport: t })).retried).toBe(0);
      await pool.query(`UPDATE email_outbox SET next_attempt_at = NOW() WHERE id = $1`, [e.id]);
    }
    const last = await deliverDueEmails(pool, log, { transport: t });
    expect(last.failed).toBe(1);
    expect(await row(e.id)).toMatchObject({ status: 'failed', attempts: 5 });
    expect(t.sent).toHaveLength(5);
  });

  it('an unexpected error (not a MailSendError) is treated as transient', async () => {
    const e = await queue('e@x.example');
    const t = fakeTransport(() => new Error('socket hang up'));
    expect((await deliverDueEmails(pool, log, { transport: t })).retried).toBe(1);
    expect((await row(e.id)).status).toBe('queued');
  });

  it('a transport that succeeds after a retry marks the notice sent', async () => {
    const e = await queue('f@x.example');
    let calls = 0;
    const t = fakeTransport(() =>
      ++calls === 1 ? new MailSendError('429', { permanent: false }) : { messageId: 'ok' },
    );
    await deliverDueEmails(pool, log, { transport: t });
    await pool.query(`UPDATE email_outbox SET next_attempt_at = NOW() WHERE id = $1`, [e.id]);
    await deliverDueEmails(pool, log, { transport: t });
    expect(await row(e.id)).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('deliverQueuedEmails drains more than one batch', async () => {
    for (let i = 0; i < 7; i++) await queue(`g${i}@x.example`);
    const t = fakeTransport(() => ({}));
    const s = await deliverQueuedEmails(pool, log, { transport: t, limit: 3 });
    expect(s).toEqual({ sent: 7, logged: 0, failed: 0, retried: 0 });
  });

  it('backs off 1, 5, 15, then 60 minutes', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([
      60_000, 300_000, 900_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
  });
});

describe('claimDueEmails', () => {
  it('concurrent claims never return the same notice', async () => {
    for (let i = 0; i < 12; i++) await queue(`h${i}@x.example`);
    const batches = await Promise.all(
      Array.from({ length: 5 }, () => claimDueEmails(pool, { limit: 12 })),
    );
    const ids = batches.flat().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(12);
    // Every claim counted one attempt and leased the row into the future.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM email_outbox WHERE attempts = 1 AND next_attempt_at > NOW()`,
    );
    expect(rows[0].n).toBe(12);
    // Leased: nothing is due now.
    expect(await claimDueEmails(pool)).toHaveLength(0);
  });

  it('two claims with small limits split the queue between them', async () => {
    for (let i = 0; i < 6; i++) await queue(`k${i}@x.example`);
    const [a, b] = await Promise.all([
      claimDueEmails(pool, { limit: 3 }),
      claimDueEmails(pool, { limit: 3 }),
    ]);
    const ids = [...a!, ...b!].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });
});
