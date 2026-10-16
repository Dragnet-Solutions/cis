/**
 * Inviting a firm to claim its space — integration tests against the real
 * schema. An invitation queues an email carrying a personal link, is audited,
 * needs the "access:send" right, is resent rather than duplicated, is refused
 * for a firm that already has a space, and is used up by the claim it opens.
 * A claim without an invitation still works exactly as before.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createOrganization, getFirmClaim, listEmailsFor } from '@cis/db';
import { getAuditEntriesForEntity } from '@cis/audit';
import { loadRbacContext, type RbacContext } from '@cis/auth';
import {
  seedReferenceData,
  claimSpace,
  inviteFirm,
  sendInvitationAgain,
  revokeInvitation,
  listInvitations,
  lookupInvitation,
  FirmInvitationError,
  AlreadyClaimedError,
  FIRM_INVITATION_EMAIL_KIND,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;
let operator: RbacContext;

const PORTAL = 'https://portal.example';
const CTX = { ipAddress: '127.0.0.1', userAgent: 'vitest', portalUrl: PORTAL };

const CLAIM = {
  contactName: 'Tunde Okafor',
  contactEmail: 'tunde.o@cordros.com',
  mobile: '+234 800 000 0000',
  pin: '135790',
  role: 'Operations',
  privacyConsent: true,
};

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  operator = await loadRbacContext(pool, seed.makerUserId);
});
afterAll(async () => {
  await closeTestPool();
});

async function firm(slug: string) {
  return createOrganization(pool, {
    slug,
    displayName: `${slug.toUpperCase()} Ltd`,
    orgType: 'firm',
  });
}

async function tokenOf(invitationId: string): Promise<string> {
  const r = await pool.query<{ token: string }>(
    'SELECT token FROM firm_invitations WHERE id = $1',
    [invitationId],
  );
  return r.rows[0]!.token;
}

async function invite(orgId: string, email = 'md@cordros.com') {
  return inviteFirm(
    pool,
    operator,
    { organizationId: orgId, editionId, email, contactName: 'Ngozi Bello' },
    CTX,
  );
}

describe('inviteFirm', () => {
  it('queues an email with the personal link and audits the send', async () => {
    const org = await firm('cordros');
    const { invitation, resent } = await invite(org.id);
    expect(resent).toBe(false);
    expect(invitation.state).toBe('pending');
    expect(invitation.firmName).toBe('CORDROS Ltd');
    expect(invitation.delivery?.status).toBe('queued');

    const token = await tokenOf(invitation.id);
    const emails = await listEmailsFor(pool, FIRM_INVITATION_EMAIL_KIND, [invitation.id]);
    expect(emails).toHaveLength(1);
    const email = emails[0]!;
    expect(email.toAddress).toBe('md@cordros.com');
    expect(email.toName).toBe('Ngozi Bello');
    expect(email.subject).toContain('CORDROS Ltd');
    expect(email.bodyText).toContain(`${PORTAL}/firm?invite=${token}`);
    expect(email.bodyHtml).toContain(`${PORTAL}/firm?invite=${token}`);
    expect(email.bodyText).toMatch(/6-digit PIN/);
    expect(email.bodyText).toMatch(/expires on/);

    const audit = await getAuditEntriesForEntity(pool, 'firm_invitation', invitation.id);
    expect(audit.map((a) => a.actionType)).toContain('firm_invitation.sent');

    // Expires in about 14 days.
    const days = (invitation.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it('needs the access:send right', async () => {
    const org = await firm('noperm');
    await expect(
      inviteFirm(
        pool,
        { userId: operator.userId, permissions: [] },
        { organizationId: org.id, email: 'x@noperm.com' },
        CTX,
      ),
    ).rejects.toMatchObject({ name: 'PermissionDeniedError' });
  });

  it('rejects an invalid email address and a non-firm organisation', async () => {
    const org = await firm('bademail');
    await expect(
      inviteFirm(pool, operator, { organizationId: org.id, email: 'not-an-email' }, CTX),
    ).rejects.toMatchObject({ code: 'EMAIL_INVALID' });
    const inst = await createOrganization(pool, {
      slug: 'a-fund',
      displayName: 'A Fund',
      orgType: 'institution',
    });
    await expect(
      inviteFirm(pool, operator, { organizationId: inst.id, email: 'a@fund.com' }, CTX),
    ).rejects.toMatchObject({ code: 'NOT_A_FIRM' });
  });

  it('resends a pending invitation to the same address instead of duplicating it', async () => {
    const org = await firm('dupe');
    const first = await invite(org.id, 'md@dupe.com');
    const again = await invite(org.id, 'MD@dupe.com');
    expect(again.resent).toBe(true);
    expect(again.invitation.id).toBe(first.invitation.id);
    expect(again.invitation.sendCount).toBe(2);
    const list = await listInvitations(pool, operator, { organizationId: org.id });
    expect(list).toHaveLength(1);
    const emails = await listEmailsFor(pool, FIRM_INVITATION_EMAIL_KIND, [first.invitation.id]);
    expect(emails).toHaveLength(2);
    const audit = await getAuditEntriesForEntity(pool, 'firm_invitation', first.invitation.id);
    expect(audit.map((a) => a.actionType)).toContain('firm_invitation.resent');
  });

  it('refuses a firm that already has a space', async () => {
    const org = await firm('claimed');
    await claimSpace(pool, { organizationId: org.id, ...CLAIM });
    await expect(invite(org.id)).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
  });
});

describe('resend, revoke and list', () => {
  it('resend refreshes the expiry; revoke stops the link; list shows both states', async () => {
    const org = await firm('lifecycle');
    const { invitation } = await invite(org.id);
    await pool.query(
      "UPDATE firm_invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1",
      [invitation.id],
    );
    let [listed] = await listInvitations(pool, operator, { organizationId: org.id });
    expect(listed!.state).toBe('expired');

    const resent = await sendInvitationAgain(pool, operator, invitation.id, CTX);
    expect(resent.state).toBe('pending');
    expect(resent.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const revoked = await revokeInvitation(pool, operator, invitation.id, CTX);
    expect(revoked.state).toBe('revoked');
    [listed] = await listInvitations(pool, operator, { editionId });
    expect(listed!.state).toBe('revoked');
    expect(listed!.firmName).toBe('LIFECYCLE Ltd');

    await expect(sendInvitationAgain(pool, operator, invitation.id, CTX)).rejects.toMatchObject({
      code: 'NOT_PENDING',
    });
    const audit = await getAuditEntriesForEntity(pool, 'firm_invitation', invitation.id);
    expect(audit.map((a) => a.actionType)).toContain('firm_invitation.revoked');
  });

  it('reports the latest email delivery status and error', async () => {
    const org = await firm('delivery');
    const { invitation } = await invite(org.id);
    await pool.query(
      "UPDATE email_outbox SET status = 'failed', error = 'Mailbox does not exist' WHERE ref_id = $1",
      [invitation.id],
    );
    const [listed] = await listInvitations(pool, operator, { organizationId: org.id });
    expect(listed!.delivery).toMatchObject({ status: 'failed', error: 'Mailbox does not exist' });
  });
});

describe('lookupInvitation', () => {
  it('returns the firm and address for an open link', async () => {
    const org = await firm('lookup');
    const { invitation } = await invite(org.id);
    const found = await lookupInvitation(pool, await tokenOf(invitation.id));
    expect(found).toMatchObject({
      organizationId: org.id,
      firmName: 'LOOKUP Ltd',
      email: 'md@cordros.com',
      contactName: 'Ngozi Bello',
    });
  });

  it('explains an unknown, expired, revoked or used link', async () => {
    await expect(lookupInvitation(pool, 'nonsense')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      lookupInvitation(pool, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const expiredOrg = await firm('expired');
    const expired = await invite(expiredOrg.id);
    await pool.query(
      "UPDATE firm_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [expired.invitation.id],
    );
    const e = await lookupInvitation(pool, await tokenOf(expired.invitation.id)).catch((x) => x);
    expect(e).toBeInstanceOf(FirmInvitationError);
    expect(e).toMatchObject({ code: 'EXPIRED' });
    expect((e as Error).message).toMatch(/ask the CIS team for a new invitation/i);

    const revokedOrg = await firm('revoked');
    const revoked = await invite(revokedOrg.id);
    await revokeInvitation(pool, operator, revoked.invitation.id, CTX);
    await expect(
      lookupInvitation(pool, await tokenOf(revoked.invitation.id)),
    ).rejects.toMatchObject({ code: 'REVOKED' });

    const usedOrg = await firm('used');
    const used = await invite(usedOrg.id);
    const usedToken = await tokenOf(used.invitation.id);
    await claimSpace(pool, { organizationId: usedOrg.id, ...CLAIM, inviteToken: usedToken });
    await expect(lookupInvitation(pool, usedToken)).rejects.toMatchObject({ code: 'USED' });
  });
});

describe('claimSpace with an invitation', () => {
  it('uses up the invitation and links it to the claim', async () => {
    const org = await firm('claimwith');
    const { invitation } = await invite(org.id);
    const token = await tokenOf(invitation.id);
    // The invitation is to the firm: another address may claim with it.
    const { claim } = await claimSpace(pool, {
      organizationId: org.id,
      ...CLAIM,
      inviteToken: token,
    });
    const row = await pool.query<{ invitation_id: string | null }>(
      'SELECT invitation_id FROM firm_claims WHERE id = $1',
      [claim.id],
    );
    expect(row.rows[0]!.invitation_id).toBe(invitation.id);
    const [listed] = await listInvitations(pool, operator, { organizationId: org.id });
    expect(listed!.state).toBe('accepted');
    expect(listed!.acceptedAt).not.toBeNull();
    const audit = await getAuditEntriesForEntity(pool, 'firm_invitation', invitation.id);
    const accepted = audit.find((a) => a.actionType === 'firm_invitation.accepted');
    expect(accepted?.newValue).toMatchObject({ differentAddress: true });

    // Used up: a second claim with the same link says so.
    await expect(
      claimSpace(pool, { organizationId: org.id, ...CLAIM, inviteToken: token }),
    ).rejects.toMatchObject({ code: 'USED' });
  });

  it('refuses an invitation for another firm, and writes nothing', async () => {
    const invitedOrg = await firm('invited');
    const otherOrg = await firm('other');
    const { invitation } = await invite(invitedOrg.id);
    await expect(
      claimSpace(pool, {
        organizationId: otherOrg.id,
        ...CLAIM,
        inviteToken: await tokenOf(invitation.id),
      }),
    ).rejects.toMatchObject({ code: 'WRONG_FIRM' });
    expect(await getFirmClaim(pool, otherOrg.id)).toBeNull();
    const coords = await pool.query('SELECT 1 FROM firm_coordinators WHERE organization_id = $1', [
      otherOrg.id,
    ]);
    expect(coords.rowCount).toBe(0);
  });

  it('refuses an expired invitation', async () => {
    const org = await firm('lateclaim');
    const { invitation } = await invite(org.id);
    await pool.query(
      "UPDATE firm_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [invitation.id],
    );
    await expect(
      claimSpace(pool, {
        organizationId: org.id,
        ...CLAIM,
        inviteToken: await tokenOf(invitation.id),
      }),
    ).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(await getFirmClaim(pool, org.id)).toBeNull();
  });

  it('still works without an invitation, and a second claim is still refused', async () => {
    const org = await firm('noinvite');
    const { claim, leadCoordinator } = await claimSpace(pool, { organizationId: org.id, ...CLAIM });
    expect(claim.organizationId).toBe(org.id);
    expect(leadCoordinator.isLead).toBe(true);
    await expect(
      claimSpace(pool, { organizationId: org.id, ...CLAIM, contactEmail: 'b@noinvite.com' }),
    ).rejects.toBeInstanceOf(AlreadyClaimedError);
  });
});
