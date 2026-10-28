/**
 * Inviting a firm to claim its space — integration tests against the real
 * schema. An invitation queues an email carrying a personal link, is audited,
 * needs the "access:send" right, is resent rather than duplicated, is refused
 * for a firm that already has a space, and is used up by the claim it opens.
 * A claim needs an invitation (the FIRM_CLAIM_WITHOUT_INVITE escape hatch
 * covers "[Test]" firms only); a successful claim queues a confirmation email
 * that never carries the PIN. Operators can list each usable link, download
 * the edition's links as CSV, and invite many firms at once.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import {
  createEdition,
  createOrganization,
  getFirmClaim,
  listEmailsFor,
  upsertEditionParticipation,
} from '@cis/db';
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
  listInvitationsWithLinks,
  pendingInvitationsCsv,
  bulkInviteFirms,
  FirmInvitationError,
  AlreadyClaimedError,
  InvitationRequiredError,
  FIRM_INVITATION_EMAIL_KIND,
  FIRM_SPACE_CLAIMED_EMAIL_KIND,
} from '../src';
import { claimWithInvitation } from './helpers/firm-claims';
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
    // The approved firm invitation (F-01): the link is the invitation code.
    expect(email.subject).toBe('CORDROS Ltd is invited to the 2026 CIS-Dragnet Benchmark Study');
    expect(email.bodyText).toContain(`Your invitation code:\n${PORTAL}/firm?invite=${token}`);
    expect(email.bodyText).toMatch(/Survey closes: /);

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
    await claimWithInvitation(pool, { organizationId: org.id, ...CLAIM });
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

  it('refuses a claim without an invitation, and writes nothing', async () => {
    const org = await firm('noinvite');
    const err = await claimSpace(pool, { organizationId: org.id, ...CLAIM }).catch((e) => e);
    expect(err).toBeInstanceOf(InvitationRequiredError);
    expect((err as Error).message).toBe(
      "You need an invitation link to set up your firm's space. Ask the CIS team, or request an invitation.",
    );
    expect(await getFirmClaim(pool, org.id)).toBeNull();
    // A blank token is no token.
    await expect(
      claimSpace(pool, { organizationId: org.id, ...CLAIM, inviteToken: '  ' }),
    ).rejects.toBeInstanceOf(InvitationRequiredError);
  });

  it('queues a confirmation to the claimant that never carries the PIN', async () => {
    const org = await firm('confirm');
    const { invitation } = await invite(org.id);
    const { claim } = await claimSpace(
      pool,
      { organizationId: org.id, ...CLAIM, inviteToken: await tokenOf(invitation.id) },
      { portalUrl: PORTAL },
    );
    const emails = await listEmailsFor(pool, FIRM_SPACE_CLAIMED_EMAIL_KIND, [claim.id]);
    expect(emails).toHaveLength(1);
    const email = emails[0]!;
    expect(email.toAddress).toBe(CLAIM.contactEmail);
    expect(email.subject).toContain('CONFIRM Ltd');
    expect(email.bodyText).toContain(`${PORTAL}/firm`);
    expect(email.bodyText).toContain(CLAIM.contactEmail);
    expect(email.bodyText).toMatch(/PIN you chose/);
    expect(email.bodyText).toMatch(/Name who answers each of the three surveys/);
    expect(email.bodyText).not.toContain(CLAIM.pin);
    expect(email.bodyHtml).not.toContain(CLAIM.pin);
  });

  it('a second claim is still refused', async () => {
    const org = await firm('twice');
    const { leadCoordinator } = await claimWithInvitation(pool, {
      organizationId: org.id,
      ...CLAIM,
    });
    expect(leadCoordinator.isLead).toBe(true);
    await expect(
      claimWithInvitation(pool, { organizationId: org.id, ...CLAIM, contactEmail: 'b@twice.com' }),
    ).rejects.toBeInstanceOf(AlreadyClaimedError);
  });
});

describe('FIRM_CLAIM_WITHOUT_INVITE (automated test runs only)', () => {
  afterEach(() => {
    delete process.env['FIRM_CLAIM_WITHOUT_INVITE'];
  });

  it('lets a "[Test]" firm claim without a link, and no other firm', async () => {
    process.env['FIRM_CLAIM_WITHOUT_INVITE'] = 'true';
    const testFirm = await createOrganization(pool, {
      slug: 'test-hatch',
      displayName: '[Test] Hatch Securities',
      orgType: 'firm',
    });
    const realFirm = await firm('realfirm');
    const { claim } = await claimSpace(pool, { organizationId: testFirm.id, ...CLAIM });
    expect(claim.organizationId).toBe(testFirm.id);
    await expect(
      claimSpace(pool, { organizationId: realFirm.id, ...CLAIM, contactEmail: 'x@real.com' }),
    ).rejects.toBeInstanceOf(InvitationRequiredError);
    // One firm, one space still holds.
    await expect(
      claimSpace(pool, { organizationId: testFirm.id, ...CLAIM, contactEmail: 'y@t.com' }),
    ).rejects.toBeInstanceOf(AlreadyClaimedError);
  });

  it('is off unless set to true', async () => {
    process.env['FIRM_CLAIM_WITHOUT_INVITE'] = '1';
    const testFirm = await createOrganization(pool, {
      slug: 'test-off',
      displayName: '[Test] Off Ltd',
      orgType: 'firm',
    });
    await expect(
      claimSpace(pool, { organizationId: testFirm.id, ...CLAIM }),
    ).rejects.toBeInstanceOf(InvitationRequiredError);
  });
});

describe('operator links, CSV and bulk invitations', () => {
  it('writes a formula-shaped firm name as plain text in the CSV (BUG-06)', async () => {
    const evil = await createOrganization(pool, {
      slug: 'evil-firm',
      displayName: '=HYPERLINK("http://x.example","Click")',
      orgType: 'firm',
    });
    await invite(evil.id, 'md@evil.example');
    const csv = await pendingInvitationsCsv(pool, operator, editionId, PORTAL);
    const row = csv.trim().split(/\r\n/)[1]!;
    expect(row.startsWith(`"'=HYPERLINK(`)).toBe(true);
  });

  it('shows the link of a usable invitation only, and lists it in the CSV', async () => {
    const open = await firm('openlink');
    const gone = await firm('gonelink');
    const a = await invite(open.id, 'md@open.com');
    const b = await invite(gone.id, 'md@gone.com');
    await revokeInvitation(pool, operator, b.invitation.id, CTX);

    const list = await listInvitationsWithLinks(pool, operator, { editionId }, PORTAL);
    const byId = new Map(list.map((i) => [i.id, i]));
    expect(byId.get(a.invitation.id)!.link).toBe(
      `${PORTAL}/firm?invite=${await tokenOf(a.invitation.id)}`,
    );
    expect(byId.get(b.invitation.id)!.link).toBeNull();

    const csv = await pendingInvitationsCsv(pool, operator, editionId, PORTAL);
    const lines = csv.trim().split(/\r\n/);
    expect(lines[0]).toBe('firm,email,link,expires');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('OPENLINK Ltd,md@open.com,');
    expect(lines[1]).toContain(`${PORTAL}/firm?invite=${await tokenOf(a.invitation.id)}`);
    expect(csv).not.toContain('md@gone.com');

    await expect(
      pendingInvitationsCsv(pool, { userId: operator.userId, permissions: [] }, editionId, PORTAL),
    ).rejects.toMatchObject({ name: 'PermissionDeniedError' });
  });

  it('bulk-invites unclaimed participating firms by name prefix and counts the rest', async () => {
    const mk = async (slug: string, name: string) => {
      const o = await createOrganization(pool, { slug, displayName: name, orgType: 'firm' });
      await upsertEditionParticipation(pool, { editionId, organizationId: o.id, status: 'active' });
      return o;
    };
    const fresh1 = await mk('t-one', '[Test] One');
    await mk('t-two', '[Test] Two');
    const claimed = await mk('t-claimed', '[Test] Claimed');
    const pending = await mk('t-pending', '[Test] Pending');
    await mk('real-one', 'Real One Ltd');
    await claimWithInvitation(pool, { organizationId: claimed.id, ...CLAIM });
    await invite(pending.id, 'md@pending.com');

    const result = await bulkInviteFirms(
      pool,
      operator,
      { editionId, namePrefix: '[Test]', emailTemplate: 'coordinator+{slug}@test.example' },
      CTX,
    );
    expect(result).toMatchObject({
      considered: 4,
      invited: 2,
      skippedClaimed: 1,
      skippedPending: 1,
      failed: [],
    });
    const [inv] = await listInvitations(pool, operator, { organizationId: fresh1.id });
    expect(inv!.email).toBe('coordinator+t-one@test.example');
    expect(inv!.editionId).toBe(editionId);

    // Run again: nothing left to invite.
    const again = await bulkInviteFirms(
      pool,
      operator,
      { editionId, namePrefix: '[Test]', emailTemplate: 'coordinator+{slug}@test.example' },
      CTX,
    );
    expect(again).toMatchObject({ invited: 0, skippedPending: 3, skippedClaimed: 1 });

    // A listed firm is invited even without a prefix match.
    const listed = await bulkInviteFirms(
      pool,
      operator,
      {
        editionId,
        organizationIds: [(await firm('listed')).id],
        emailTemplate: 'md+{slug}@test.example',
      },
      CTX,
    );
    expect(listed).toMatchObject({ considered: 1, invited: 1 });
  });

  it('bulk invite refuses a malformed address pattern, and needs the access:send right', async () => {
    await expect(
      bulkInviteFirms(pool, operator, { editionId, emailTemplate: 'not-an-address' }, CTX),
    ).rejects.toMatchObject({ code: 'EMAIL_INVALID' });
    await expect(
      bulkInviteFirms(
        pool,
        { userId: operator.userId, permissions: [] },
        { editionId, emailTemplate: 'a+{slug}@b.com' },
        CTX,
      ),
    ).rejects.toMatchObject({ name: 'PermissionDeniedError' });
  });
});

describe('Invitations belong to an edition (NEW-1)', () => {
  it('an open invitation from the previous edition does not block or show in the next', async () => {
    const t = await firm('t-carry');
    await upsertEditionParticipation(pool, { editionId, organizationId: t.id, status: 'active' });
    await inviteFirm(
      pool,
      operator,
      { organizationId: t.id, editionId, email: 'coordinator+t-carry@test.example' },
      CTX,
    );
    const next = await createEdition(pool, { label: '2099', priorEditionId: editionId });
    await upsertEditionParticipation(pool, {
      editionId: next.id,
      organizationId: t.id,
      status: 'active',
    });

    const bulk = await bulkInviteFirms(
      pool,
      operator,
      {
        editionId: next.id,
        namePrefix: 'T-CARRY',
        emailTemplate: 'coordinator+{slug}@test.example',
      },
      CTX,
    );
    expect(bulk).toMatchObject({ considered: 1, invited: 1, skippedPending: 0 });

    // Each edition's panel shows only its own invitation; both stay usable.
    const inNext = await listInvitations(pool, operator, {
      organizationId: t.id,
      editionId: next.id,
    });
    expect(inNext.map((i) => i.editionId)).toEqual([next.id]);
    const inPrior = await listInvitations(pool, operator, { organizationId: t.id, editionId });
    expect(inPrior.map((i) => i.editionId)).toEqual([editionId]);
    // Without an edition, the firm's whole history.
    expect(await listInvitations(pool, operator, { organizationId: t.id })).toHaveLength(2);

    // Inviting the same address again in the new edition re-sends that
    // edition's invitation rather than the old one.
    const again = await inviteFirm(
      pool,
      operator,
      { organizationId: t.id, editionId: next.id, email: 'coordinator+t-carry@test.example' },
      CTX,
    );
    expect(again.resent).toBe(true);
    expect(again.invitation.editionId).toBe(next.id);
  });
});
