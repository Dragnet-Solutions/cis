/**
 * Inviting a firm, over real HTTP: the operator invite route queues the email
 * and lists the invitation with its delivery; the public lookup opens an
 * invitation link or says plainly why it cannot be used; and the public claim
 * accepts the link's token (it stays optional).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { initializePool, getPool, createOrganization, listEmailsFor } from '@cis/db';
import { seedReferenceData } from '@cis/domain';
import { buildServer } from '../src/server';
import {
  getTestPool,
  runMigrations,
  truncateAllTables,
  closeTestPool,
} from '../../../packages/db/tests/setup';

const PASSWORD = 'ChangeMe!2026';

let app: FastifyInstance;

beforeAll(async () => {
  await runMigrations();
  initializePool();
  app = await buildServer();
  await app.ready();
});

beforeEach(async () => {
  await truncateAllTables(getTestPool());
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

interface InvitationBody {
  id: string;
  state: string;
  email: string;
  delivery: { status: string; error: string | null } | null;
}

describe('firm invitations over HTTP', () => {
  it('invites a firm, lists it, opens the link, and claims with it', async () => {
    const seed = await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    const org = await createOrganization(getPool(), {
      slug: 'invite-http-firm',
      displayName: 'Invite HTTP Firm Ltd',
      orgType: 'firm',
    });

    const sent = await app.inject({
      method: 'POST',
      url: `/firms/${org.id}/invitations`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'md@invitehttp.com',
        contactName: 'Ngozi Bello',
        editionId: seed.editionId,
      },
    });
    expect(sent.statusCode).toBe(201);
    const { invitation } = sent.json<{ invitation: InvitationBody; resent: boolean }>();
    expect(invitation.state).toBe('pending');
    // The token never leaves the server in the operator view.
    expect(JSON.stringify(sent.json())).not.toMatch(/"token"/);

    const emails = await listEmailsFor(getPool(), 'firm-invitation', [invitation.id]);
    expect(emails).toHaveLength(1);
    const link = /\/firm\?invite=([0-9a-f-]{36})/.exec(emails[0]!.bodyText);
    expect(link).not.toBeNull();
    const inviteToken = link![1]!;

    const listed = await app.inject({
      method: 'GET',
      url: `/firms/${org.id}/invitations`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json<{ invitations: InvitationBody[]; claimed: boolean }>();
    expect(body.claimed).toBe(false);
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]!.delivery?.status).toBe('queued');

    const byEdition = await app.inject({
      method: 'GET',
      url: `/editions/${seed.editionId}/firm-invitations`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byEdition.statusCode).toBe(200);
    expect(byEdition.json<{ invitations: InvitationBody[] }>().invitations).toHaveLength(1);

    // Public lookup — no session.
    const lookup = await app.inject({ method: 'GET', url: `/firm/invitations/${inviteToken}` });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({
      invitation: {
        organizationId: org.id,
        firmName: 'Invite HTTP Firm Ltd',
        email: 'md@invitehttp.com',
      },
    });

    const claim = await app.inject({
      method: 'POST',
      url: '/firm/claim',
      payload: {
        organizationId: org.id,
        contactName: 'Ngozi Bello',
        contactEmail: 'md@invitehttp.com',
        mobile: '+234 800 000 0000',
        pin: '135790',
        role: 'Operations',
        privacyConsent: true,
        inviteToken,
      },
    });
    expect(claim.statusCode).toBe(201);

    const used = await app.inject({ method: 'GET', url: `/firm/invitations/${inviteToken}` });
    expect(used.statusCode).toBe(410);
    expect(used.json()).toMatchObject({ code: 'USED' });

    const again = await app.inject({
      method: 'POST',
      url: `/firms/${org.id}/invitations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { email: 'someone@invitehttp.com' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ message: string }>().message).toMatch(/already set up its space/);
  });

  it('resends and revokes; a revoked link is gone; an unknown link is 404', async () => {
    await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    const org = await createOrganization(getPool(), {
      slug: 'revoke-http-firm',
      displayName: 'Revoke HTTP Firm Ltd',
      orgType: 'firm',
    });
    const sent = await app.inject({
      method: 'POST',
      url: `/firms/${org.id}/invitations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { email: 'md@revokehttp.com' },
    });
    const { invitation } = sent.json<{ invitation: InvitationBody }>();

    const resent = await app.inject({
      method: 'POST',
      url: `/firm-invitations/${invitation.id}/resend`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resent.statusCode).toBe(200);
    expect(await listEmailsFor(getPool(), 'firm-invitation', [invitation.id])).toHaveLength(2);

    const revoked = await app.inject({
      method: 'POST',
      url: `/firm-invitations/${invitation.id}/revoke`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json<{ invitation: InvitationBody }>().invitation.state).toBe('revoked');

    const row = await getPool().query<{ token: string }>(
      'SELECT token FROM firm_invitations WHERE id = $1',
      [invitation.id],
    );
    const gone = await app.inject({
      method: 'GET',
      url: `/firm/invitations/${row.rows[0]!.token}`,
    });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ code: 'REVOKED' });

    const unknown = await app.inject({
      method: 'GET',
      url: '/firm/invitations/00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('needs a signed-in operator', async () => {
    const org = await createOrganization(getPool(), {
      slug: 'anon-firm',
      displayName: 'Anon Firm',
      orgType: 'firm',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/firms/${org.id}/invitations`,
      payload: { email: 'x@anon.com' },
    });
    expect(res.statusCode).toBe(401);
  });
});
