/**
 * D-01 / D-15 — nav gating and the edition the console opens on.
 */
import { describe, it, expect } from 'vitest';
import {
  TAB_PHASES,
  isTabEnabled,
  surveysRestricted,
  pickCurrentEdition,
  editionOptionLabel,
  tabFromLocation,
  tabUrl,
  tabDisabledReason,
  type Tab,
} from './editionNav';

describe('a greyed tab says why (QA exception #6)', () => {
  it('after the lock, a collection tab says its records are kept, not hidden', () => {
    expect(tabDisabledReason('unfinished', 'closed')).toMatch(/records are kept/);
    expect(tabDisabledReason('regulators', 'closed')).toMatch(/audit trail/);
  });
  it('before results, a reporting tab says when it opens', () => {
    expect(tabDisabledReason('scoring', 'collection_open')).toMatch(/results are locked/);
    expect(tabDisabledReason('responses', 'before_launch')).toMatch(/collecting/);
  });
  it('an enabled tab has no reason', () => {
    expect(tabDisabledReason('mail', 'closed')).toBeNull();
  });
});

describe('a reload keeps the page (QA exception #5)', () => {
  it('reads the page from ?tab= or a bare path, and only a known page', () => {
    expect(tabFromLocation('/', '?tab=mail')).toBe('mail');
    expect(tabFromLocation('/mail', '')).toBe('mail');
    expect(tabFromLocation('/audit/', '')).toBe('audit');
    expect(tabFromLocation('/', '?tab=nonsense')).toBe('edition');
    expect(tabFromLocation('/', '')).toBe('edition');
  });

  it('every page round-trips through its own address', () => {
    for (const tab of Object.keys(TAB_PHASES) as Tab[]) {
      const url = new URL(tabUrl(tab), 'https://admin.example');
      expect(tabFromLocation(url.pathname, url.search)).toBe(tab);
      // Never a /firm… path, which the firm portal owns.
      expect(url.pathname).toBe('/');
    }
  });
});

describe('phase gating', () => {
  it('Surveys stays reachable while collecting (restricted), not once closed', () => {
    expect(isTabEnabled('surveys', 'before_launch')).toBe(true);
    expect(isTabEnabled('surveys', 'collection_open')).toBe(true);
    expect(isTabEnabled('surveys', 'closing_week')).toBe(true);
    expect(isTabEnabled('surveys', 'closed')).toBe(false);
    expect(surveysRestricted('before_launch')).toBe(false);
    expect(surveysRestricted('collection_open')).toBe(true);
    expect(surveysRestricted('closing_week')).toBe(true);
  });

  it('enables exactly these tabs in collection_open', () => {
    const enabled = (Object.keys(TAB_PHASES) as Tab[]).filter((t) =>
      isTabEnabled(t, 'collection_open'),
    );
    expect(enabled.sort()).toEqual(
      [
        'audit',
        'board',
        'dragnet',
        'edition',
        'firmteam',
        'invitations',
        'mail',
        'people',
        'regulators',
        'renderer',
        'responses',
        'surveys',
        'unfinished',
        'wording',
      ].sort(),
    );
  });

  it('Audit is available in every phase', () => {
    for (const p of ['before_launch', 'collection_open', 'closing_week', 'closed'] as const) {
      expect(isTabEnabled('audit', p)).toBe(true);
    }
  });
});

describe('the edition the console opens on', () => {
  const e = (label: string, status: string) => ({ id: label, label, status });
  it('a next-year draft never displaces the open or locked edition', () => {
    expect(pickCurrentEdition([e('2027', 'draft'), e('2026', 'open')])!.label).toBe('2026');
    expect(pickCurrentEdition([e('2027', 'draft'), e('2026', 'locked')])!.label).toBe('2026');
    expect(pickCurrentEdition([e('2027', 'draft'), e('2026', 'archived')])!.label).toBe('2027');
    expect(pickCurrentEdition([e('2026', 'draft')])!.label).toBe('2026');
    expect(pickCurrentEdition([])).toBeNull();
  });
  it('labels switcher options with their status', () => {
    expect(editionOptionLabel(e('2026', 'open'))).toBe('2026 · collecting');
    expect(editionOptionLabel(e('2027', 'draft'))).toBe('2027 · draft');
  });
});
