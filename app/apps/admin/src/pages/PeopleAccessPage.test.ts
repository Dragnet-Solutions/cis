/**
 * PeopleAccessPage live-wiring fix (UX-OPS-006) — confirms the page can no
 * longer render the old "self-contained local state" mockup: no hardcoded
 * SEED roster, no hardcoded ME_EMAIL self-identification standing in for the
 * real signed-in viewer. A genuine instance of the same defect class as
 * Mission Board/Scoring/National report/Firm reports/Invitations: a real,
 * tested, already-routed backend (people-access-service.ts, apps/api/src/
 * routes/people.ts) that the page never called.
 *
 * A raw source scan rather than a render test — there is no DOM test
 * infrastructure in this repo (the "unit" Vitest project runs with
 * environment: 'node').
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const SOURCE = readFileSync(new URL('./PeopleAccessPage.tsx', import.meta.url), 'utf8');

describe('PeopleAccessPage — no local-state mockup remains reachable', () => {
  it('has no seeded/fixture roster or hardcoded self-identification', () => {
    for (const banned of [
      'const SEED',
      'ME_EMAIL',
      'Adaeze Okoro',
      'Ayorinde Adeonipekun',
      'Segun Oyegbesan',
      'Joseph Benson',
      "'registrar@cis.org.ng'",
    ]) {
      expect(SOURCE, `source still contains "${banned}"`).not.toContain(banned);
    }
  });

  it('has no destructive demo-scenario function', () => {
    expect(SOURCE).not.toMatch(/function scenario\(/);
    expect(SOURCE).not.toContain("scenario('nobody')");
  });

  it('takes real client/viewer props, not zero props', () => {
    expect(SOURCE).toMatch(/export function PeopleAccessPage\(\{\s*client,\s*viewer,?\s*\}/);
  });

  it('calls the real backend for every piece: list, add, edit, remove', () => {
    for (const call of [
      'client.getPeople',
      'client.addPerson',
      'client.updatePersonRights',
      'client.removePerson',
    ]) {
      expect(SOURCE, `source never calls "${call}"`).toContain(call);
    }
  });

  it('identifies the signed-in user from the real viewer prop, not a hardcoded constant', () => {
    expect(SOURCE).toContain('viewer.email');
  });
});
