/**
 * Fix list 27 Oct, Group 1 — what a client reads in the published reports.
 *  BUG-17  an institution out of scope is described, never silently dropped;
 *  BUG-19  a firm SEI is withheld when the input it rests on is withheld;
 *  BUG-21  Section 08 has one base (everyone who answered), each bar its own n;
 *  BUG-22  the narrative's themes are the table's themes;
 *  BUG-23  the agenda only points at "gaps above" when it names one.
 */
import { describe, it, expect } from 'vitest';
import {
  industryFacts,
  institutionalThemes,
  sharedThemes,
  withholdUnsupportedSei,
  type IndustryReportContent,
} from '../src';
import { buildAgenda, comparatorShares, industrySeiNote } from '../src/report-content-service';
import type { Indices, InstitutionalReading } from '../src/report-content-service';

const reading = (code: string, role: string, issues: string[], consequences: string[]) =>
  ({
    key: `F_${code}`,
    role,
    code,
    familyCode: 'F',
    vantage: 'Its view',
    responses: 1,
    topIssues: [],
    issue: { greatest: issues[0] ?? null, others: issues.slice(1) },
    frequency: null,
    marks: [],
    consequence: { greatest: consequences[0] ?? null, others: consequences.slice(1) },
    capability: null,
  }) as InstitutionalReading;

function industry(
  readings: InstitutionalReading[],
  contributors: Array<{ name: string; code: string }>,
): IndustryReportContent {
  return {
    participation: [],
    frictions: null,
    frustrations: null,
    participationImpact: null,
    confidenceLevers: null,
    localVsForeign: { rows: [] },
    comparators: null,
    selfVsInvestors: { firmSelfBelief: { value: null }, investorExperience: { value: null } },
    institutional: readings,
    institutionalParticipation: { invited: contributors.length, contributed: contributors.length },
    institutionalContributors: contributors,
    institutionalThemes: institutionalThemes(readings),
  } as unknown as IndustryReportContent;
}

describe('BUG-17: an institution out of scope is described, not dropped', () => {
  it('the participation fact says how many gave a reading and who was out of scope', () => {
    const readings = [
      reading('SEC', 'Securities and Exchange Commission', ['Manual processes'], []),
      reading('NGX', 'Nigerian Exchange Limited', ['Manual processes'], []),
    ];
    const facts = industryFacts(
      industry(readings, [
        { name: 'Securities and Exchange Commission', code: 'SEC' },
        { name: 'Nigerian Exchange Limited', code: 'NGX' },
        { name: 'Lagos Commodities and Futures Exchange', code: 'LCFE' },
      ]),
    );
    const part = facts.find((f) => f.id === 'INST.PART')!;
    expect(part.statement).toMatch(/3 of 3 invited institutions contributed; 2 gave a reading/);
    expect(part.statement).toContain('LCFE');
    expect(part.statement).toMatch(/out of scope/);
    expect(part.numbers).toEqual([3, 3, 2]);
  });

  it('with every contributor read, the fact is unchanged', () => {
    const readings = [reading('SEC', 'Securities and Exchange Commission', [], [])];
    const part = industryFacts(
      industry(readings, [{ name: 'Securities and Exchange Commission', code: 'SEC' }]),
    ).find((f) => f.id === 'INST.PART')!;
    expect(part.statement).toBe('1 of 1 invited institutions contributed.');
  });
});

describe('BUG-22: the narrative names only the themes the table shows', () => {
  it('a theme one institution names alone is not a narrative theme', () => {
    const readings = [
      reading('SEC', 'Securities and Exchange Commission', ['Manual processes'], []),
      reading('NGX', 'Nigerian Exchange Limited', ['Manual processes'], []),
      reading('CSCS', 'Central Securities Clearing System', ['Late settlement'], []),
    ];
    const c = industry(readings, []);
    const table = sharedThemes(c.institutionalThemes).map((t) => t.theme);
    const facts = industryFacts(c);
    const themeFacts = facts.filter((f) => f.id.startsWith('INST.THEME.'));
    expect(table.length).toBeGreaterThan(0);
    expect(themeFacts.map((f) => f.statement.split(' is named')[0])).toEqual(table);
    expect(themeFacts.some((f) => /alone/.test(f.statement))).toBe(false);
    // The lone area stays a finding of its own.
    expect(facts.some((f) => f.id === 'INST.APART.CSCS')).toBe(true);
  });
});

describe('BUG-19: no firm SEI on a withheld input', () => {
  const indices = {
    state: 'reported',
    methodology: 'v',
    runId: 'r',
    industry: [],
    firm: [
      { code: 'IEI', name: 'Investor experience', value: null, n: 1, note: 'Withheld' },
      { code: 'SEI', name: 'Service excellence', value: 97, n: 12, note: null },
    ],
    segments: [],
    tiers: null,
    tiersNote: null,
  } as unknown as Indices;

  it('is withheld when the investor experience it rests on is withheld', () => {
    const out = withholdUnsupportedSei(indices, { value: null, n: 1 });
    const sei = out.state === 'reported' ? out.firm!.find((s) => s.code === 'SEI')! : null;
    expect(sei?.value).toBeNull();
    expect(sei?.note).toMatch(/Withheld/);
    expect(sei?.note).toMatch(/1 investor answered/);
  });

  it('is kept when that input is shown', () => {
    expect(withholdUnsupportedSei(indices, { value: 70, n: 14 })).toBe(indices);
  });

  it('industry SEI states its base: eligible firms, not a pool of investors', () => {
    expect(industrySeiNote(71)).toBe(
      'The mean of 71 firms’ own scores — only firms where at least 10 of their investors answered are counted.',
    );
  });
});

describe('BUG-21: Section 08 has one base, each bar its own n', () => {
  const row = (id: string, bank: string, apps: string) => ({
    respondentId: id,
    answer: {
      'Your primary bank': { Rating: bank },
      'Fintech or digital investment apps': { Rating: apps },
    },
  });

  it('counts an investor who could not compare in the base, not in that bar', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row(`r${i}`, 'Somewhat better', 'Somewhat worse')),
      row('only-unable', 'Unable to compare', 'Unable to compare'),
    ];
    const c = comparatorShares(rows as never)!;
    expect(c.base).toBe(11);
    expect(c.rows.find((r) => r.comparator === 'Your primary bank')!.n).toBe(10);
  });

  it('tallies each comparison from its own answers', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row(`r${i}`, 'Somewhat better', i < 5 ? 'About the same' : 'Somewhat worse'),
    );
    const c = comparatorShares(rows as never)!;
    const bank = c.rows.find((r) => r.comparator === 'Your primary bank')!;
    const apps = c.rows.find((r) => r.comparator === 'Fintech or digital investment apps')!;
    expect([bank.better, bank.same, bank.worse]).toEqual([100, 0, 0]);
    expect([apps.better, apps.same, apps.worse]).toEqual([0, 50, 50]);
  });
});

describe('BUG-23: the agenda follows the finding', () => {
  const dim = (label: string, firm: number, industryValue: number) => ({
    label,
    firm: { value: firm, n: 20 },
    industry: { value: industryValue, n: 200 },
  });

  it('a lone strength never points at "the gaps above"', () => {
    const agenda = buildAgenda(
      [dim('Ease', 80, 70), dim('Trust', 71, 70)],
      { firm: null, industry: null },
      3,
    );
    expect(agenda).toHaveLength(1);
    expect(agenda[0]!.detail).not.toMatch(/gaps above/);
  });

  it('with a gap above, the strength says to hold it while that is addressed', () => {
    const agenda = buildAgenda(
      [dim('Ease', 80, 70), dim('Trust', 60, 70)],
      { firm: null, industry: null },
      3,
    );
    expect(agenda.map((a) => a.priority)).toEqual(['high', 'sustain']);
    expect(agenda[1]!.detail).toMatch(/gaps above/);
  });
});
