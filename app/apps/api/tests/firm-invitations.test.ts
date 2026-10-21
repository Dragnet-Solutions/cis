/**
 * Inviting a firm, over real HTTP: the operator invite route queues the email
 * and lists the invitation with its delivery; the public lookup opens an
 * invitation link or says plainly why it cannot be used; the public claim
 * needs the link's token (403 without one) and queues a confirmation email;
 * operators can copy links, download them as CSV and invite firms in bulk.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  initializePool,
  getPool,
  createOrganization,
  listEmailsFor,
  upsertEditionParticipation,
} from '@cis/db';
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
    // The invite response carries neither the token nor the link.
    expect(JSON.stringify(sent.json())).not.toMatch(/"token"|"link"|invite=/);

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
    const body = listed.json<{
      invitations: Array<InvitationBody & { link: string | null }>;
      claimed: boolean;
    }>();
    expect(body.claimed).toBe(false);
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]!.delivery?.status).toBe('queued');
    // Operators see the usable link (to copy), never the bare token field.
    expect(body.invitations[0]!.link).toMatch(new RegExp(`/firm\\?invite=${inviteToken}$`));
    expect(JSON.stringify(body)).not.toMatch(/"token"/);

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
    // The public lookup exposes exactly these fields — no link, token or delivery.
    expect(Object.keys(lookup.json<{ invitation: object }>().invitation).sort()).toEqual([
      'contactName',
      'email',
      'expiresAt',
      'firmName',
      'organizationId',
    ]);

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
    const claimId = claim.json<{ claim: { id: string } }>().claim.id;
    const confirmation = await listEmailsFor(getPool(), 'firm-space-claimed', [claimId]);
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]!.toAddress).toBe('md@invitehttp.com');
    expect(confirmation[0]!.bodyText).toMatch(/\/firm/);
    expect(confirmation[0]!.bodyText).not.toContain('135790');
    expect(confirmation[0]!.bodyHtml).not.toContain('135790');

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

  it('refuses a claim without an invitation (403), or with another firm’s', async () => {
    const seed = await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    const org = await createOrganization(getPool(), {
      slug: 'no-link-firm',
      displayName: 'No Link Firm Ltd',
      orgType: 'firm',
    });
    const other = await createOrganization(getPool(), {
      slug: 'other-link-firm',
      displayName: 'Other Link Firm Ltd',
      orgType: 'firm',
    });
    const payload = {
      organizationId: org.id,
      contactName: 'A Person',
      contactEmail: 'a@nolink.com',
      mobile: '+234 800 000 0000',
      pin: '135790',
      role: 'Operations',
      privacyConsent: true,
    };
    const noToken = await app.inject({ method: 'POST', url: '/firm/claim', payload });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json()).toMatchObject({
      error: 'InvitationRequiredError',
      message:
        "You need an invitation link to set up your firm's space. Ask the CIS team, or request an invitation.",
    });

    const sent = await app.inject({
      method: 'POST',
      url: `/firms/${other.id}/invitations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { email: 'md@otherlink.com', editionId: seed.editionId },
    });
    const otherId = sent.json<{ invitation: InvitationBody }>().invitation.id;
    const row = await getPool().query<{ token: string }>(
      'SELECT token FROM firm_invitations WHERE id = $1',
      [otherId],
    );
    const wrong = await app.inject({
      method: 'POST',
      url: '/firm/claim',
      payload: { ...payload, inviteToken: row.rows[0]!.token },
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json<{ message: string }>().message).toMatch(/different firm/);

    // The public directory names firms but hands out no ids.
    const dir = await app.inject({ method: 'GET', url: '/firm/directory' });
    expect(dir.statusCode).toBe(200);
    const firms = dir.json<{ firms: Array<Record<string, unknown>> }>().firms;
    expect(firms.map((f) => f['displayName'])).toContain('No Link Firm Ltd');
    expect(JSON.stringify(dir.json())).not.toContain(org.id);
    expect(firms.every((f) => Object.keys(f).join() === 'displayName')).toBe(true);
  });

  it('bulk-invites by name prefix and downloads the links as CSV', async () => {
    const seed = await seedReferenceData(getPool());
    const token = await login('adaeze.okoro@cis.example');
    for (const [slug, name] of [
      ['t-alpha', '[Test] Alpha'],
      ['t-beta', '[Test] Beta'],
      ['real-gamma', 'Gamma Ltd'],
    ] as const) {
      const o = await createOrganization(getPool(), { slug, displayName: name, orgType: 'firm' });
      await upsertEditionParticipation(getPool(), {
        editionId: seed.editionId,
        organizationId: o.id,
        status: 'active',
      });
    }
    const bulk = await app.inject({
      method: 'POST',
      url: `/editions/${seed.editionId}/firm-invitations/bulk`,
      headers: { authorization: `Bearer ${token}` },
      payload: { namePrefix: '[Test]', emailTemplate: 'coordinator+{slug}@test.example' },
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.json()).toMatchObject({
      considered: 2,
      invited: 2,
      skippedClaimed: 0,
      skippedPending: 0,
    });

    const csv = await app.inject({
      method: 'GET',
      url: `/editions/${seed.editionId}/firm-invitations.csv`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.body.trim().split(/\r\n/);
    expect(lines[0]).toBe('firm,email,link,expires');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(
      /^\[Test\] Alpha,coordinator\+t-alpha@test\.example,http[^,]+\/firm\?invite=[0-9a-f-]{36},\d{4}-/,
    );

    // Operator only.
    const anon = await app.inject({
      method: 'GET',
      url: `/editions/${seed.editionId}/firm-invitations.csv`,
    });
    expect(anon.statusCode).toBe(401);
    const anonBulk = await app.inject({
      method: 'POST',
      url: `/editions/${seed.editionId}/firm-invitations/bulk`,
      payload: { namePrefix: '[Test]', emailTemplate: 'x+{slug}@test.example' },
    });
    expect(anonBulk.statusCode).toBe(401);
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
