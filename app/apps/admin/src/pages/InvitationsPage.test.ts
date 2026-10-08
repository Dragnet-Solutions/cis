/**
 * InvitationsPage live-wiring fix (UX-OPS-002) — confirms the page can no
 * longer render the old "self-contained local state" mockup: no seeded
 * batches/templates/requests fixture, no fake audience counts, no
 * undecided-provider placeholder text. This is the fourth instance of the
 * defect class first found on Mission Board and fixed the same way for
 * Scoring/National report/Firm reports: a page that never called its own
 * real, tested, already-routed backend.
 *
 * A raw source scan rather than a render test — there is no DOM test
 * infrastructure in this repo (the "unit" Vitest project runs with
 * environment: 'node'), and the meaningful thing to prove is that the exact
 * literal content of the old mockup's fixtures is gone, not just that new
 * code was added alongside it.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const SOURCE = readFileSync(new URL('./InvitationsPage.tsx', import.meta.url), 'utf8');

describe('InvitationsPage — no local-state mockup remains reachable', () => {
  it('has no seeded/fixture data arrays', () => {
    for (const banned of ['SEED_TEMPLATES', 'SEED_BATCHES', 'SEED_REQUESTS', 'const AUDIENCES']) {
      expect(SOURCE, `source still contains "${banned}"`).not.toContain(banned);
    }
  });

  it('has no hardcoded example firm names, contacts, or counts from the old mockup', () => {
    for (const banned of [
      'FBNQuest',
      'Chapel Hill Denham',
      'Ifeoma Lawal',
      'Adaeze Nwosu',
      // The old mockup's specific fabricated audience counts (Every firm: 249,
      // not yet invited: 37, unclaimed: 141, etc.) — real counts now come from
      // a live query, so these exact numbers have no business appearing here.
      'n: 249',
      'n: 141',
    ]) {
      expect(SOURCE, `source still contains "${banned}"`).not.toContain(banned);
    }
  });

  it('has no "sending service not yet decided" placeholder — the provider is resolved (Zeptomail)', () => {
    expect(SOURCE).not.toContain('Sending service not yet decided');
  });

  it('takes real client/editionId props, not zero props', () => {
    expect(SOURCE).toMatch(/export function InvitationsPage\(\{\s*client,\s*editionId,?\s*\}/);
  });

  it('calls the real backend for every piece: audiences, templates, batches, requests', () => {
    for (const call of [
      'client.listAudiences',
      'client.listMessageTemplates',
      'client.saveMessageTemplate',
      'client.validateUpload',
      'client.sendInvitationBatch',
      'client.listInvitationBatches',
      'client.getInvitationBatchReport',
      'client.getBouncedRecipients',
      'client.listInvitationRequests',
      'client.resolveInvitationRequest',
      'client.resolveFirmNames',
    ]) {
      expect(SOURCE, `source never calls "${call}"`).toContain(call);
    }
  });

  it('has no resend action — only documentation of its deliberate absence', () => {
    // The word "resend" appears only in comments/copy explaining it does NOT
    // exist; there is no function, handler, or client call actually named it.
    expect(SOURCE).not.toMatch(/function resend/i);
    expect(SOURCE).not.toMatch(/client\.resend/i);
    expect(SOURCE).not.toMatch(/onClick[^}]*resend/i);
  });
});
