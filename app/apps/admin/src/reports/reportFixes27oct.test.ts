/**
 * Fix list 27 Oct, Group 1, on the report pages:
 *  BUG-17  an institution out of scope is counted and described, never dropped;
 *  BUG-18  no drop cap on a figure ("81%" never reads "1%");
 *  BUG-24  a released firm report never carries the draft banner.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InstitutionalReading, ReportNarrativeView } from '../api/types';
import { dropCapClass, Prose } from './parts';
import { outOfScope, outOfScopeNote, participationLine } from './institutional';
import { isReleased } from './FirmReport';

describe('BUG-18: the drop cap never takes a numeral', () => {
  it('opens with a letter: drop cap', () => {
    expect(dropCapClass('Retail investors rate…')).toBe('rpt-lead');
  });

  it('opens with a figure: no drop cap, so the text stays "81%"', () => {
    expect(dropCapClass('81% of retail investors…')).toBeUndefined();
    expect(dropCapClass(' 4 in 10 firms…')).toBeUndefined();
    const narrative = {
      sentences: [{ section: 'EXEC', finding: null, text: '81% of retail investors rate…' }],
    } as unknown as ReportNarrativeView;
    const html = renderToStaticMarkup(
      createElement(Prose, { narrative, section: 'EXEC', lead: true }),
    );
    expect(html).toBe('<p>81% of retail investors rate…</p>');
  });
});

describe('BUG-17: six contributed, five readings — and it says why', () => {
  const read = (role: string) => ({ role }) as InstitutionalReading;
  const contributors = [
    { name: 'Securities and Exchange Commission', code: 'SEC' },
    { name: 'Lagos Commodities and Futures Exchange', code: 'LCFE' },
  ];

  it('finds the contributor with no reading', () => {
    expect(
      outOfScope(contributors, [read('Securities and Exchange Commission')]).map((c) => c.code),
    ).toEqual(['LCFE']);
  });

  it('the participation line and the note agree with the readings shown', () => {
    const line = participationLine({ invited: 6, contributed: 6 }, 5, ['LCFE']);
    expect(line).toBe(
      'Six of six invited institutions contributed. Five gave a reading; LCFE was out of scope this edition.',
    );
    expect(outOfScopeNote(['LCFE'])).toMatch(/^LCFE responded, but reported too little/);
    expect(outOfScopeNote([])).toBeNull();
    expect(participationLine({ invited: 6, contributed: 6 }, 6, [])).toBe(
      'Six of six invited institutions contributed.',
    );
  });
});

describe('BUG-24: a released report is released, whatever its publication record', () => {
  it('released by its own state, even with no publication date', () => {
    expect(isReleased({ publishedAt: null, report: { releaseState: 'released' } } as never)).toBe(
      true,
    );
  });

  it('a draft is not released', () => {
    expect(isReleased({ publishedAt: null, report: { releaseState: 'pending' } } as never)).toBe(
      false,
    );
  });
});
