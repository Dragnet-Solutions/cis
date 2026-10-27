/**
 * A firm's request for an invitation, by email: acknowledged when it arrives
 * (F-10); approved (F-11, followed by the invitation itself) or declined with
 * a reason (F-12) when an operator answers it; marking it done sends nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { createOrganization, listEmailsFor, listInvitationRequests } from '@cis/db';
import {
  seedReferenceData,
  requestInvitation,
  resolveInvitationRequest,
  requestRef,
  INVITATION_REQUEST_RECEIVED_EMAIL_KIND,
  INVITATION_REQUEST_APPROVED_EMAIL_KIND,
  INVITATION_REQUEST_DECLINED_EMAIL_KIND,
  INVITATION_REQUEST_EMAIL_KIND,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

const PORTAL = 'https://cis.example';
let pool: Pool;
let editionId: string;
let makerUserId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  makerUserId = seed.makerUserId;
});
afterAll(async () => {
  await closeTestPool();
});

async function ask(firmName: string, email: string) {
  await requestInvitation(pool, {
    firmName,
    name: 'Chinedu Eze',
    designation: 'Head of Compliance',
    email,
    phone: '+234 803 555 0142',
    privacyConsent: true,
  });
  const reqs = await listInvitationRequests(pool, editionId, { includeResolved: true });
  return reqs.find((r) => r.email === email)!;
}

describe('Requests for an invitation', () => {
  it('acknowledges the request with its reference (F-10)', async () => {
    const req = await ask('Cordros Securities', 'chinedu@cordros.example');
    const [email] = await listEmailsFor(pool, INVITATION_REQUEST_RECEIVED_EMAIL_KIND, [req.id]);
    expect(email!.toAddress).toBe('chinedu@cordros.example');
    expect(email!.subject).toBe(`We have received your request (ref ${requestRef(req.id)})`);
    expect(email!.bodyText).toContain('Dear Chinedu Eze,');
    expect(email!.bodyText).toContain('Cordros Securities');
  });

  it('approving tells the requester (F-11), then sends the invitation (F-01)', async () => {
    await createOrganization(pool, {
      slug: 'cordros',
      displayName: 'Cordros Securities',
      orgType: 'firm',
    });
    const req = await ask('Cordros Securities', 'chinedu@cordros.example');
    await resolveInvitationRequest(pool, {
      requestId: req.id,
      resolution: 'code_issued',
      resolvedBy: makerUserId,
      portalUrl: PORTAL,
    });
    const [approved] = await listEmailsFor(pool, INVITATION_REQUEST_APPROVED_EMAIL_KIND, [req.id]);
    expect(approved!.subject).toBe('Cordros Securities has been added to the study');
    expect(approved!.bodyText).toContain(`(ref ${requestRef(req.id)})`);
    const [invitation] = await listEmailsFor(pool, INVITATION_REQUEST_EMAIL_KIND, [req.id]);
    expect(invitation!.subject).toBe(
      'Cordros Securities is invited to the 2026 CIS-Dragnet Benchmark Study',
    );
    expect(invitation!.bodyText).toMatch(
      /Your invitation code:\nhttps:\/\/cis\.example\/firm\?invite=/,
    );
    expect(approved!.createdAt.getTime()).toBeLessThanOrEqual(invitation!.createdAt.getTime());
  });

  it('declining needs a reason, which the requester is sent (F-12)', async () => {
    const req = await ask('Unknown Brokers', 'kemi@unknown.example');
    await expect(
      resolveInvitationRequest(pool, {
        requestId: req.id,
        resolution: 'declined',
        resolvedBy: makerUserId,
        portalUrl: PORTAL,
      }),
    ).rejects.toMatchObject({ code: 'DECLINE_REASON_REQUIRED' });

    const resolved = await resolveInvitationRequest(pool, {
      requestId: req.id,
      resolution: 'declined',
      declineReason: 'Not a CIS dealing member firm',
      resolvedBy: makerUserId,
      portalUrl: PORTAL,
    });
    expect(resolved).toMatchObject({
      resolved: true,
      resolution: 'declined',
      declineReason: 'Not a CIS dealing member firm',
    });
    const [email] = await listEmailsFor(pool, INVITATION_REQUEST_DECLINED_EMAIL_KIND, [req.id]);
    expect(email!.subject).toBe(`Your request to join the study (ref ${requestRef(req.id)})`);
    expect(email!.bodyText).toContain('Reason: Not a CIS dealing member firm');
    expect(email!.bodyText).toContain('We are unable to add Unknown Brokers');
  });

  it('marking a request done sends nothing beyond the acknowledgement', async () => {
    const req = await ask('Quiet Brokers', 'ade@quiet.example');
    await resolveInvitationRequest(pool, {
      requestId: req.id,
      resolution: 'marked_done',
      resolvedBy: makerUserId,
      portalUrl: PORTAL,
    });
    const { rows } = await pool.query<{ kind: string }>(
      'SELECT kind FROM email_outbox WHERE ref_id = $1',
      [req.id],
    );
    expect(rows.map((r) => r.kind)).toEqual([INVITATION_REQUEST_RECEIVED_EMAIL_KIND]);
  });
});
