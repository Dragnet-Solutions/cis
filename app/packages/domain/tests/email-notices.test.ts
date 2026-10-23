/**
 * Every email-based feature queues a real email in the outbox (which the API's
 * dispatcher sends through ZeptoMail): invitation batches (rendered per
 * recipient, firm addresses resolved, no-address recipients recorded as not
 * sent), answered invitation requests, regulator survey links and reminders,
 * coordinator welcomes and PIN notices, save-and-resume links, firm digests,
 * new operators, and respondent reminders. Each has a stable kind and ref_id,
 * and none carries a PIN or password.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  createCoordinator,
  createFirmInvitation,
  createRespondent,
  setRespondentContact,
  upsertDraft,
  listInstitutions,
  listEmailsFor,
  listRecipients,
  listTemplates,
  insertInvitationRequest,
  listFirmInvitationsForOrganization,
  type OutboxEmail,
} from '@cis/db';
import {
  seedReferenceData,
  sendBatch,
  getBatchReport,
  resolveInvitationRequest,
  saveContact,
  issueSurveyLink,
  sendReminder,
  sendTextReminder,
  addCoordinator,
  createLeadCoordinator,
  setCoordinatorPin,
  startJourney,
  registerContact,
  sendFirmDigest,
  addPerson,
  scheduleDueReminders,
  setReminderSchedule,
  setReminderCap,
  renderTemplateText,
  claimSpace,
  lookupInvitation,
  FIRM_INVITATION_EMAIL_KIND,
  INVITATION_BATCH_EMAIL_KIND,
  INVITATION_REQUEST_EMAIL_KIND,
  REGULATOR_SURVEY_LINK_EMAIL_KIND,
  REGULATOR_REMINDER_EMAIL_KIND,
  COORDINATOR_WELCOME_EMAIL_KIND,
  COORDINATOR_PIN_SET_EMAIL_KIND,
  SURVEY_RESUME_EMAIL_KIND,
  FIRM_DIGEST_EMAIL_KIND,
  OPERATOR_SET_PASSWORD_EMAIL_KIND,
  RESPONDENT_REMINDER_EMAIL_KIND,
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

async function allEmails(kind: string): Promise<OutboxEmail[]> {
  const res = await pool.query<{ id: string }>(
    'SELECT ref_id AS id FROM email_outbox WHERE kind = $1',
    [kind],
  );
  return listEmailsFor(
    pool,
    kind,
    res.rows.map((r) => r.id),
  );
}

async function firm(name: string) {
  return createOrganization(pool, {
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    displayName: name,
    orgType: 'firm',
  });
}

async function templateId(name: string): Promise<string> {
  const t = (await listTemplates(pool, editionId)).find((x) => x.name === name);
  if (!t) throw new Error(`no template ${name}`);
  return t.id;
}

const noSecrets = (e: OutboxEmail, ...secrets: string[]) => {
  for (const s of secrets) {
    expect(e.bodyText).not.toContain(s);
    expect(e.bodyHtml ?? '').not.toContain(s);
  }
};

describe('Invitation batches render the template and resolve each firm’s address', () => {
  it('writes to the lead coordinator, else another coordinator, else the open invitation; records no-address firms as not sent', async () => {
    const withLead = await firm('Lead Capital');
    await createCoordinator(pool, {
      organizationId: withLead.id,
      name: 'Other Person',
      email: 'other@lead.example',
      accessCode: 'AAAA1111',
    });
    await createCoordinator(pool, {
      organizationId: withLead.id,
      name: 'Lead Person',
      email: 'lead@lead.example',
      isLead: true,
      accessCode: 'AAAA2222',
    });
    const coordOnly = await firm('Coordinator Securities');
    await createCoordinator(pool, {
      organizationId: coordOnly.id,
      name: 'Coord',
      email: 'coord@coord.example',
      accessCode: 'BBBB1111',
    });
    const invited = await firm('Invited Partners');
    const inv = await createFirmInvitation(pool, {
      organizationId: invited.id,
      editionId,
      email: 'contact@invited.example',
      contactName: 'Ngozi',
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      invitedBy: makerUserId,
    });
    const nobody = await firm('Nobody Stockbrokers');

    const result = await sendBatch(pool, {
      editionId,
      templateId: await templateId('First invitation'),
      audienceId: 'all',
      portalUrl: PORTAL,
    });
    expect(result.attempted).toBe(4);
    expect(result.sent).toBe(3);
    expect(result.notSent).toBe(1);

    const recipients = await listRecipients(pool, result.batch.id);
    const byOrg = new Map(recipients.map((r) => [r.organizationId, r]));
    expect(byOrg.get(withLead.id)?.recipientEmail).toBe('lead@lead.example');
    expect(byOrg.get(coordOnly.id)?.recipientEmail).toBe('coord@coord.example');
    expect(byOrg.get(invited.id)?.recipientEmail).toBe('contact@invited.example');
    expect(byOrg.get(nobody.id)?.recipientEmail).toBeNull();
    expect(byOrg.get(nobody.id)?.deliveryState).toBe('not_sent');

    const emails = await listEmailsFor(
      pool,
      INVITATION_BATCH_EMAIL_KIND,
      recipients.map((r) => r.id),
    );
    expect(emails).toHaveLength(3);
    const toLead = emails.find((e) => e.toAddress === 'lead@lead.example')!;
    expect(toLead.refId).toBe(byOrg.get(withLead.id)!.id);
    expect(toLead.toName).toBe('Lead Person');
    // The seeded "First invitation" goes out in its approved design (F-01).
    expect(toLead.subject).toBe('Lead Capital is invited to the CIS-Dragnet 2026 Benchmark Study');
    expect(toLead.bodyText).toContain('Dear Lead Person,');
    expect(toLead.bodyText).not.toContain('{{');
    // A firm with a space is sent to the portal's sign-in, not a claim link.
    expect(toLead.bodyText).toContain(`${PORTAL}/firm`);
    expect(toLead.bodyText).not.toContain('claim=');
    // The invited firm's link is its open invitation.
    const toInvited = emails.find((e) => e.toAddress === 'contact@invited.example')!;
    expect(toInvited.bodyText).toContain(`${PORTAL}/firm?invite=${inv.token}`);
    expect(toInvited.bodyHtml).toContain(`${PORTAL}/firm?invite=${inv.token}`);

    // The report shows the not-sent firm and the outbox state.
    const report = await getBatchReport(pool, result.batch.id);
    expect(report.firms).toBe(3);
    expect(report.notSent).toBe(1);
    expect(report.outbox).toEqual({ queued: 3, sent: 0, logged: 0, failed: 0 });

    // The not-sent firm is not "already sent": once it has an address, the
    // same template reaches it — and nobody else gets it twice.
    await createCoordinator(pool, {
      organizationId: nobody.id,
      name: 'Late',
      email: 'late@nobody.example',
      isLead: true,
      accessCode: 'CCCC1111',
    });
    const again = await sendBatch(pool, {
      editionId,
      templateId: await templateId('First invitation'),
      audienceId: 'all',
      portalUrl: PORTAL,
    });
    expect(again.sent).toBe(1);
    expect(again.skippedDuplicates).toBe(3);
  });

  it('an edited seeded template keeps its design, with the operators’ words and the link expiry', async () => {
    const f = await firm('Edited Words Ltd');
    await createFirmInvitation(pool, {
      organizationId: f.id,
      editionId,
      email: 'old@edited.example',
      expiresAt: new Date(Date.now() - 86_400_000),
      invitedBy: makerUserId,
    });
    await pool.query(
      `UPDATE message_templates SET body = $1 WHERE edition_id = $2 AND name = 'First invitation'`,
      ['Dear {{firm}},\n\nWe would <really> like you to join. Your link: {{code}}', editionId],
    );
    const r = await sendBatch(pool, {
      editionId,
      templateId: await templateId('First invitation'),
      audienceId: 'all',
      sentBy: makerUserId,
      portalUrl: PORTAL,
    });
    const [rec] = await listRecipients(pool, r.batch.id);
    const [email] = await listEmailsFor(pool, INVITATION_BATCH_EMAIL_KIND, [rec!.id]);
    // F-01's design (subject, code box, button) around the operators' text.
    expect(email!.subject).toBe(
      'Edited Words Ltd is invited to the CIS-Dragnet 2026 Benchmark Study',
    );
    expect(email!.bodyText).toContain(
      'Dear Edited Words Ltd,\n\nWe would <really> like you to join.',
    );
    expect(email!.bodyHtml).toContain('We would &lt;really&gt; like you to join.');
    expect(email!.bodyText).not.toContain('The study gives every participating firm');
    expect(email!.bodyText).toContain('Your invitation code:');
    // The reopened invitation's expiry is in the small print.
    expect(email!.bodyText).toMatch(/This link is personal and expires on \d{1,2} \w+ \d{4}\./);
  });

  it('an unclaimed firm whose invitation expired gets the same invitation reopened; templates without the link get a button', async () => {
    const f = await firm('Claim Me Ltd');
    const old = await createFirmInvitation(pool, {
      organizationId: f.id,
      editionId,
      email: 'old@claim.example',
      expiresAt: new Date(Date.now() - 86_400_000), // expired: address kept, link reopened
      invitedBy: makerUserId,
    });
    const r = await sendBatch(pool, {
      editionId,
      templateId: await templateId('Nobody assigned yet'),
      audienceId: 'all',
      sentBy: makerUserId,
      portalUrl: PORTAL,
    });
    expect(r.sent).toBe(1);
    const [rec] = await listRecipients(pool, r.batch.id);
    const [email] = await listEmailsFor(pool, INVITATION_BATCH_EMAIL_KIND, [rec!.id]);
    expect(email!.toAddress).toBe('old@claim.example');
    expect(email!.bodyText).toContain(`${PORTAL}/firm?invite=${old.token}`);
    expect(email!.bodyText).not.toContain('claim=');
    // "Nobody assigned yet" is F-06: its button carries the firm's link.
    expect(email!.bodyHtml).toContain('Assign the surveys');
    expect(email!.bodyHtml).toContain(`href="${PORTAL}/firm?invite=${old.token}"`);
    // Reopened, not duplicated: the link works again.
    const invs = await listFirmInvitationsForOrganization(pool, f.id);
    expect(invs).toHaveLength(1);
    expect(invs[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await expect(lookupInvitation(pool, old.token)).resolves.toMatchObject({
      organizationId: f.id,
    });
  });

  it('an uploaded firm with no space and no invitation gets a real, claimable invitation in the batch email (and no second email)', async () => {
    const f = await firm('Upload Me Ltd');
    const r = await sendBatch(pool, {
      editionId,
      templateId: await templateId('First invitation'),
      audienceId: 'upload',
      uploadRows: [
        { firmName: 'Upload Me Ltd', email: 'boss@upload.example', organizationId: f.id },
      ],
      sentBy: makerUserId,
      portalUrl: PORTAL,
    });
    expect(r.sent).toBe(1);
    const invs = await listFirmInvitationsForOrganization(pool, f.id);
    expect(invs).toHaveLength(1);
    const inv = invs[0]!;
    expect(inv.email).toBe('boss@upload.example');
    expect(inv.status).toBe('pending');
    expect(inv.editionId).toBe(editionId);

    const [rec] = await listRecipients(pool, r.batch.id);
    expect(rec!.code).toBe(`${PORTAL}/firm?invite=${inv.token}`);
    const [email] = await listEmailsFor(pool, INVITATION_BATCH_EMAIL_KIND, [rec!.id]);
    expect(email!.toAddress).toBe('boss@upload.example');
    expect(email!.bodyText).toContain(`${PORTAL}/firm?invite=${inv.token}`);
    expect(email!.bodyText).not.toContain('claim=');
    // The batch email is the invitation: no separate invitation email.
    expect(await listEmailsFor(pool, FIRM_INVITATION_EMAIL_KIND, [inv.id])).toHaveLength(0);

    // The link really sets up the firm's space.
    const { claim } = await claimSpace(pool, {
      organizationId: f.id,
      contactName: 'Boss',
      contactEmail: 'boss@upload.example',
      mobile: '+234 800 000 0000',
      pin: '135790',
      role: 'Operations',
      privacyConsent: true,
      inviteToken: inv.token,
    });
    expect(claim.organizationId).toBe(f.id);

    // Once claimed, the next batch signs in instead of inviting again.
    const again = await sendBatch(pool, {
      editionId,
      templateId: await templateId('Reminder'),
      audienceId: 'upload',
      uploadRows: [
        { firmName: 'Upload Me Ltd', email: 'boss@upload.example', organizationId: f.id },
      ],
      sentBy: makerUserId,
      portalUrl: PORTAL,
    });
    const [rec2] = await listRecipients(pool, again.batch.id);
    expect(rec2!.code).toBe(`${PORTAL}/firm`);
    expect(await listFirmInvitationsForOrganization(pool, f.id)).toHaveLength(1);
  });

  it('uploaded and regulator audiences are emailed at their given addresses', async () => {
    const r = await sendBatch(pool, {
      editionId,
      templateId: await templateId('Reminder'),
      audienceId: 'upload',
      uploadRows: [{ firmName: 'New Firm Ltd', email: 'new@firm.example' }],
      portalUrl: PORTAL,
    });
    expect(r.sent).toBe(1);
    const [rec] = await listRecipients(pool, r.batch.id);
    const [email] = await listEmailsFor(pool, INVITATION_BATCH_EMAIL_KIND, [rec!.id]);
    expect(email!.toAddress).toBe('new@firm.example');
    expect(email!.bodyText).toContain('Dear New Firm Ltd,');
    expect(email!.bodyText).toContain(`${PORTAL}/firm`);
  });

  it('renders placeholders, and "Dear {{firm}}" without a name', () => {
    expect(renderTemplateText('Dear {{firm}}, see {{ code }}', { firm: 'A', link: 'L' })).toBe(
      'Dear A, see L',
    );
    expect(renderTemplateText('Dear {{firm}},', { firm: null, link: null })).toBe('Hello,');
  });

  it('issuing a requested invitation emails the requester their firm’s link', async () => {
    const f = await firm('Requested Firm');
    const req = await insertInvitationRequest(pool, {
      editionId,
      organizationId: f.id,
      firmName: 'Requested Firm',
      requesterName: 'Tunde',
      email: 'tunde@requested.example',
    });
    await resolveInvitationRequest(pool, {
      requestId: req.id,
      resolution: 'code_issued',
      resolvedBy: makerUserId,
      portalUrl: PORTAL,
    });
    // An invitation is opened for the requester, and its link is emailed —
    // in this one email, not a second invitation email.
    const [inv] = await listFirmInvitationsForOrganization(pool, f.id);
    expect(inv!.email).toBe('tunde@requested.example');
    expect(await listEmailsFor(pool, FIRM_INVITATION_EMAIL_KIND, [inv!.id])).toHaveLength(0);
    const [email] = await listEmailsFor(pool, INVITATION_REQUEST_EMAIL_KIND, [req.id]);
    expect(email!.toAddress).toBe('tunde@requested.example');
    expect(email!.bodyText).toContain(`${PORTAL}/firm?invite=${inv!.token}`);
    expect(email!.bodyText).not.toContain('claim=');
    await expect(lookupInvitation(pool, inv!.token)).resolves.toMatchObject({
      organizationId: f.id,
      email: 'tunde@requested.example',
    });

    // With a reissue template: rendered and recorded as a one-recipient batch.
    const req2 = await insertInvitationRequest(pool, {
      editionId,
      organizationId: f.id,
      firmName: 'Requested Firm',
      requesterName: 'Bola',
      email: 'bola@requested.example',
    });
    await resolveInvitationRequest(pool, {
      requestId: req2.id,
      resolution: 'code_issued',
      reissueTemplateId: await templateId('Reissued code'),
      resolvedBy: makerUserId,
      portalUrl: PORTAL,
    });
    const batchEmails = await allEmails(INVITATION_BATCH_EMAIL_KIND);
    expect(batchEmails.map((e) => e.toAddress)).toEqual(['bola@requested.example']);
    expect(batchEmails[0]!.subject).toBe('A new invitation code for Requested Firm');
    expect(batchEmails[0]!.bodyText).toContain('Dear Bola,');
    // The firm already has an open invitation (Tunde's): its link is sent.
    expect(batchEmails[0]!.bodyText).toContain(`${PORTAL}/firm?invite=${inv!.token}`);

    // A request whose firm is not in the register cannot be issued a link.
    const req4 = await insertInvitationRequest(pool, {
      editionId,
      firmName: 'Unknown Firm',
      requesterName: 'Kemi',
      email: 'kemi@unknown.example',
    });
    await expect(
      resolveInvitationRequest(pool, {
        requestId: req4.id,
        resolution: 'code_issued',
        resolvedBy: makerUserId,
        portalUrl: PORTAL,
      }),
    ).rejects.toMatchObject({ code: 'FIRM_NOT_MATCHED' });

    // Marking done sends nothing.
    const req3 = await insertInvitationRequest(pool, {
      editionId,
      firmName: 'Quiet Firm',
      requesterName: 'Ade',
      email: 'ade@quiet.example',
    });
    await resolveInvitationRequest(pool, {
      requestId: req3.id,
      resolution: 'marked_done',
      portalUrl: PORTAL,
    });
    expect(await listEmailsFor(pool, INVITATION_REQUEST_EMAIL_KIND, [req3.id])).toHaveLength(0);
  });
});

describe('Regulators: the survey link and reminders are emailed to the saved contact', () => {
  const CONTACT = {
    who: 'Hauwa Ibrahim',
    role: 'Director',
    email: 'h.ibrahim@sec.example',
    phone: '+234 803 221 4470',
    how: 'Introduced by the Registrar',
  };

  it('emails the survey URL on issue and on reminder; a text reminder sends no email', async () => {
    const sec = (await listInstitutions(pool)).find(
      (i) => i.name === 'Securities and Exchange Commission',
    )!.id;
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    const view = await issueSurveyLink(pool, editionId, sec, 'A', {
      targetBy: '2026-11-20',
      portalUrl: PORTAL,
    });
    const token = view.surveyLink!.split('/').pop()!;
    const respondentId = (
      await pool.query<{ respondent_id: string }>(
        'SELECT respondent_id FROM institution_engagement WHERE institution_id = $1 AND family_code = $2',
        [sec, 'A'],
      )
    ).rows[0]!.respondent_id;

    const [link] = await listEmailsFor(pool, REGULATOR_SURVEY_LINK_EMAIL_KIND, [respondentId]);
    expect(link!.toAddress).toBe('h.ibrahim@sec.example');
    expect(link!.toName).toBe('Hauwa Ibrahim');
    expect(link!.bodyText).toContain(`${PORTAL}/survey?resume=${token}`);
    expect(link!.bodyText).toContain('20 November');
    expect(view.history[0]!.entry).toContain('emailed to Hauwa Ibrahim');

    const reminded = await sendReminder(pool, editionId, sec, 'A', { portalUrl: PORTAL });
    const [rem] = await listEmailsFor(pool, REGULATOR_REMINDER_EMAIL_KIND, [respondentId]);
    expect(rem!.toAddress).toBe('h.ibrahim@sec.example');
    expect(rem!.bodyText).toContain(`${PORTAL}/survey?resume=${token}`);
    expect(reminded.history[0]!.entry).toBe(
      'Reminder emailed to Hauwa Ibrahim (h.ibrahim@sec.example).',
    );

    const texted = await sendTextReminder(pool, editionId, sec, 'A');
    expect(texted.history[0]!.entry).toContain('nothing was sent automatically');
    expect(await listEmailsFor(pool, REGULATOR_REMINDER_EMAIL_KIND, [respondentId])).toHaveLength(
      1,
    );
  });
});

describe('Firm team: coordinators are welcomed by email, never with a PIN', () => {
  it('welcomes an added coordinator and a new lead when the portal address is given', async () => {
    const f = await firm('Team Firm');
    const lead = await createLeadCoordinator(
      pool,
      { organizationId: f.id, name: 'Lola Lead', email: 'lola@team.example' },
      { portalUrl: PORTAL },
    );
    const member = await addCoordinator(
      pool,
      { organizationId: f.id, name: 'Musa Member', email: 'musa@team.example' },
      { portalUrl: PORTAL },
    );
    const [welcomeLead] = await listEmailsFor(pool, COORDINATOR_WELCOME_EMAIL_KIND, [lead.id]);
    const [welcomeMember] = await listEmailsFor(pool, COORDINATOR_WELCOME_EMAIL_KIND, [member.id]);
    expect(welcomeLead!.toAddress).toBe('lola@team.example');
    expect(welcomeLead!.bodyText).toContain(`${PORTAL}/firm`);
    expect(welcomeLead!.bodyText).toContain('Team Firm');
    expect(welcomeMember!.bodyText).toContain('PIN');
    noSecrets(welcomeMember!, member.accessCode);

    await setCoordinatorPin(pool, member.id, { newPin: '482913' }, { portalUrl: PORTAL });
    const [pinSet] = await listEmailsFor(pool, COORDINATOR_PIN_SET_EMAIL_KIND, [member.id]);
    expect(pinSet!.toAddress).toBe('musa@team.example');
    noSecrets(pinSet!, '482913');
  });

  it('sends nothing without the portal address (e.g. a firm claiming its own space)', async () => {
    const f = await firm('Quiet Team');
    const c = await addCoordinator(pool, {
      organizationId: f.id,
      name: 'Silent',
      email: 'silent@quiet.example',
    });
    await setCoordinatorPin(pool, c.id, { newPin: '123456' });
    expect(await listEmailsFor(pool, COORDINATOR_WELCOME_EMAIL_KIND, [c.id])).toHaveLength(0);
    expect(await listEmailsFor(pool, COORDINATOR_PIN_SET_EMAIL_KIND, [c.id])).toHaveLength(0);
  });
});

describe('Save and resume: the respondent is emailed their link back', () => {
  it('emails the resume link when an email is given, and caps repeats', async () => {
    const r = await startJourney(pool, { editionId, instrumentCode: 'S4' });
    const updated = await registerContact(
      pool,
      r.id,
      { consentAccepted: true, channel: 'email', email: 'investor@x.example' },
      { portalUrl: PORTAL },
    );
    const [email] = await listEmailsFor(pool, SURVEY_RESUME_EMAIL_KIND, [r.id]);
    expect(email!.toAddress).toBe('investor@x.example');
    expect(email!.bodyText).toContain(`${PORTAL}/survey?resume=${updated.recoveryToken}`);

    for (let i = 0; i < 6; i++) {
      await registerContact(
        pool,
        r.id,
        { consentAccepted: true, channel: 'email', email: 'investor@x.example' },
        { portalUrl: PORTAL },
      );
    }
    expect(await listEmailsFor(pool, SURVEY_RESUME_EMAIL_KIND, [r.id])).toHaveLength(5);
  });

  it('sends nothing for a text-only or no-contact choice', async () => {
    const r = await startJourney(pool, { editionId, instrumentCode: 'S4' });
    await registerContact(
      pool,
      r.id,
      { consentAccepted: true, channel: 'text', phone: '+234 803 000 0000' },
      { portalUrl: PORTAL },
    );
    expect(await listEmailsFor(pool, SURVEY_RESUME_EMAIL_KIND, [r.id])).toHaveLength(0);
  });
});

describe('Firm digest, new operators and respondent reminders are emailed', () => {
  it('queues the digest to the lead coordinator', async () => {
    const f = await firm('Digest Firm');
    await createCoordinator(pool, {
      organizationId: f.id,
      name: 'Dee Lead',
      email: 'dee@digest.example',
      isLead: true,
      accessCode: 'DDDD1111',
    });
    const result = await sendFirmDigest(pool, editionId, f.id, undefined, { portalUrl: PORTAL });
    expect(result.deliveryState).toBe('sent');
    const [email] = await listEmailsFor(pool, FIRM_DIGEST_EMAIL_KIND, [f.id]);
    expect(email!.toAddress).toBe('dee@digest.example');
    expect(email!.bodyText).toContain('Firm surveys:');
    expect(email!.bodyText).toContain(`${PORTAL}/firm`);
  });

  it('tells a new operator they have access, with a link to choose their own password', async () => {
    const person = await addPerson(
      pool,
      {
        name: 'New Operator',
        email: 'new.op@cis.example',
        organization: 'CIS',
        rights: {},
        actorId: makerUserId,
      },
      { portalUrl: PORTAL },
    );
    const [email] = await listEmailsFor(pool, OPERATOR_SET_PASSWORD_EMAIL_KIND, [person.userId]);
    expect(email!.toAddress).toBe('new.op@cis.example');
    expect(email!.bodyText).toMatch(new RegExp(`${PORTAL}/set-password\\?token=[A-Za-z0-9_-]{43}`));
    // Never a password: only the link to choose one.
    expect(email!.bodyText).not.toMatch(/placeholder|unusable|password: \S/i);
  });

  it('emails a due reminder to an investor who chose email, with STOP only after the first', async () => {
    await setReminderSchedule(pool, {
      steps: [
        { step: 1, kind: 'relative', days: 2, enabled: true },
        { step: 2, kind: 'relative', days: 7, enabled: true },
      ],
    });
    await setReminderCap(pool, 2);
    const r = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    await setRespondentContact(pool, r.id, {
      channel: 'email',
      email: 'remind@x.example',
      recoveryToken: '0b6f8c1e-2f6a-4f7e-9a51-1c2d3e4f5a6b',
    });
    await upsertDraft(pool, {
      respondentId: r.id,
      questionId: 'S4-Q1',
      scope: 'shared',
      ratedFirmId: null,
      answer: { a: '5' },
    });
    const DAY = 86_400_000;
    const [first] = await scheduleDueReminders(pool, editionId, new Date(Date.now() + 3 * DAY), {
      portalUrl: PORTAL,
    });
    const [second] = await scheduleDueReminders(pool, editionId, new Date(Date.now() + 8 * DAY), {
      portalUrl: PORTAL,
    });
    const [e1] = await listEmailsFor(pool, RESPONDENT_REMINDER_EMAIL_KIND, [first!.id]);
    const [e2] = await listEmailsFor(pool, RESPONDENT_REMINDER_EMAIL_KIND, [second!.id]);
    expect(e1!.toAddress).toBe('remind@x.example');
    expect(e1!.bodyText).toContain(`${PORTAL}/survey?resume=0b6f8c1e-2f6a-4f7e-9a51-1c2d3e4f5a6b`);
    expect(e1!.bodyText).not.toContain('/survey?stop=');
    // The managed wording (Wording page) is the body, inside the P-02 design.
    expect(e1!.subject).toBe('Your survey is still open');
    expect(e1!.bodyText).toContain('That is completely fine — your answers are saved');
    expect(e2!.bodyText).toContain(`${PORTAL}/survey?stop=0b6f8c1e-2f6a-4f7e-9a51-1c2d3e4f5a6b`);
  });
});
