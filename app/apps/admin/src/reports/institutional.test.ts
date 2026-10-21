/**
 * Section 10 cards: every label comes from the reading's own instrument, and
 * the section groups readings by role. Built for all seven institution roles
 * from the Survey Register itself, then rendered.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import register from '../../../../packages/db/src/seed/survey-register-seed.json';
import type { InstitutionalReading } from '../api/types';
import { InstitutionGroups, cardLabels, groupByRole } from './institutional';

type Item = { question_id: string; text: string };
const INSTRUMENTS = (register as unknown as { instruments: Record<string, Item[]> }).instruments;

const ROLES: Array<{ code: string; name: string; instrument: string; role: string }> = [
  {
    code: 'SEC',
    name: 'Securities and Exchange Commission',
    instrument: 'I-SEC',
    role: 'Regulatory / Supervisory',
  },
  {
    code: 'NGX',
    name: 'Nigerian Exchange Limited',
    instrument: 'I-NGX',
    role: 'Exchange / Market Operator',
  },
  {
    code: 'LCFE',
    name: 'Lagos Commodities and Futures Exchange',
    instrument: 'I-LCFE',
    role: 'Exchange / Market Operator',
  },
  {
    code: 'NASD',
    name: 'NASD OTC Securities Exchange',
    instrument: 'I-NASD',
    role: 'Exchange / Market Operator',
  },
  { code: 'FMDQ', name: 'FMDQ Group', instrument: 'I-FMDQ', role: 'Exchange / Market Operator' },
  {
    code: 'CSCS',
    name: 'Central Securities Clearing System',
    instrument: 'I-CSCS',
    role: 'Clearing / Settlement',
  },
  {
    code: 'CSCS',
    name: 'Central Securities Clearing System',
    instrument: 'I-DEP',
    role: 'Depository / Securities-account Infrastructure',
  },
];

const q = (instrument: string, n: number): string =>
  INSTRUMENTS[instrument]!.find((i) => new RegExp(`(^|-)Q${n}$`).test(i.question_id))!.text;

function reading(r: (typeof ROLES)[number]): InstitutionalReading {
  return {
    key: `${r.instrument}`,
    role: r.name,
    code: r.code,
    familyCode: 'X',
    roleLabel: r.role,
    labels: {
      issue: q(r.instrument, 1),
      frequency: q(r.instrument, 2),
      marks: q(r.instrument, 3),
      consequence: q(r.instrument, 4),
      capability: q(r.instrument, 5),
    },
    vantage: 'A vantage',
    responses: 1,
    topIssues: [],
    issue: { greatest: 'Manual processes', others: [] },
    frequency: 'Occasionally',
    marks: ['Communication'],
    consequence: { greatest: 'Manual processes', others: [] },
    capability: 'Adequate',
  };
}

const READINGS = ROLES.map(reading);

describe('Section 10 institution cards', () => {
  it("each card's labels are its own instrument's questions", () => {
    for (const [i, r] of READINGS.entries()) {
      const html = renderToStaticMarkup(
        createElement(InstitutionGroups, { readings: [r], narrative: null }),
      );
      const own = ROLES[i]!.instrument;
      for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(escape(q(own, n)));
      // No other instrument's consequence question appears on this card.
      for (const other of ROLES.filter((x) => x.instrument !== own)) {
        if (q(other.instrument, 4) !== q(own, 4)) {
          expect(html).not.toContain(escape(q(other.instrument, 4)));
        }
      }
    }
  });

  it('"exchange efficiency" never labels LCFE, NASD or FMDQ', () => {
    for (const r of READINGS.filter((x) => ['LCFE', 'NASD', 'FMDQ'].includes(x.code))) {
      expect(Object.values(cardLabels(r)).join(' ')).not.toMatch(/exchange efficiency/i);
    }
  });

  it('a reading frozen before labels existed gets neutral labels, not a family one', () => {
    const old = { ...READINGS[2]! };
    delete old.labels;
    expect(Object.values(cardLabels(old as InstitutionalReading)).join(' ')).not.toMatch(
      /exchange efficiency|investor protection|settlement/i,
    );
  });

  it('groups the readings by role, in order, each card under its role', () => {
    const groups = groupByRole(READINGS);
    expect(groups.map((g) => g.role)).toEqual([
      'Regulatory / Supervisory',
      'Exchange / Market Operator',
      'Clearing / Settlement',
      'Depository / Securities-account Infrastructure',
    ]);
    expect(groups[1]!.readings.map((r) => r.code)).toEqual(['NGX', 'LCFE', 'NASD', 'FMDQ']);
    const html = renderToStaticMarkup(
      createElement(InstitutionGroups, { readings: READINGS, narrative: null }),
    );
    expect(html.match(/rpt-igroup/g)).toHaveLength(4);
    expect(html.match(/rpt-icard/g)).toHaveLength(7);
  });
});

/** renderToStaticMarkup escapes apostrophes and ampersands. */
function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
}
