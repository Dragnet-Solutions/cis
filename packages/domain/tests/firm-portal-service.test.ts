/**
 * Firm claim / portal / seats / outreach integration tests — UX-FRM-001.
 * Covers the Phase 4 DoD §8 gates that live at the domain/DB layer:
 *  - Sequence lock: inviting clients is disabled until all three seats are
 *    assigned, and the disabled state states why.
 *  - Seat replacement: a started seat surfaces the data-loss warning before the
 *    change; a completed seat surfaces the discard warning.
 *  - One firm, one space: a second claim is refused without disclosing who
 *    claimed first.
 *  - Outreach non-joinability: per-segment opens/starts/finishes only; the table
 *    has no respondent/response key and no invitation count.
 *  - Consent gating: privacy consent gates the claim AND the request; follow-up
 *    consent gates nothing.
 *  - Struck-claims regression: no response-count threshold gates anything, and
 *    rating attribution never depends on arrival-via-link.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  createRespondent,
  upsertEditionParticipation,
  getFirmClaim,
  incrementOutreach,
  listFirmOutreachLinks,
  getFirmOutreachSummary,
  getResponsesForRespondent,
} from '@cis/db';
import {
  seedReferenceData,
  getInvitationRequests,
  claimSpace,
  requestInvitation,
  recordFollowUpConsent,
  assignSeat,
  describeSeatReplacement,
  confirmSeatReplacement,
  updateSeatState,
  canInviteClients,
  getSeatStatus,
  ensureOutreachLinks,
  getOutreachVolumes,
  listOutreachLinksForFirm,
  resolveOutreachToken,
  recordOutreachEvent,
  OutreachLinkNotFoundError,
  setRatedFirms,
  PrivacyConsentRequiredError,
  AlreadyClaimedError,
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
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
});
afterAll(async () => {
  await closeTestPool();
});

async function firm(slug: string) {
  return createOrganization(pool, { slug, displayName: slug.toUpperCase(), orgType: 'firm' });
}

const CLAIM = {
  contactName: 'Tunde Okafor',
  contactEmail: 'tunde.o@cordros.com',
  mobile: '+234 800 000 0000',
  pin: '135790',
  role: 'Operations',
  privacyConsent: true,
};

describe('One firm, one space', () => {
  it('refuses a second claim without disclosing who claimed first', async () => {
    const org = await firm('cordros');
    await claimSpace(pool, { organizationId: org.id, ...CLAIM });

    let caught: unknown;
    try {
      await claimSpace(pool, {
        organizationId: org.id,
        ...CLAIM,
        contactName: 'Second Claimant',
        contactEmail: 'someone.else@cordros.com',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AlreadyClaimedError);
    // The error must not leak the first claimant's name or email.
    const msg = (caught as Error).message;
    expect(msg).not.toContain('Tunde');
    expect(msg).not.toContain('tunde.o@cordros.com');
  });
});

describe('Consent gating', () => {
  it('privacy consent gates the claim', async () => {
    const org = await firm('gate-claim');
    await expect(
      claimSpace(pool, { organizationId: org.id, ...CLAIM, privacyConsent: false }),
    ).rejects.toBeInstanceOf(PrivacyConsentRequiredError);
    expect(await getFirmClaim(pool, org.id)).toBeNull();
  });

  it('privacy consent gates request-an-invitation', async () => {
    await expect(
      requestInvitation(pool, {
        firmName: 'Some Firm',
        name: 'A Person',
        designation: 'Head of Ops',
        email: 'person@gmail.com',
        phone: '+2348000000000',
        privacyConsent: false,
      }),
    ).rejects.toBeInstanceOf(PrivacyConsentRequiredError);
  });

  it('accepts a personal email domain on the request path as a note, never a gate', async () => {
    const res = await requestInvitation(pool, {
      firmName: 'Some Firm',
      name: 'A Person',
      designation: 'Head of Ops',
      email: 'person@gmail.com',
      phone: '+2348000000000',
      privacyConsent: true,
    });
    expect(res.accepted).toBe(true);
    expect(res.domainNote).toBe(true); // recorded as a note, request still accepted
  });

  // Regression (E2E, 2026-09-30): the request used to be validated and
  // acknowledged but never saved, so operators never saw it.
  it('saves the request into the operators’ queue, flagged for a personal address', async () => {
    await requestInvitation(pool, {
      firmName: 'Some Firm',
      name: 'A Person',
      designation: 'Head of Ops',
      email: 'person@gmail.com',
      phone: '+2348000000000',
      privacyConsent: true,
    });
    const queue = await getInvitationRequests(pool, editionId);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      firmName: 'Some Firm',
      requesterName: 'A Person',
      email: 'person@gmail.com',
      organizationId: null,
    });
    expect(queue[0]!.flag).toMatch(/Personal email/);
    expect(queue[0]!.flag).toMatch(/not matched to the register/);
  });

  it('follow-up consent gates nothing — the firm claims either way', async () => {
    const withFollow = await firm('follow-yes');
    const claimA = await claimSpace(pool, {
      organizationId: withFollow.id,
      ...CLAIM,
      followUpConsent: true,
    });
    expect(claimA.claim.followUpConsent).toBe(true);

    const withoutFollow = await firm('follow-no');
    const claimB = await claimSpace(pool, {
      organizationId: withoutFollow.id,
      ...CLAIM,
      followUpConsent: false,
    });
    expect(claimB.claim.followUpConsent).toBe(false);
    // Both claims succeeded — follow-up consent did not gate the action.
    expect(await getFirmClaim(pool, withoutFollow.id)).not.toBeNull();

    // And it can be changed afterwards without affecting participation.
    await recordFollowUpConsent(pool, withoutFollow.id, true);
    expect((await getFirmClaim(pool, withoutFollow.id))?.followUpConsent).toBe(true);
  });
});

describe('Sequence lock (invite clients)', () => {
  it('stays locked with a stated reason until all three seats are assigned', async () => {
    const org = await firm('seqlock');
    let lock = await canInviteClients(pool, editionId, org.id);
    expect(lock.allowed).toBe(false);
    expect(lock.reason).toBeTruthy();
    expect(lock.assignedCount).toBe(0);

    await assignSeat(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S1',
      assignedName: 'A',
      assignedEmail: 'a@firm.example',
    });
    await assignSeat(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S2',
      assignedName: 'B',
      assignedEmail: 'b@firm.example',
    });
    lock = await canInviteClients(pool, editionId, org.id);
    expect(lock.allowed).toBe(false); // still one short

    await assignSeat(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S3',
      assignedName: 'C',
      assignedEmail: 'c@firm.example',
    });
    lock = await canInviteClients(pool, editionId, org.id);
    expect(lock.allowed).toBe(true);
    expect(lock.reason).toBeNull();
  });
});

describe('Seat replacement states the cost before the change', () => {
  it('a started seat warns that a part-finished answer is lost', async () => {
    const org = await firm('replace-started');
    await assignSeat(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S1',
      assignedName: 'Bola',
      assignedEmail: 'bola@firm.example',
    });
    await updateSeatState(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S1',
      state: 'started',
    });

    const cost = await describeSeatReplacement(pool, editionId, org.id, 'S1');
    expect(cost.requiresConfirm).toBe(true);
    expect(cost.warning).toMatch(/lost/i);
    // Describing does not perform: the seat is untouched until confirmed.
    const statusesBefore = await getSeatStatus(pool, editionId, org.id);
    expect(statusesBefore.find((s) => s.seatCode === 'S1')?.state).toBe('started');

    await confirmSeatReplacement(pool, editionId, org.id, 'S1');
    const statusesAfter = await getSeatStatus(pool, editionId, org.id);
    expect(statusesAfter.find((s) => s.seatCode === 'S1')?.state).toBe('empty');
  });

  it('a completed seat warns that the response is discarded', async () => {
    const org = await firm('replace-complete');
    await assignSeat(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S2',
      assignedName: 'Ngozi',
      assignedEmail: 'ngozi@firm.example',
    });
    await updateSeatState(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S2',
      state: 'complete',
    });
    const cost = await describeSeatReplacement(pool, editionId, org.id, 'S2');
    expect(cost.requiresConfirm).toBe(true);
    expect(cost.warning).toMatch(/discard/i);
  });

  it('an invited seat has no cost warning', async () => {
    const org = await firm('replace-invited');
    await assignSeat(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S3',
      assignedName: 'Sam',
      assignedEmail: 'sam@firm.example',
    });
    const cost = await describeSeatReplacement(pool, editionId, org.id, 'S3');
    expect(cost.requiresConfirm).toBe(false);
    expect(cost.warning).toBeNull();
  });
});

describe('Visibility boundary — seat status is state only', () => {
  it('returns seat/role/state and never any answer content', async () => {
    const org = await firm('seat-status');
    await assignSeat(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S1',
      assignedName: 'A',
      assignedEmail: 'a@firm.example',
    });
    await updateSeatState(pool, {
      editionId,
      organizationId: org.id,
      seatCode: 'S1',
      state: 'complete',
    });
    const statuses = await getSeatStatus(pool, editionId, org.id);
    const s1 = statuses.find((s) => s.seatCode === 'S1')!;
    expect(s1.state).toBe('complete');
    // The status row carries no answer/response field of any shape.
    expect(Object.keys(s1).sort()).toEqual(['roleLabel', 'seatCode', 'stalledAt', 'state']);
  });
});

describe('Outreach non-joinability & volumes-only', () => {
  it('exposes per-segment opens/starts/finishes with no response key and no invitation count', async () => {
    const org = await firm('outreach');
    await ensureOutreachLinks(pool, editionId, org.id, (seg) => `tok-${seg}`);
    await incrementOutreach(pool, 'tok-individual', 'opens');
    await incrementOutreach(pool, 'tok-individual', 'starts');
    await incrementOutreach(pool, 'tok-individual', 'finishes');

    const volumes = await getOutreachVolumes(pool, editionId, org.id);
    const individual = volumes.find((v) => v.segment === 'individual')!;
    expect(individual).toMatchObject({ opens: 1, starts: 1, finishes: 1 });
    // Exactly the three volumes — no invitation/sent count.
    expect(Object.keys(individual).sort()).toEqual(['finishes', 'opens', 'segment', 'starts']);

    const links = await listFirmOutreachLinks(pool, editionId, org.id);
    expect(links).toHaveLength(3);

    // Structural: the table has no respondent/response key.
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'outreach_links'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).not.toContain('respondent_id');
    expect(names).not.toContain('response_id');
    expect(names).toContain('segment');
    expect(names).toContain('finishes');

    const summary = await getFirmOutreachSummary(pool, editionId, org.id);
    // Summary is counts only — no eligibility/threshold/invitation field.
    expect(Object.keys(summary).sort()).toEqual(['finishes', 'links', 'opens', 'starts']);
  });
});

describe('Outreach-link consumption (Task E) — the public entry-flow side', () => {
  it('resolveOutreachToken exposes ONLY edition/firm/segment — never counts, never the token, never identity', async () => {
    const org = await firm('consume-outreach');
    await ensureOutreachLinks(pool, editionId, org.id, (seg) => `consume-tok-${seg}`);

    const ctx = await resolveOutreachToken(pool, 'consume-tok-individual');
    expect(ctx).toEqual({ editionId, organizationId: org.id, segment: 'individual' });
    // Exactly these three keys — no opens/starts/finishes, no token, no id.
    expect(Object.keys(ctx).sort()).toEqual(['editionId', 'organizationId', 'segment']);
  });

  it('throws OutreachLinkNotFoundError for an unknown token', async () => {
    await expect(resolveOutreachToken(pool, 'no-such-token')).rejects.toBeInstanceOf(
      OutreachLinkNotFoundError,
    );
  });

  it('recordOutreachEvent increments exactly the named counter, real opens/starts/finishes', async () => {
    const org = await firm('record-outreach');
    await ensureOutreachLinks(pool, editionId, org.id, (seg) => `record-tok-${seg}`);

    await recordOutreachEvent(pool, 'record-tok-individual', 'opens');
    await recordOutreachEvent(pool, 'record-tok-individual', 'opens');
    await recordOutreachEvent(pool, 'record-tok-individual', 'starts');

    const volumes = await getOutreachVolumes(pool, editionId, org.id);
    const individual = volumes.find((v) => v.segment === 'individual')!;
    expect(individual).toMatchObject({ opens: 2, starts: 1, finishes: 0 });

    // Untouched segments stay at zero — an event only ever affects its own link.
    const institutional = volumes.find((v) => v.segment === 'local_institutional')!;
    expect(institutional).toMatchObject({ opens: 0, starts: 0, finishes: 0 });
  });

  it('silently no-ops for an unknown token — never an error a respondent could see', async () => {
    await expect(recordOutreachEvent(pool, 'nonexistent', 'opens')).resolves.toBeUndefined();
  });

  it("listOutreachLinksForFirm gives the firm's OWN read its real token — not a non-joinability concern, the firm already owns the link", async () => {
    const org = await firm('list-outreach-tokens');
    await ensureOutreachLinks(pool, editionId, org.id, (seg) => `list-tok-${seg}`);

    const links = await listOutreachLinksForFirm(pool, editionId, org.id);
    expect(links.map((l) => l.token).sort()).toEqual([
      'list-tok-foreign_institutional',
      'list-tok-individual',
      'list-tok-local_institutional',
    ]);
  });

  it('consuming a real event never creates any new joinable link to a respondent', async () => {
    const org = await firm('consume-then-check');
    await ensureOutreachLinks(pool, editionId, org.id, (seg) => `check-tok-${seg}`);
    await recordOutreachEvent(pool, 'check-tok-individual', 'opens');
    await recordOutreachEvent(pool, 'check-tok-individual', 'starts');
    // A real respondent exists in this edition, entirely independent of the
    // outreach event above — nothing about consuming the event ever writes
    // anything referencing a respondent.
    await createRespondent(pool, { editionId, instrumentCode: 'S4' });

    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'outreach_links'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).not.toContain('respondent_id');
    expect(names).not.toContain('response_id');

    const link = await pool.query(
      `SELECT * FROM outreach_links WHERE token = 'check-tok-individual'`,
    );
    expect(Object.keys(link.rows[0] ?? {})).not.toContain('respondent_id');
  });
});

describe('Struck claims never resurface', () => {
  it('rating attribution never depends on arrival-via-link', async () => {
    // A respondent with NO recruiting firm and NO outreach link still rates a firm.
    const rated = await firm('rated-firm');
    await upsertEditionParticipation(pool, {
      editionId,
      organizationId: rated.id,
      status: 'active',
    });
    const respondent = await createRespondent(pool, {
      editionId,
      instrumentCode: 'S4',
      recruitingFirmId: null, // arrived with no firm link at all
    });
    const updated = await setRatedFirms(pool, respondent.id, [rated.id]);
    expect(updated.ratedFirmIds).toEqual([rated.id]);
    // No responses yet, and nothing gated the attribution on a link.
    expect(await getResponsesForRespondent(pool, respondent.id)).toHaveLength(0);
  });

  it('no response-count threshold gates outreach visibility', async () => {
    // With zero finishes, the firm still gets its outreach view (counts of 0),
    // never a "below threshold, nothing available" gate.
    const org = await firm('no-threshold');
    await ensureOutreachLinks(pool, editionId, org.id, (seg) => `nt-${seg}`);
    const volumes = await getOutreachVolumes(pool, editionId, org.id);
    expect(volumes.length).toBeGreaterThan(0);
    for (const v of volumes) {
      expect(v.finishes).toBe(0);
    }
  });
});
