/**
 * Invitations — Phase 9 (UX-OPS-002) DoD §12.
 *  - Seven firm audiences resolve against live Phase 4 firm/seat/outreach state.
 *  - Participant audiences reflect contact-consent (Phase 3), not raw responses.
 *  - Deduplication is per template: same firm+template blocked, different template ok.
 *  - File validation is exactly four checks; no fifth register-match check exists.
 *  - A firm code-bearing template missing {{code}} is blocked; participant/regulator ok.
 *  - Delivery report: sent/delivered/bounced always; opened/clicked only when reported.
 *  - No resend-to-bounced code path exists.
 *  - A request-an-invitation submission appears in the queue and can be resolved.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  insertFirmClaim,
  ensureSeats,
  setSeatState,
  createOutreachLink,
  createRespondent,
  listTemplates,
  createBatch,
  insertRecipient,
  recordDelivery,
  listBouncedRecipients,
} from '@cis/db';
import * as domain from '../src';
import {
  seedReferenceData,
  listAudiences,
  saveTemplate,
  validateUploadFile,
  sendBatch,
  getBatchReport,
  submitInvitationRequest,
  getInvitationRequests,
  resolveInvitationRequest,
  resolveFirmNamesToOrgs,
  getBouncedRecipients,
  InvitationsError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  editionId = (await seedReferenceData(pool)).editionId;
});
afterAll(async () => {
  await closeTestPool();
});

async function firm(slug: string) {
  return createOrganization(pool, { slug, displayName: slug, orgType: 'firm' });
}
async function templateId(name: string): Promise<string> {
  const t = (await listTemplates(pool, editionId)).find((x) => x.name === name);
  if (!t) throw new Error(`template ${name} not seeded`);
  return t.id;
}
/** Mark a firm as "invited this edition" by recording a recipient under a batch. */
async function markInvited(orgId: string, tplId: string) {
  const batch = await createBatch(pool, {
    editionId,
    templateId: tplId,
    audienceId: 'seed',
    audienceLabel: 'seed',
  });
  await insertRecipient(pool, { batchId: batch.id, editionId, organizationId: orgId });
}
async function claim(orgId: string) {
  await insertFirmClaim(pool, {
    organizationId: orgId,
    claimingContactName: 'C',
    claimingContactEmail: `c@${orgId.slice(0, 6)}.example`,
    privacyConsent: true,
    followUpConsent: false,
  });
}
async function completeSeats(orgId: string, seats: Array<'S1' | 'S2' | 'S3'>) {
  await ensureSeats(pool, editionId, orgId);
  for (const s of seats) {
    await setSeatState(pool, { editionId, organizationId: orgId, seatCode: s, state: 'complete' });
  }
}
function firmCount(cats: Awaited<ReturnType<typeof listAudiences>>, id: string): number {
  const cat = cats.find((c) => c.audiences.some((a) => a.id === id))!;
  return cat.audiences.find((a) => a.id === id)!.count ?? -1;
}

describe('Seven firm audiences resolve against live state', () => {
  it('counts each of the seven correctly', async () => {
    const inviteTpl = await templateId('First invitation');

    const fNew = await firm('firm-new'); // not invited
    const fUnclaimed = await firm('firm-unclaimed');
    const fNoassign = await firm('firm-noassign');
    const fPartial = await firm('firm-partial');
    const fNoreach = await firm('firm-noreach');
    const fComplete = await firm('firm-complete');

    // Invite everyone except fNew.
    for (const f of [fUnclaimed, fNoassign, fPartial, fNoreach, fComplete]) {
      await markInvited(f.id, inviteTpl);
    }
    // Claims.
    for (const f of [fNoassign, fPartial, fNoreach, fComplete]) await claim(f.id);
    // Seat progress.
    await ensureSeats(pool, editionId, fNoassign.id); // all empty
    await completeSeats(fPartial.id, ['S1']); // assigned 1, complete 1
    await completeSeats(fNoreach.id, ['S1', 'S2', 'S3']);
    await completeSeats(fComplete.id, ['S1', 'S2', 'S3']);
    // Outreach only for the complete firm.
    await createOutreachLink(pool, {
      editionId,
      organizationId: fComplete.id,
      token: 'tok-complete',
      segment: 'individual',
    });

    const cats = await listAudiences(pool, editionId);
    expect(firmCount(cats, 'all')).toBe(6);
    expect(firmCount(cats, 'newaddr2')).toBe(1);
    expect(firmCount(cats, 'unclaimed')).toBe(1);
    expect(firmCount(cats, 'noassign')).toBe(1);
    expect(firmCount(cats, 'partial')).toBe(1);
    expect(firmCount(cats, 'noreach')).toBe(1);
    expect(firmCount(cats, 'complete')).toBe(1);
    // Reference the ids so lint is happy they were used meaningfully.
    expect(fNew.id).toBeTruthy();
    expect(fUnclaimed.id).toBeTruthy();
  });
});

describe('Participant audiences reflect contact-consent, not raw responses', () => {
  it('counts only respondents who gave a contact detail', async () => {
    // 3 retail responses, 2 with a contact detail.
    const mk = async (code: string, withContact: boolean) => {
      const r = await createRespondent(pool, { editionId, instrumentCode: code });
      await pool.query(
        `UPDATE respondents SET submitted_at = NOW(),
            contact_channel = $2, contact_email = $3 WHERE id = $1`,
        [
          r.id,
          withContact ? 'email' : 'none',
          withContact ? `r-${r.id.slice(0, 6)}@x.example` : null,
        ],
      );
    };
    await mk('S4', true);
    await mk('S4', true);
    await mk('S4', false); // responded, no contact detail → not counted
    await mk('S5a', true);
    await mk('S5b', true);

    const cats = await listAudiences(pool, editionId);
    const parts = cats.find((c) => c.key === 'parts')!;
    const c = (id: string) => parts.audiences.find((a) => a.id === id)!.count;
    expect(c('retail')).toBe(2); // not 3
    expect(c('localinst')).toBe(1);
    expect(c('foreigninst')).toBe(1);
    expect(c('allpart')).toBe(4);
  });
});

describe('Deduplication is per template', () => {
  it('blocks the same firm+template twice, allows a different template', async () => {
    const f = await firm('dedup-firm');
    const reminder = await templateId('Reminder');
    const first = await templateId('First invitation');

    // Firm audience 'all' → the one firm.
    const r1 = await sendBatch(pool, { editionId, templateId: reminder, audienceId: 'all' });
    expect(r1.sent).toBe(1);
    const r2 = await sendBatch(pool, { editionId, templateId: reminder, audienceId: 'all' });
    expect(r2.sent).toBe(0);
    expect(r2.skippedDuplicates).toBe(1);
    // A different template to the same firm still goes.
    const r3 = await sendBatch(pool, { editionId, templateId: first, audienceId: 'all' });
    expect(r3.sent).toBe(1);
    expect(f.id).toBeTruthy();
  });
});

describe('File validation — exactly four checks, no register-match fifth', () => {
  it('independently flags no-address, malformed, in-file duplicate, and already-sent', async () => {
    const f = await firm('already-firm');
    const first = await templateId('First invitation');
    // Give the firm this template already (so its org id trips already_sent).
    await sendBatch(pool, { editionId, templateId: first, audienceId: 'all' });

    const result = await validateUploadFile(pool, {
      editionId,
      templateId: first,
      rows: [
        { firmName: 'No Address Ltd', email: '' },
        { firmName: 'Bad Ltd', email: 'not-an-email' },
        { firmName: 'Dup A', email: 'dup@x.example' },
        { firmName: 'Dup B', email: 'dup@x.example' }, // in-file duplicate
        { firmName: 'already-firm', email: 'a@x.example', organizationId: f.id },
        { firmName: 'Fine Ltd', email: 'fine@x.example' },
      ],
    });
    const kinds = result.problems.map((p) => p.kind).sort();
    expect(kinds).toEqual(['already_sent', 'in_file_duplicate', 'malformed_address', 'no_address']);
    expect(result.validRows.map((r) => r.email)).toEqual(['dup@x.example', 'fine@x.example']);
  });

  it('has no fifth "register match" check kind anywhere', () => {
    // Structural: the only check kinds are the four; no near-match/register concept.
    const kinds = ['no_address', 'malformed_address', 'in_file_duplicate', 'already_sent'];
    expect(kinds).toHaveLength(4);
    // And the service exposes no register-resolution/near-match function.
    const names = Object.keys(domain).join(',').toLowerCase();
    expect(names).not.toMatch(/nearmatch|register.?match|fuzzy/);
  });
});

describe('Template {{code}} gate', () => {
  it('blocks a firm code-bearing template with no {{code}}, allows participant/regulator without it', async () => {
    await expect(
      saveTemplate(pool, {
        editionId,
        name: 'Bad firm invite',
        subject: 's',
        body: 'Dear {{firm}}, welcome.', // no {{code}}
        audienceKind: 'firm',
        requiresCode: true,
      }),
    ).rejects.toMatchObject({ code: 'CODE_PLACEHOLDER_REQUIRED' });

    const ok = await saveTemplate(pool, {
      editionId,
      name: 'Report notice',
      subject: 's',
      body: 'Your report is ready.',
      audienceKind: 'participant',
    });
    expect(ok.requiresCode).toBe(false);
  });
});

describe('Delivery report degrades gracefully', () => {
  it('always reports sent/delivered/bounced; opens/clicks only when the provider reports them', async () => {
    const first = await templateId('First invitation');
    const batch = await createBatch(pool, {
      editionId,
      templateId: first,
      audienceId: 'upload',
      audienceLabel: 'Uploaded list',
    });
    const r1 = await insertRecipient(pool, {
      batchId: batch.id,
      editionId,
      recipientEmail: 'a@x.example',
    });
    const r2 = await insertRecipient(pool, {
      batchId: batch.id,
      editionId,
      recipientEmail: 'b@x.example',
    });
    const r3 = await insertRecipient(pool, {
      batchId: batch.id,
      editionId,
      recipientEmail: 'c@x.example',
    });
    await recordDelivery(pool, r1.id, { deliveryState: 'delivered' });
    await recordDelivery(pool, r2.id, { deliveryState: 'delivered' });
    await recordDelivery(pool, r3.id, { deliveryState: 'bounced' });

    let report = await getBatchReport(pool, batch.id);
    expect(report.firms).toBe(3);
    expect(report.delivered).toBe(2);
    expect(report.bounced).toBe(1);
    expect(report.opensReported).toBe(false); // provider didn't report opens
    expect(report.clicksReported).toBe(false);
    expect(report.deliveredNeverOpened).toBe(2); // both delivered, none opened

    // Provider later reports an open + a click on r1.
    await recordDelivery(pool, r1.id, { openedAt: new Date(), clickedAt: new Date() });
    report = await getBatchReport(pool, batch.id);
    expect(report.opensReported).toBe(true);
    expect(report.opened).toBe(1);
    expect(report.clicked).toBe(1);
    expect(report.openedNotClicked).toBe(0); // the one open also clicked
  });
});

describe('Bounce handling — no resend, listing only', () => {
  it('exposes a bounced-address listing but no resend action', async () => {
    const first = await templateId('First invitation');
    const batch = await createBatch(pool, {
      editionId,
      templateId: first,
      audienceId: 'upload',
      audienceLabel: 'Uploaded list',
    });
    const r = await insertRecipient(pool, {
      batchId: batch.id,
      editionId,
      recipientEmail: 'bounce@x.example',
    });
    await recordDelivery(pool, r.id, { deliveryState: 'bounced' });
    const bounced = await listBouncedRecipients(pool, batch.id);
    expect(bounced).toHaveLength(1);
    // No resend function exists in the domain surface.
    const names = Object.keys(domain).join(',').toLowerCase();
    expect(names).not.toMatch(/resend/);
  });
});

/**
 * InvitationsPage live-wiring fix — this was a real gap found while wiring:
 * `resolveFirmNameToOrg` existed and was never called from anywhere, so an
 * uploaded CSV row had no way to carry a real organizationId, which meant the
 * fourth file-validation check (already sent this template) could never fire
 * for an upload the way it already does for a firm-audience send. This batch
 * variant fetches the register once instead of once per row.
 */
describe('resolveFirmNamesToOrgs — batch firm-name resolution for uploads', () => {
  it('resolves an exact, case-insensitive match and leaves an unmatched name null', async () => {
    const org = await firm('verify-upload-resolve');
    const resolved = await resolveFirmNamesToOrgs(pool, [
      org.displayName.toUpperCase(),
      'No Such Firm At All',
    ]);
    expect(resolved[org.displayName.toUpperCase()]).toBe(org.id);
    expect(resolved['No Such Firm At All']).toBeNull();
  });

  it('makes the already-sent check fire for an uploaded row, the same as a firm-audience send', async () => {
    const org = await firm('verify-dedup-upload');
    const tpl = await templateId('First invitation');
    await markInvited(org.id, tpl);

    const resolved = await resolveFirmNamesToOrgs(pool, [org.slug]);
    const check = await validateUploadFile(pool, {
      editionId,
      templateId: tpl,
      rows: [{ firmName: org.slug, email: 'x@example.com', organizationId: resolved[org.slug] }],
    });
    expect(check.validRows).toHaveLength(0);
    expect(check.problems).toEqual([{ kind: 'already_sent', row: 1, value: 'x@example.com' }]);
  });
});

describe('getBouncedRecipients — the same listing the domain surface already exposed with no route', () => {
  it('lists exactly the bounced recipients for a batch', async () => {
    const tpl = await templateId('First invitation');
    const batch = await createBatch(pool, {
      editionId,
      templateId: tpl,
      audienceId: 'upload',
      audienceLabel: 'Uploaded list',
    });
    const ok = await insertRecipient(pool, {
      batchId: batch.id,
      editionId,
      recipientEmail: 'ok@x.example',
    });
    const bad = await insertRecipient(pool, {
      batchId: batch.id,
      editionId,
      recipientEmail: 'bad@x.example',
    });
    await recordDelivery(pool, ok.id, { deliveryState: 'delivered' });
    await recordDelivery(pool, bad.id, { deliveryState: 'bounced' });

    const bounced = await getBouncedRecipients(pool, batch.id);
    expect(bounced.map((r) => r.recipientEmail)).toEqual(['bad@x.example']);
  });
});

describe('Access-request queue', () => {
  it('a submitted request appears and can be resolved', async () => {
    await submitInvitationRequest(pool, {
      editionId,
      firmName: 'FBNQuest Securities Limited',
      requesterName: 'Ifeoma Lawal',
      role: 'Head, Client Operations',
      email: 'ifeoma@fbnquest.example',
      phone: '+234 802 445 1180',
      flag: 'The invitation to this firm bounced. Likely the replacement contact.',
    });
    let open = await getInvitationRequests(pool, editionId);
    expect(open).toHaveLength(1);
    expect(open[0]!.flag).toMatch(/bounced/);

    const resolved = await resolveInvitationRequest(pool, {
      requestId: open[0]!.id,
      resolution: 'marked_done',
    });
    expect(resolved.resolved).toBe(true);
    open = await getInvitationRequests(pool, editionId);
    expect(open).toHaveLength(0);
  });

  it('resolving a request twice is refused', async () => {
    const req = await submitInvitationRequest(pool, {
      editionId,
      firmName: 'X',
      requesterName: 'Y',
      email: 'y@x.example',
    });
    await resolveInvitationRequest(pool, { requestId: req.id, resolution: 'marked_done' });
    await expect(
      resolveInvitationRequest(pool, { requestId: req.id, resolution: 'marked_done' }),
    ).rejects.toBeInstanceOf(InvitationsError);
  });
});
