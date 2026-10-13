/**
 * Regulator engagement — Phase 12 (UX-OPS-007) DoD §11, re-keyed for Phase 19's
 * institutional instrument family model (institutionId + familyCode replacing
 * the old fixed SEC/NGX/CSCS enum).
 *
 *  - Ordering: a link cannot be issued for a role with no saved contact.
 *  - Contact validation: email format and phone length (≥10 digits) are each
 *    enforced independently as hard failures.
 *  - Referral is cancel-and-restart: from an invited role it resets survey
 *    to none, clears the link and target_by, kills the old token, and logs the
 *    loss of any partial response.
 *  - Declined is terminal within the edition — no reminder / issue action —
 *    except via `reopenDeclined` (Phase 19, item 6), `access:regs`-gated.
 *  - Phase 10 integration: the lead time set here IS institution_engagement's
 *    target_by, so a previously-inert condition 16 becomes evaluable.
 *  - Phase 3 integration: issuing a link mints a REAL per-role access token
 *    that resolves in the UX-INS-003 survey runtime (getResumeByToken).
 *  - History is free-text and append-only, with no category taxonomy.
 *  - Regression: Phase 6's PUB_10 still names CSCS as market infrastructure.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { loadRbacContext, PermissionDeniedError } from '@cis/auth';
import {
  seedReferenceData,
  listRegulators,
  saveContact,
  issueSurveyLink,
  sendReminder,
  sendTextReminder,
  markDeclined,
  reopenDeclined,
  recordHistory,
  getResumeByToken,
  getRegulator,
  submitJourney,
  saveDraftAnswer,
  getMissionBoard,
  NATIONAL_SECTIONS,
  evaluateSection,
  CollectionClosedError,
} from '../src';
import { listInstitutions, getInstrumentItems, updateEditionStatus } from '@cis/db';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';
import { answerAll } from './helpers/answers';

let pool: Pool;
let editionId: string;
let makerUserId: string;
let checkerUserId: string;
let sec: string;
let cscs: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  makerUserId = seed.makerUserId;
  checkerUserId = seed.checkerUserId;
  const institutions = await listInstitutions(pool);
  sec = institutions.find((i) => i.name === 'Securities and Exchange Commission')!.id;
  cscs = institutions.find((i) => i.name === 'Central Securities Clearing System')!.id;
});
afterAll(async () => {
  await closeTestPool();
});

const CONTACT = {
  who: 'Hauwa Ibrahim',
  role: 'Director, Market Supervision',
  email: 'h.ibrahim@sec.gov.ng',
  phone: '+234 803 221 4470', // 13 digits
  how: 'Introduced by the Registrar',
};

describe('Contact-before-survey ordering is a server-side precondition', () => {
  it('rejects a link issuance for a role with no saved contact', async () => {
    await expect(
      issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-09-01' }),
    ).rejects.toMatchObject({ code: 'CONTACT_REQUIRED_FIRST' });
  });
});

describe('Contact validation — email and phone enforced independently', () => {
  it('rejects a malformed email (with an otherwise valid phone)', async () => {
    await expect(
      saveContact(pool, editionId, sec, 'A', { ...CONTACT, email: 'not-an-email' }),
    ).rejects.toMatchObject({ code: 'CONTACT_EMAIL_INVALID' });
  });

  it('rejects a phone with fewer than 10 digits (with an otherwise valid email)', async () => {
    await expect(
      saveContact(pool, editionId, sec, 'A', { ...CONTACT, phone: '0123 456' }),
    ).rejects.toMatchObject({ code: 'CONTACT_PHONE_INVALID' });
  });

  it('saves once every field is valid', async () => {
    const view = await saveContact(pool, editionId, sec, 'A', CONTACT);
    expect(view.contact?.who).toBe('Hauwa Ibrahim');
    expect(view.state).toBe('contact_added');
    expect(view.nextStep).toBe('Issue the survey link');
  });
});

describe('Referral is cancel-and-restart, not a workflow', () => {
  it('resets survey to none, clears the link and target_by, kills the old token, logs the loss', async () => {
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    const invited = await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-09-01' });
    expect(invited.state).toBe('invited');
    expect(invited.targetBy).toBe('2026-09-01');
    const oldToken = invited.surveyLink!.split('/').pop()!;
    expect(await getResumeByToken(pool, oldToken)).not.toBeNull(); // live before referral

    const restarted = await saveContact(pool, editionId, sec, 'A', {
      who: 'Ada Umeh',
      role: 'Head, Registration',
      email: 'a.umeh@sec.gov.ng',
      phone: '+234 800 111 2222',
      how: 'Hauwa said Ada is the right person',
    });
    expect(restarted.state).toBe('contact_added'); // back to needing a link
    expect(restarted.status).toBe('not_started');
    expect(restarted.targetBy).toBeNull();
    expect(restarted.surveyLink).toBeNull();
    expect(restarted.contact?.who).toBe('Ada Umeh');
    // The earlier link is dead — its partial answers cannot be transferred.
    expect(await getResumeByToken(pool, oldToken)).toBeNull();
    expect(restarted.history[0]!.entry).toContain(
      'Started again with Ada Umeh in place of Hauwa Ibrahim',
    );
    expect(restarted.history[0]!.entry).toContain('no longer works');
  });
});

describe('Declined is a distinct, terminal outcome for the edition (unless reopened)', () => {
  it('offers no reminder or issue action once declined', async () => {
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-09-01' });
    const declined = await markDeclined(pool, editionId, sec, 'A');
    expect(declined.state).toBe('declined');
    expect(declined.nextStep).toBe('Section must be replanned');

    await expect(sendReminder(pool, editionId, sec, 'A')).rejects.toMatchObject({
      code: 'NO_ACTIVE_LINK',
    });
    await expect(sendTextReminder(pool, editionId, sec, 'A')).rejects.toMatchObject({
      code: 'NO_ACTIVE_LINK',
    });
    await expect(
      issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-10-01' }),
    ).rejects.toMatchObject({ code: 'DECLINED_TERMINAL' });
  });
});

describe('reopenDeclined (Phase 19, item 6) — access:regs-gated, no maker-checker', () => {
  it('refuses without access:regs', async () => {
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-09-01' });
    await markDeclined(pool, editionId, sec, 'A');

    // The checker user is seeded WITHOUT access:regs (see seed.ts).
    const checkerRbac = await loadRbacContext(pool, checkerUserId);
    await expect(reopenDeclined(pool, checkerRbac, editionId, sec, 'A')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('resets to not_started with the survey link cleared but the contact KEPT, for a single access:regs holder — no second approver', async () => {
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-09-01' });
    await markDeclined(pool, editionId, sec, 'A');

    // The maker user IS seeded with access:regs (see seed.ts) — one person,
    // no maker-checker pair, since this corrects a routine mistake.
    const makerRbac = await loadRbacContext(pool, makerUserId);
    const reopened = await reopenDeclined(pool, makerRbac, editionId, sec, 'A');
    expect(reopened.status).toBe('not_started');
    expect(reopened.state).toBe('contact_added'); // ready to re-issue immediately
    expect(reopened.contact?.who).toBe('Hauwa Ibrahim'); // kept, not wiped
    expect(reopened.surveyLink).toBeNull();
    expect(reopened.targetBy).toBeNull();
    expect(reopened.history[0]!.entry).toContain('Reopened after being recorded as declined');
  });

  it('refuses to reopen a role that was never declined', async () => {
    const makerRbac = await loadRbacContext(pool, makerUserId);
    await expect(reopenDeclined(pool, makerRbac, editionId, sec, 'A')).rejects.toMatchObject({
      code: 'NOT_DECLINED',
    });
  });
});

describe('Phase 10 integration — the lead time here IS institution_engagement.target_by', () => {
  it('makes condition 16 (previously inert with a null target_by) evaluable once a date is set', async () => {
    // Before: seeded target_by is NULL, so condition 16 raises nothing for SEC.
    const before = await getMissionBoard(pool, editionId, new Date('2026-10-01T00:00:00Z'));
    expect(before.cards.some((c) => c.conditionId === 16)).toBe(false);

    // Issue a link with a lead time in the past relative to the evaluation instant.
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-08-01' });

    const after = await getMissionBoard(pool, editionId, new Date('2026-10-01T00:00:00Z'));
    const c16 = after.cards.find((c) => c.conditionId === 16);
    expect(c16).toBeTruthy();
    expect(c16!.evidence.join(' ')).toContain('Securities and Exchange Commission');
  });
});

describe('Phase 3 integration — a real per-role survey access token', () => {
  it('issuing a link mints a working token into the UX-INS-003 (I-SEC) runtime', async () => {
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    const view = await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-09-01' });
    expect(view.surveyLink).toMatch(/^\/journeys\/resume\//);
    const token = view.surveyLink!.split('/').pop()!;
    const resume = await getResumeByToken(pool, token);
    expect(resume).not.toBeNull();
    expect(resume!.respondent.instrumentCode).toBe('I-SEC');
  });
});

describe('UX-INS-003 shared-response resume — the single token is a durable handle onto ONE response, not a per-opener key', () => {
  it('reopening the same regulator survey link resumes the SAME respondent record with the prior answer intact — never a reset or a fresh respondent', async () => {
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    const view = await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-09-01' });
    const token = view.surveyLink!.split('/').pop()!;

    // "First person" opens the link and enters a partial answer, but does
    // not submit.
    const firstOpen = await getResumeByToken(pool, token);
    expect(firstOpen).not.toBeNull();
    expect(firstOpen!.drafts).toHaveLength(0);
    const item = firstOpen!.items.find((i) => i.id === 'I-SEC-Q2')!;
    const answer = { a: item.options?.[0] ?? 'x' };
    await saveDraftAnswer(pool, firstOpen!.respondent.id, {
      questionId: item.id,
      ratedFirmId: null,
      answer,
      step: 1,
    });

    // "Second person" opens the exact same link afterward.
    const secondOpen = await getResumeByToken(pool, token);
    expect(secondOpen).not.toBeNull();

    // Same shared response record — this is one institutional position, not
    // a fresh respondent for whoever clicked second.
    expect(secondOpen!.respondent.id).toBe(firstOpen!.respondent.id);
    // The first opener's answer resumed correctly — not reset, not overwritten.
    expect(secondOpen!.drafts).toHaveLength(1);
    expect(secondOpen!.drafts[0]!.questionId).toBe('I-SEC-Q2');
    expect(secondOpen!.drafts[0]!.answer).toEqual(answer);
  });
});

describe('History is free-text and append-only', () => {
  it('accumulates arbitrary free text, newest first, with no category taxonomy', async () => {
    await saveContact(pool, editionId, cscs, 'C', CONTACT);
    await recordHistory(
      pool,
      editionId,
      cscs,
      'C',
      'Called the desk line, left a message with the PA.',
    );
    const view = await recordHistory(pool, editionId, cscs, 'C', 'They will call back on Monday.');
    // Entries carry only free text + a timestamp — no typed category field.
    expect(Object.keys(view.history[0]!).sort()).toEqual(['createdAt', 'entry', 'id']);
    expect(view.history[0]!.entry).toBe('They will call back on Monday.');
    expect(view.history.some((h) => h.entry.includes('left a message with the PA'))).toBe(true);
  });

  it('rejects an empty history entry', async () => {
    await saveContact(pool, editionId, cscs, 'C', CONTACT);
    await expect(recordHistory(pool, editionId, cscs, 'C', '   ')).rejects.toMatchObject({
      code: 'HISTORY_TOO_SHORT',
    });
  });
});

describe('Multi-role institution — CSCS holds Family C AND Family D independently', () => {
  it('gives CSCS two independent engagement rows in the same edition, one per role', async () => {
    const list = await listRegulators(pool, editionId);
    const cscsRows = list.filter((r) => r.institutionId === cscs);
    expect(cscsRows.map((r) => r.familyCode).sort()).toEqual(['C', 'D']);

    // Progressing the C role must not touch the D role.
    await saveContact(pool, editionId, cscs, 'C', CONTACT);
    const after = await listRegulators(pool, editionId);
    const cRow = after.find((r) => r.institutionId === cscs && r.familyCode === 'C')!;
    const dRow = after.find((r) => r.institutionId === cscs && r.familyCode === 'D')!;
    expect(cRow.state).toBe('contact_added');
    expect(dRow.state).toBe('no_contact');
  });
});

describe('The institutional roster', () => {
  it('lists one row per REGISTERED (institution, family) role, all starting at no_contact', async () => {
    const list = await listRegulators(pool, editionId);
    // 4 registered roles: SEC(A), NGX(B), CSCS(C), CSCS(D). NASD, LCFE and the
    // three FMDQ entities are seeded inactive (under CIS review, Screen
    // Stitching Guide §8) and carry no engagement row yet.
    expect(list).toHaveLength(4);
    expect(list.every((r) => r.state === 'no_contact')).toBe(true);
    expect(list.every((r) => r.nextStep === 'Add a contact')).toBe(true);
  });

  it('excludes institutions under CIS review — not registered, not in collection', async () => {
    const list = await listRegulators(pool, editionId);
    const names = list.map((r) => r.name);
    expect(names).not.toContain('NASD OTC Securities Exchange');
    expect(names).not.toContain('Lagos Commodities and Futures Exchange');
    expect(names).not.toContain('FMDQ Securities Exchange Limited');
    expect(names).not.toContain('FMDQ Clear Limited');
    expect(names).not.toContain('FMDQ Depository Limited');
  });
});

describe('Public-naming regression — PUB_10 names CSCS as market infrastructure', () => {
  it('keeps CSCS framed as clearing and settlement, never mislabelled a regulator', async () => {
    const pub10 = NATIONAL_SECTIONS.find((s) => s.id.startsWith('PUB_10'));
    expect(pub10?.name).toBe('Institutional Perspectives');
    // With fewer than three engaged the module is suppressed with a reason that
    // frames CSCS's contribution as clearing and settlement (market infrastructure).
    const { disposition, reason } = evaluateSection(pub10!, {
      segments: {},
      regulatorsEngaged: 2,
    });
    expect(disposition).toBe('suppressed');
    expect(reason).toContain('clearing and settlement');
    expect(reason).not.toMatch(/CSCS is (a|the) regulator/i);
  });
});

// Regression (E2E, 2026-09-30): a regulator submitting through the issued link
// never moved its role off 'invited' — so the national report (which counts
// confirmed roles) kept Institutional Perspectives suppressed for good.
describe('Submitting through the issued link confirms the role', () => {
  it('moves the role to confirmed and records it, in the same submission', async () => {
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    const invited = await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-09-01' });
    const token = invited.surveyLink!.split('/').pop()!;
    const respondentId = (await getResumeByToken(pool, token))!.respondent.id;

    await answerAll(pool, respondentId, await getInstrumentItems(pool, 'I-SEC'), []);
    await submitJourney(pool, respondentId);

    const after = await getRegulator(pool, editionId, sec, 'A');
    expect(after.status).toBe('confirmed');
    expect(after.state).toBe('confirmed');
    expect(after.history[0]!.entry).toMatch(/Submitted through their survey link/);
  });

  it('leaves another role untouched when an unrelated survey is submitted', async () => {
    await saveContact(pool, editionId, cscs, 'C', { ...CONTACT, who: 'CSCS Contact' });
    await issueSurveyLink(pool, editionId, cscs, 'C', { targetBy: '2026-09-01' });
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    const secInvited = await issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-09-01' });
    const token = secInvited.surveyLink!.split('/').pop()!;
    const respondentId = (await getResumeByToken(pool, token))!.respondent.id;

    await answerAll(pool, respondentId, await getInstrumentItems(pool, 'I-SEC'), []);
    await submitJourney(pool, respondentId);

    expect((await getRegulator(pool, editionId, cscs, 'C')).status).toBe('invited');
  });
});

describe('Each role reads as its own mandate', () => {
  it('CSCS’s depository role does not borrow its clearing tagline', async () => {
    const roles = await listRegulators(pool, editionId);
    const cscsRoles = roles.filter((r) => r.institutionId === cscs);
    expect(cscsRoles.find((r) => r.familyCode === 'C')!.mandate).toBe(
      'Clearing, settlement and custody',
    );
    expect(cscsRoles.find((r) => r.familyCode === 'D')!.mandate).toMatch(/Depository/);
  });
});

describe('No link is issued once the results are locked (E2E 9 Oct follow-up)', () => {
  it('refuses to issue a survey link after the lock', async () => {
    await saveContact(pool, editionId, sec, 'A', CONTACT);
    await updateEditionStatus(pool, editionId, 'locked');
    await expect(
      issueSurveyLink(pool, editionId, sec, 'A', { targetBy: '2026-09-01' }),
    ).rejects.toBeInstanceOf(CollectionClosedError);
  });
});
