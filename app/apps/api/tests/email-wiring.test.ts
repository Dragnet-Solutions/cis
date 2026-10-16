/**
 * The email features over real HTTP: routes queue their emails with links on
 * the public site (PORTAL_URL), and the ZeptoMail delivery webhook is refused
 * without its shared secret and maps ZeptoMail's own payload (by the outbox
 * email id sent as client_reference) onto the outbox and the batch recipient.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  getPool,
  createOrganization,
  createCoordinator,
  listRecipients,
  listEmailsFor,
  getEmailById,
  updateEditionStatus,
} from '@cis/db';
import {
  seedReferenceData,
  INVITATION_BATCH_EMAIL_KIND,
  SURVEY_RESUME_EMAIL_KIND,
  SEAT_ASSIGNED_EMAIL_KIND,
} from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';
const PORTAL = 'https://portal.cis.example';
const SECRET = 'webhook-secret-for-tests';

let app: FastifyInstance;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
  for (const k of ['PORTAL_URL', 'ZEPTOMAIL_WEBHOOK_SECRET']) saved[k] = process.env[k];
  process.env['PORTAL_URL'] = `${PORTAL}/somewhere`;
  process.env['ZEPTOMAIL_WEBHOOK_SECRET'] = SECRET;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

/** Sends the "First invitation" template to every firm; returns the batch id. */
async function sendToAllFirms(editionId: string, token: string): Promise<string> {
  const templates = await app
    .inject({
      method: 'GET',
      url: `/editions/${editionId}/invitations/templates`,
      headers: { authorization: `Bearer ${token}` },
    })
    .then((r) => r.json<{ templates: Array<{ id: string; name: string }> }>().templates);
  const first = templates.find((t) => t.name === 'First invitation')!;
  const res = await app.inject({
    method: 'POST',
    url: `/editions/${editionId}/invitations/send`,
    headers: { authorization: `Bearer ${token}` },
    payload: { templateId: first.id, audienceId: 'all' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json<{ batchId: string; sent: number; notSent: number }>();
  expect(body).toMatchObject({ sent: 1, notSent: 1 });
  return body.batchId;
}

describe('POST /editions/:id/invitations/send', () => {
  it('queues the rendered invitation with links on PORTAL_URL', async () => {
    const seed = await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    const f = await createOrganization(getPool(), {
      slug: 'wired-firm',
      displayName: 'Wired Firm Ltd',
      orgType: 'firm',
    });
    await createCoordinator(getPool(), {
      organizationId: f.id,
      name: 'Wire Lead',
      email: 'lead@wired.example',
      isLead: true,
      accessCode: 'WIRE0001',
    });
    await createOrganization(getPool(), {
      slug: 'no-address-firm',
      displayName: 'No Address Ltd',
      orgType: 'firm',
    });

    const batchId = await sendToAllFirms(seed.editionId, token);
    const recipients = await listRecipients(getPool(), batchId);
    const emails = await listEmailsFor(
      getPool(),
      INVITATION_BATCH_EMAIL_KIND,
      recipients.map((r) => r.id),
    );
    expect(emails).toHaveLength(1);
    expect(emails[0]!.toAddress).toBe('lead@wired.example');
    expect(emails[0]!.bodyText).toContain('Dear Wired Firm Ltd,');
    expect(emails[0]!.bodyText).toContain(`${PORTAL}/firm`);
  });
});

describe('POST /journeys/:respondentId/contact', () => {
  it('emails the respondent their resume link on PORTAL_URL', async () => {
    const seed = await seedReferenceData(getPool());
    await updateEditionStatus(getPool(), seed.editionId, 'open');
    const start = await app.inject({
      method: 'POST',
      url: '/journeys',
      payload: { editionId: seed.editionId, instrumentCode: 'S4' },
    });
    expect(start.statusCode).toBe(201);
    const { respondentId } = start.json<{ respondentId: string }>();
    const res = await app.inject({
      method: 'POST',
      url: `/journeys/${respondentId}/contact`,
      payload: { consentAccepted: true, channel: 'email', email: 'investor@x.example' },
    });
    expect(res.statusCode).toBe(200);
    const { recoveryToken } = res.json<{ recoveryToken: string }>();
    const [email] = await listEmailsFor(getPool(), SURVEY_RESUME_EMAIL_KIND, [respondentId]);
    expect(email!.toAddress).toBe('investor@x.example');
    expect(email!.bodyText).toContain(`${PORTAL}/survey?resume=${recoveryToken}`);
  });
});

describe('POST /firm/:orgId/editions/:editionId/seats/:seatCode/assign', () => {
  it('emails the seat holder their personal link, once per holder', async () => {
    const seed = await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    const f = await createOrganization(getPool(), {
      slug: 'seat-mail-firm',
      displayName: 'Seat Mail Firm',
      orgType: 'firm',
    });
    const assign = (name: string, email: string) =>
      app.inject({
        method: 'POST',
        url: `/firm/${f.id}/editions/${seed.editionId}/seats/S2/assign`,
        headers: { authorization: `Bearer ${token}` },
        payload: { assignedName: name, assignedEmail: email },
      });

    const first = await assign('Comfort Compliance', 'comfort@seat-mail.example');
    expect(first.statusCode).toBe(200);
    const seat = first.json<{ seat: { id: string; linkToken: string } }>().seat;
    let emails = await listEmailsFor(getPool(), SEAT_ASSIGNED_EMAIL_KIND, [seat.id]);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.kind).toBe(SEAT_ASSIGNED_EMAIL_KIND);
    expect(emails[0]!.toAddress).toBe('comfort@seat-mail.example');
    expect(emails[0]!.bodyText).toContain('Seat Mail Firm');
    expect(emails[0]!.bodyText).toContain('Compliance');
    expect(emails[0]!.bodyText).toContain(`${PORTAL}/survey?firmSeat=${seat.linkToken}`);
    expect(emails[0]!.bodyText).not.toMatch(/\bPIN\b|password/i);

    // Re-saving the same holder (address in another case) keeps the link and
    // sends nothing new.
    const again = await assign('Comfort C.', 'Comfort@Seat-Mail.example');
    expect(again.statusCode).toBe(200);
    expect(again.json<{ seat: { linkToken: string } }>().seat.linkToken).toBe(seat.linkToken);
    emails = await listEmailsFor(getPool(), SEAT_ASSIGNED_EMAIL_KIND, [seat.id]);
    expect(emails).toHaveLength(1);

    // A different holder gets a fresh link, emailed to them.
    const other = await assign('Kemi Compliance', 'kemi@seat-mail.example');
    const otherSeat = other.json<{ seat: { linkToken: string } }>().seat;
    expect(otherSeat.linkToken).not.toBe(seat.linkToken);
    emails = await listEmailsFor(getPool(), SEAT_ASSIGNED_EMAIL_KIND, [seat.id]);
    expect(emails).toHaveLength(2);
    const toKemi = emails.find((e) => e.toAddress === 'kemi@seat-mail.example');
    expect(toKemi!.bodyText).toContain(`${PORTAL}/survey?firmSeat=${otherSeat.linkToken}`);
  });
});

describe('POST /invitations/zeptomail-webhook', () => {
  const legacy = (batchId: string) => ({
    batchId,
    recipientEmail: 'lead@hook.example',
    event: 'email.delivered',
  });

  async function batchWithOneEmail(): Promise<{ batchId: string; outboxId: string }> {
    const seed = await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    const f = await createOrganization(getPool(), {
      slug: 'hook-firm',
      displayName: 'Hook Firm',
      orgType: 'firm',
    });
    await createCoordinator(getPool(), {
      organizationId: f.id,
      name: 'Hook Lead',
      email: 'lead@hook.example',
      isLead: true,
      accessCode: 'HOOK0001',
    });
    await createOrganization(getPool(), {
      slug: 'hook-nobody',
      displayName: 'Hook Nobody',
      orgType: 'firm',
    });
    const batchId = await sendToAllFirms(seed.editionId, token);
    const recipients = await listRecipients(getPool(), batchId);
    const [email] = await listEmailsFor(
      getPool(),
      INVITATION_BATCH_EMAIL_KIND,
      recipients.map((r) => r.id),
    );
    return { batchId, outboxId: email!.id };
  }

  it('is refused when no secret is configured', async () => {
    delete process.env['ZEPTOMAIL_WEBHOOK_SECRET'];
    const res = await app.inject({
      method: 'POST',
      url: '/invitations/zeptomail-webhook',
      headers: { 'x-cis-webhook-secret': SECRET },
      payload: legacy('00000000-0000-0000-0000-000000000000'),
    });
    expect(res.statusCode).toBe(503);
  });

  it('is refused without, or with the wrong, secret', async () => {
    const none = await app.inject({
      method: 'POST',
      url: '/invitations/zeptomail-webhook',
      payload: legacy('00000000-0000-0000-0000-000000000000'),
    });
    expect(none.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/invitations/zeptomail-webhook?secret=nope',
      payload: legacy('00000000-0000-0000-0000-000000000000'),
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('accepts the original body shape with the secret header', async () => {
    const { batchId } = await batchWithOneEmail();
    const res = await app.inject({
      method: 'POST',
      url: '/invitations/zeptomail-webhook',
      headers: { 'x-cis-webhook-secret': SECRET },
      payload: legacy(batchId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ matched: true });
    const recipients = await listRecipients(getPool(), batchId);
    expect(recipients.find((r) => r.recipientEmail === 'lead@hook.example')?.deliveryState).toBe(
      'delivered',
    );
  });

  it('maps a ZeptoMail hard bounce by client_reference (secret in the query)', async () => {
    const { batchId, outboxId } = await batchWithOneEmail();
    const res = await app.inject({
      method: 'POST',
      url: `/invitations/zeptomail-webhook?secret=${SECRET}`,
      payload: {
        event_name: ['hardbounce'],
        event_message: [
          {
            email_info: { client_reference: outboxId, subject: 'x' },
            event_data: [{ details: [{ reason: 'Mailbox does not exist' }] }],
          },
        ],
        mailagent_key: 'agent',
        webhook_request_id: 'req-1',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ matched: true, events: 1 });
    const email = await getEmailById(getPool(), outboxId);
    expect(email?.status).toBe('failed');
    expect(email?.error).toContain('Mailbox does not exist');
    const recipients = await listRecipients(getPool(), batchId);
    expect(recipients.find((r) => r.recipientEmail === 'lead@hook.example')?.deliveryState).toBe(
      'bounced',
    );
  });
});
