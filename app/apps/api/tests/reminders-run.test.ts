/**
 * D-03 over HTTP and in-process: "Send reminders now" (POST
 * /editions/:id/reminders/run) needs the "write to people" right, reports how
 * many were sent and why any were skipped, is audited, and refuses politely
 * while another pass holds the lock. The scheduler runs the same pass on a
 * timer and can be switched off with REMINDER_SCHEDULE=off.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  createRespondent,
  setRespondentContact,
  upsertDraft,
  listReminderSends,
} from '@cis/db';
import { hashPassword } from '@cis/auth';
import {
  seedReferenceData,
  addPerson,
  REMINDER_PASS_LOCK_KEY,
  RESPONDENT_REMINDER_EMAIL_KIND,
} from '@cis/domain';
import { buildServer } from '../src/server';
import { reminderTick, startReminderScheduler } from '../src/reminders/scheduler';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';
const DAY = 86_400_000;

let app: FastifyInstance;
let makerId: string;
let editionId: string;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  const pool = getTestPool();
  await truncateAllTables(pool);
  const seeded = await seedReferenceData(pool);
  makerId = seeded.makerUserId;
  editionId = seeded.editionId;
  await pool.query(`UPDATE editions SET status = 'open', survey_close_at = $2 WHERE id = $1`, [
    editionId,
    new Date(Date.now() + 30 * DAY),
  ]);
});

afterEach(() => {
  delete process.env['REMINDER_SCHEDULE'];
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

async function idleInvestor(channel: 'email' | 'text', n: number): Promise<string> {
  const pool = getTestPool();
  const r = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
  await setRespondentContact(pool, r.id, {
    channel,
    ...(channel === 'email' ? { email: `p${n}@x.example` } : { phone: '+2348000000000' }),
    recoveryToken: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  });
  await upsertDraft(pool, {
    respondentId: r.id,
    questionId: 'S4-Q1',
    scope: 'shared',
    ratedFirmId: null,
    answer: { a: '5' },
  });
  await pool.query(`UPDATE respondent_drafts SET updated_at = $2 WHERE respondent_id = $1`, [
    r.id,
    new Date(Date.now() - 3 * DAY),
  ]);
  return r.id;
}

async function reminderEmailCount(): Promise<number> {
  const res = await getTestPool().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM email_outbox WHERE kind = $1`,
    [RESPONDENT_REMINDER_EMAIL_KIND],
  );
  return res.rows[0]!.n;
}

const run = (token: string) =>
  app.inject({
    method: 'POST',
    url: `/editions/${editionId}/reminders/run`,
    headers: auth(token),
  });

describe('POST /editions/:id/reminders/run — Send reminders now', () => {
  it('sends the due reminders once, says what it skipped, and is audited', async () => {
    await idleInvestor('email', 1);
    await idleInvestor('email', 2);
    await idleInvestor('text', 3);
    const token = await login('adaeze.okoro@cis.example');

    const first = await run(token);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      collecting: true,
      emailed: 2,
      recorded: 3,
      skipped: { notEmail: 1, noWording: 0, alreadySent: 0, noLongerEligible: 0 },
    });

    const second = await run(token);
    expect(second.json()).toMatchObject({ emailed: 0, recorded: 0, notDue: 3 });
    expect(await reminderEmailCount()).toBe(2);

    const audit = await getTestPool().query<{ actor_id: string; new_value: { emailed: number } }>(
      `SELECT actor_id, new_value FROM audit_log
        WHERE action_type = 'reminders.run_manual' AND entity_id = $1 ORDER BY occurred_at`,
      [editionId],
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]!.actor_id).toBe(makerId);
    expect(audit.rows[0]!.new_value.emailed).toBe(2);
  });

  it('needs the "write to people" right', async () => {
    const pool = getTestPool();
    await idleInvestor('email', 1);
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
    const res = await run(await login('plain@cis.example'));
    expect(res.statusCode).toBe(403);
    expect(await listReminderSends(pool, editionId)).toHaveLength(0);
  });

  it('says so, and sends nothing, while another pass is running', async () => {
    await idleInvestor('email', 1);
    const token = await login('adaeze.okoro@cis.example');
    const holder = await getTestPool().connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [REMINDER_PASS_LOCK_KEY]);
      const res = await run(token);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'REMINDER_RUN_IN_PROGRESS' });
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [REMINDER_PASS_LOCK_KEY]);
      holder.release();
    }
    expect(await reminderEmailCount()).toBe(0);
  });

  it('refuses an edition that is not collecting', async () => {
    await idleInvestor('email', 1);
    await getTestPool().query(`UPDATE editions SET status = 'locked' WHERE id = $1`, [editionId]);
    const res = await run(await login('adaeze.okoro@cis.example'));
    expect(res.json()).toMatchObject({ collecting: false, emailed: 0 });
    expect(await reminderEmailCount()).toBe(0);
  });
});

describe('The reminder scheduler', () => {
  const quietLog = { info: () => {}, error: () => {} };

  it('a tick sends what is due, and a second tick sends nothing more', async () => {
    await idleInvestor('email', 1);
    const first = await reminderTick(getTestPool(), quietLog);
    const second = await reminderTick(getTestPool(), quietLog);
    expect(first.editions[0]!.emailed).toBe(1);
    expect(second.editions[0]!.emailed).toBe(0);
    expect(await reminderEmailCount()).toBe(1);
    // The pass that sent something is audited as the system's; the empty one is not.
    const { rows } = await getTestPool().query<{ actor_id: string | null; new_value: unknown }>(
      "SELECT actor_id, new_value FROM audit_log WHERE action_type = 'reminders.run_scheduled'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBeNull();
    expect(rows[0]!.new_value).toMatchObject({ emailed: 1, recorded: 1 });
  });

  it('runs once shortly after starting, without anyone pressing anything', async () => {
    await idleInvestor('email', 1);
    const stop = startReminderScheduler(getTestPool(), quietLog, {
      firstRunMs: 10,
      intervalMs: 3_600_000,
    });
    try {
      const deadline = Date.now() + 10_000;
      while ((await reminderEmailCount()) === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      stop();
    }
    expect(await reminderEmailCount()).toBe(1);
  });

  it('REMINDER_SCHEDULE=off disables it', async () => {
    process.env['REMINDER_SCHEDULE'] = 'off';
    await idleInvestor('email', 1);
    const stop = startReminderScheduler(getTestPool(), quietLog, { firstRunMs: 1 });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect(await reminderEmailCount()).toBe(0);
  });
});
