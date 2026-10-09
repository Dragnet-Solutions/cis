/**
 * The report documents' computed content and their AI-drafted narrative.
 *
 * The model is a fake here — these tests pin the guarantees around the model,
 * not the model: every sentence must rest on facts it cites, may quote only the
 * numbers those facts carry, never claims cause, never quotes a BANDED figure,
 * and a held-back sentence is stored with its reason but never rendered.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  seedReferenceData,
  generateIndustryNarrative,
  getIndustryNarrative,
  ensureIndustryNarrative,
  narrativeDue,
  checkNarrativeSentence,
  sectionFinding,
  institutionalThemes,
  ratingByRespondent,
  withheldSections,
  industryNarrativeFacts,
  evaluateSection,
  NATIONAL_SECTIONS,
  industryFacts,
  type InstitutionalReading,
  type IndustryReportContent,
  parseModelSections,
  firmFacts,
  type NarrativeModel,
} from '../src';
import {
  shareCiting,
  rating,
  comparatorShares,
  buildAgenda,
  pickedOptions,
} from '../src/report-content-service';
import type { FirmReportContent } from '../src/report-content-service';
import type { NarrativeFact } from '@cis/db';
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

const FACTS = new Map<string, NarrativeFact>([
  [
    'FRUSTRATION.1',
    {
      id: 'FRUSTRATION.1',
      state: 'REPORTABLE',
      statement: '47% of retail investors (42 of 90) cite slow responses.',
      numbers: [47, 42, 90, 1],
    },
  ],
  [
    'RETAIL.1',
    {
      id: 'RETAIL.1',
      state: 'BANDED',
      statement: 'Retail ease 61/100 against industry 58/100.',
      numbers: [61, 58, 3, 100],
    },
  ],
]);

describe('The narrative checker', () => {
  it('passes a sentence whose every number its cited fact carries', () => {
    expect(
      checkNarrativeSentence(
        {
          text: 'Slow responses are cited by 47% of retail investors.',
          factIds: ['FRUSTRATION.1'],
        },
        FACTS,
      ),
    ).toBeNull();
  });

  it('holds back a sentence that cites nothing', () => {
    expect(
      checkNarrativeSentence({ text: 'Service is improving.', factIds: [] }, FACTS)?.kind,
    ).toBe('NO SUPPORTING FACT IDS');
  });

  it('holds back a number its cited facts do not carry', () => {
    const finding = checkNarrativeSentence(
      { text: 'Slow responses are cited by 52% of retail investors.', factIds: ['FRUSTRATION.1'] },
      FACTS,
    );
    expect(finding?.kind).toBe('NUMBER NOT IN CITED FACTS');
    expect(finding?.why).toContain('52');
  });

  it('holds back a causal claim the study cannot make', () => {
    expect(
      checkNarrativeSentence(
        { text: 'Investors leave because responses are slow.', factIds: ['FRUSTRATION.1'] },
        FACTS,
      )?.kind,
    ).toBe('UNSUPPORTED CAUSAL CLAIM');
  });

  it('holds back a BANDED figure quoted as a point value', () => {
    expect(
      checkNarrativeSentence(
        { text: 'Retail investors rate ease at 61% of the maximum.', factIds: ['RETAIL.1'] },
        FACTS,
      )?.kind,
    ).toBe('BANDED FACT REPORTED AS A POINT VALUE');
  });

  it('holds back a fact id it was never given', () => {
    expect(
      checkNarrativeSentence({ text: 'Firms agree.', factIds: ['MADE.UP'] }, FACTS)?.kind,
    ).toBe('UNKNOWN FACT ID');
  });

  it('holds back a figure written in words, which the digit check cannot see', () => {
    const finding = checkNarrativeSentence(
      { text: 'A third of retail investors cite slow responses.', factIds: ['FRUSTRATION.1'] },
      FACTS,
    );
    expect(finding?.kind).toBe('FIGURE WRITTEN IN WORDS');
    expect(finding?.why).toContain('third');
  });

  it('allows number words its cited fact itself uses', () => {
    const facts = new Map(FACTS);
    facts.set('TOP.1', {
      id: 'TOP.1',
      state: 'REPORTABLE',
      statement: '47% cite slow responses among their top three frustrations.',
      numbers: [47],
    });
    expect(
      checkNarrativeSentence(
        { text: 'Slow responses lead the top three frustrations at 47%.', factIds: ['TOP.1'] },
        facts,
      ),
    ).toBeNull();
  });

  it('holds back speculative or consequential wording', () => {
    expect(
      checkNarrativeSentence(
        { text: 'Slow responses are eroding investor participation.', factIds: ['FRUSTRATION.1'] },
        FACTS,
      )?.kind,
    ).toBe('UNSUPPORTED CAUSAL CLAIM');
    expect(
      checkNarrativeSentence(
        { text: 'Faster responses could restore confidence.', factIds: ['FRUSTRATION.1'] },
        FACTS,
      )?.kind,
    ).toBe('UNSUPPORTED CAUSAL CLAIM');
  });

  it('holds back a gap quoted without the direction its fact states', () => {
    const facts = new Map(FACTS);
    facts.set('SELF.1', {
      id: 'SELF.1',
      state: 'REPORTABLE',
      statement: 'Firms 54/100, investors 58/100 — a gap of 4 points, firms lower.',
      numbers: [54, 58, 4, 100],
    });
    expect(
      checkNarrativeSentence({ text: 'The industry gap is 4.', factIds: ['SELF.1'] }, facts)?.kind,
    ).toBe('GAP WITHOUT DIRECTION');
    expect(
      checkNarrativeSentence(
        {
          text: 'Firms rate themselves 4 points lower than investors, a gap of 4.',
          factIds: ['SELF.1'],
        },
        facts,
      ),
    ).toBeNull();
  });

  it('allows the edition year without a fact', () => {
    expect(
      checkNarrativeSentence(
        { text: 'In 2026, slow responses led the list.', factIds: ['FRUSTRATION.1'] },
        FACTS,
        [2026],
      ),
    ).toBeNull();
  });
});

describe('The facts the model is given', () => {
  it('says which way each Service Excellence gap runs, never just its size', () => {
    const r = (value: number) => ({ value, n: 20 });
    const content = {
      dimensions: [],
      selfVsInvestors: {
        firmSelfBelief: r(89),
        investorExperience: r(72),
        industrySelfBelief: r(54),
        industryInvestorExperience: r(58),
      },
      retailCut: { state: 'none', n: 4, dimensions: [] },
      agenda: [],
    } as unknown as FirmReportContent;
    const self = firmFacts(content).find((f) => f.id === 'SELF.1')!;
    // A firm 17 above its investors, an industry 4 below: the size alone would
    // let the narrative call both gaps the same kind of gap.
    expect(self.statement).toContain('a gap of 17 points, leadership higher');
    expect(self.statement).toContain('the gap is 4 points, firms lower than their investors');
  });
});

describe('Reading the model’s answer', () => {
  it('ignores a reasoning preamble and a fenced block around the JSON', () => {
    const parsed = parseModelSections(
      '<think>let me draft</think>\n```json\n{"sections":{"EXEC":[{"text":"A.","factIds":["X"]}]}}\n```',
    );
    expect(parsed).toEqual({ EXEC: [{ text: 'A.', factIds: ['X'] }] });
  });

  it('refuses an answer with no JSON in it', () => {
    expect(() => parseModelSections('I cannot help with that.')).toThrow(/JSON/);
  });
});

describe('Report content helpers', () => {
  it('counts a respondent once however many firms they cited it for', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      respondentId: `r${i}`,
      options: i < 4 ? ['Slow responses', 'Slow responses'] : ['Errors in records'],
    }));
    rows.push({ respondentId: 'r0', options: ['Slow responses'] }); // same person, another firm
    const shares = shareCiting(rows)!;
    expect(shares.base).toBe(10);
    expect(shares.items.find((i) => i.label === 'Slow responses')).toMatchObject({
      count: 4,
      pct: 40,
    });
  });

  it('withholds shares and ratings below ten responses', () => {
    expect(shareCiting([{ respondentId: 'a', options: ['x'] }])).toBeNull();
    expect(rating([50, 60, 70])).toEqual({ value: null, n: 3 });
    expect(rating(Array.from({ length: 10 }, () => 50)).value).toBe(50);
  });

  it('reads a select-then-greatest answer by its picked options', () => {
    expect(pickedOptions({ picked: ['A', 'B'], greatest: 'A' })).toEqual(['A', 'B']);
  });

  it('excludes "Unable to compare" from the bank / fintech comparison', () => {
    const answer = {
      'Your primary bank': { Rating: 'Somewhat worse' },
      'Fintech or digital investment apps': { Rating: 'Unable to compare' },
    };
    const rows = Array.from({ length: 10 }, (_, i) => ({
      respondentId: `r${i}`,
      instrumentCode: 'S4',
      questionId: 'S4-Q8',
      ratedFirmId: null,
      recruitingFirmId: null,
      institutionName: null,
      answer,
    }));
    expect(comparatorShares(rows)!.rows).toEqual([
      { comparator: 'Your primary bank', better: 0, same: 0, worse: 100, n: 10 },
    ]);
  });

  it('builds an agenda only from gaps larger than the margin', () => {
    const r = (value: number) => ({ value, n: 20 });
    const none = { firm: null, industry: null };
    const agenda = buildAgenda(
      [
        { label: 'Responsiveness', firm: r(50), industry: r(60) },
        { label: 'Trust in records', firm: r(70), industry: r(62) },
        { label: 'Ease of dealing', firm: r(61), industry: r(60) },
      ],
      none,
      3,
    );
    expect(agenda.map((a) => [a.priority, a.title])).toEqual([
      ['high', 'Close the responsiveness gap'],
      ['sustain', 'Protect your trust in records strength'],
    ]);
    expect(buildAgenda([{ label: 'Ease', firm: r(61), industry: r(60) }], none, 3)[0]?.title).toBe(
      'Hold your position',
    );
  });
});

describe('Generating the industry narrative', () => {
  it('stores every sentence, holding back the ones the checker rejects', async () => {
    let seenPrompt = '';
    const fake: NarrativeModel = {
      name: 'fake-model',
      async complete(system, user) {
        seenPrompt = system + user;
        return JSON.stringify({
          sections: {
            EXEC: [
              {
                text: 'The study was designed around 80 participating firms.',
                factIds: ['PART.firm'],
              },
              { text: 'Exactly 999 firms took part.', factIds: ['PART.firm'] },
              { text: 'Firms joined because the study matters.', factIds: ['PART.firm'] },
            ],
            NOT_A_SECTION: [{ text: 'Stray.', factIds: ['PART.firm'] }],
          },
        });
      },
    };

    const narrative = await generateIndustryNarrative(pool, editionId, fake, 'op@cis.example');

    // The model saw the computed facts and the rules.
    expect(seenPrompt).toContain('[PART.firm]');
    expect(seenPrompt).toContain('Never use');

    const byText = new Map(narrative.sentences.map((s) => [s.text, s.finding?.kind ?? null]));
    expect(byText.get('The study was designed around 80 participating firms.')).toBeNull();
    expect(byText.get('Exactly 999 firms took part.')).toBe('NUMBER NOT IN CITED FACTS');
    expect(byText.get('Firms joined because the study matters.')).toBe('UNSUPPORTED CAUSAL CLAIM');
    expect(byText.get('Stray.')).toBe('UNKNOWN SECTION');
    expect(narrative.model).toBe('fake-model');
    expect(narrative.createdBy).toBe('op@cis.example');

    expect((await getIndustryNarrative(pool, editionId))?.id).toBe(narrative.id);
  });

  it('a regeneration replaces the narrative in force but keeps the earlier one', async () => {
    const once = (text: string): NarrativeModel => ({
      name: 'fake-model',
      complete: async () =>
        JSON.stringify({ sections: { EXEC: [{ text, factIds: ['PART.firm'] }] } }),
    });
    await generateIndustryNarrative(pool, editionId, once('First draft.'), 'op@cis.example');
    await generateIndustryNarrative(pool, editionId, once('Second draft.'), 'op@cis.example');
    expect((await getIndustryNarrative(pool, editionId))?.sentences[0]?.text).toBe('Second draft.');
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM report_narratives',
    );
    expect(rows[0]!.n).toBe(2);
  });
});

describe('Drafting the narrative by default', () => {
  const counting = () => {
    const model = {
      calls: 0,
      name: 'fake-model',
      async complete() {
        model.calls += 1;
        return JSON.stringify({
          sections: { EXEC: [{ text: 'Drafted.', factIds: ['PART.firm'] }] },
        });
      },
    };
    return model;
  };

  it('drafts a missing narrative once, however many ask at the same moment', async () => {
    const model = counting();
    const [a, b] = await Promise.all([
      ensureIndustryNarrative(pool, editionId, () => model, 'op@cis.example'),
      ensureIndustryNarrative(pool, editionId, () => model, 'op@cis.example'),
    ]);
    expect(model.calls).toBe(1);
    expect(a?.id).toBe(b?.id);
    expect(a?.sentences[0]?.text).toBe('Drafted.');
  });

  it('leaves a narrative written from the current figures alone', async () => {
    const model = counting();
    const first = await ensureIndustryNarrative(pool, editionId, () => model, 'op@cis.example');
    const again = await ensureIndustryNarrative(
      pool,
      editionId,
      () => {
        throw new Error('the model must not be needed');
      },
      'op@cis.example',
    );
    expect(model.calls).toBe(1);
    expect(again?.id).toBe(first?.id);
  });

  it('redrafts when the figures it was written from have changed', () => {
    const fact = (statement: string): NarrativeFact => ({
      id: 'A',
      state: 'REPORTABLE',
      statement,
      numbers: [1],
    });
    const stored = { facts: [fact('Old figure.')] } as Parameters<typeof narrativeDue>[1];
    expect(narrativeDue([fact('Old figure.')], stored)).toBe(false);
    expect(narrativeDue([fact('New figure.')], stored)).toBe(true);
    expect(narrativeDue([fact('Old figure.')], null)).toBe(true);
    // Nothing to write about yet: never drafted.
    expect(narrativeDue([], null)).toBe(false);
  });
});

describe('Institutional Perspectives', () => {
  const reading = (
    code: string,
    family: string,
    issue: string[],
    consequence: string[],
  ): InstitutionalReading => ({
    key: `${family}_${code}`,
    role: `${code} institution`,
    code,
    familyCode: family,
    vantage: 'Its mandate',
    responses: 1,
    topIssues: [],
    issue: { greatest: issue[0] ?? null, others: issue.slice(1) },
    frequency: 'Occasionally',
    marks: ['Operational discipline'],
    consequence: { greatest: consequence[0] ?? null, others: consequence.slice(1) },
    capability: 'Adequate',
  });

  it('finds what institutions share from their own wording, and who stands apart', () => {
    const { themes, standsApart } = institutionalThemes([
      reading('SEC', 'A', ['Documentation and record keeping'], ['Internal controls']),
      reading('CSCS', 'C', ['Reconciliation issues'], ['Documentation deficiencies']),
      reading('CSCS', 'D', ['Securities-account record mismatches requiring investigation'], []),
      reading('LCFE', 'B', ['Staff competence'], []),
    ]);
    const doc = themes.find((t) => t.theme === 'Documentation and record keeping');
    // CSCS in two roles is still one institution.
    expect(doc?.codes).toEqual(['CSCS', 'SEC']);
    expect(standsApart).toEqual(['LCFE']);
  });

  it('gives the model each reading as a qualitative fact — never a figure', () => {
    const readings = [
      reading('SEC', 'A', ['Documentation and record keeping'], ['Internal controls']),
      reading('NGX', 'B', ['Manual processes'], ['Late submissions']),
    ];
    const content = {
      participation: [],
      frictions: null,
      frustrations: null,
      participationImpact: null,
      confidenceLevers: null,
      localVsForeign: { rows: [] },
      comparators: null,
      selfVsInvestors: { firmSelfBelief: { value: null }, investorExperience: { value: null } },
      institutional: readings,
      institutionalParticipation: { invited: 2, contributed: 2 },
      institutionalThemes: institutionalThemes(readings),
    } as unknown as IndustryReportContent;
    const facts = industryFacts(content);
    const sec = facts.find((f) => f.id === 'INST.A_SEC');
    expect(sec?.state).toBe('BANDED');
    expect(sec?.numbers).toEqual([]);
    expect(sec?.statement).toContain('Documentation and record keeping');
    expect(facts.find((f) => f.id === 'INST.PART')?.numbers).toEqual([2, 2]);
  });

  it('holds back a quotation in an institution’s reading', () => {
    expect(sectionFinding('INST_A_SEC', 'The SEC calls records “the weak point”.')?.kind).toBe(
      'QUOTATION',
    );
    expect(
      sectionFinding('INST_A_SEC', 'The SEC sees record keeping as the weak point.'),
    ).toBeNull();
    expect(sectionFinding('EXEC', 'Firms cite "Manual processes".')).toBeNull();
  });
});

describe('Withheld means withheld, in every report (E2E 9 Oct)', () => {
  it('applies the 10-response floor to people, never to ratings (D26, D30, D25)', () => {
    // 6 investors who rated many firms each: 43 ratings, still 6 people.
    const points = Array.from({ length: 43 }, (_, i) => ({ respondentId: `r${i % 6}`, value: 60 }));
    expect(ratingByRespondent(points)).toEqual({ value: null, n: 6 });
    const ten = Array.from({ length: 10 }, (_, i) => ({
      respondentId: `r${i}`,
      value: i < 5 ? 40 : 80,
    }));
    expect(ratingByRespondent(ten)).toEqual({ value: 60, n: 10 });
    // Each person counts once: one investor's 3 high ratings do not outweigh 9 others.
    const skewed = [
      ...Array.from({ length: 9 }, (_, i) => ({ respondentId: `r${i}`, value: 50 })),
      { respondentId: 'x', value: 100 },
      { respondentId: 'x', value: 100 },
      { respondentId: 'x', value: 100 },
    ];
    expect(ratingByRespondent(skewed)).toEqual({ value: 55, n: 10 });
  });

  it('draws no agenda — and claims nothing — when the investor ratings are withheld (D28)', () => {
    const withheld = { value: null, n: 4 };
    const dims = ['Ease', 'Responsiveness'].map((label) => ({
      label,
      firm: withheld,
      industry: { value: 60, n: 40 },
    }));
    expect(buildAgenda(dims, { firm: null, industry: null }, 3)).toEqual([]);
  });

  it('marks a section not publishable when the report would show nothing in it (D21)', () => {
    const content = {
      indices: { state: 'pending_methodology', note: '' },
      frictions: null,
      frustrations: { base: 12, items: [] },
      participationImpact: null,
      confidenceLevers: null,
      localVsForeign: { rows: [], localN: 0, foreignN: 0 },
      comparators: null,
      selfVsInvestors: {
        firmSelfBelief: { value: null, n: 1 },
        investorExperience: { value: 61, n: 6 },
      },
      institutional: [],
    } as unknown as IndustryReportContent;
    const withheld = withheldSections(content);
    expect(Object.keys(withheld).sort()).toEqual(
      [
        'PUB_01_HEADLINE_INDICES',
        'PUB_02_SEGMENT_IEI_ICI',
        'PUB_03_OPERATIONAL_FRICTIONS',
        'PUB_05_MATURITY_HEATMAP',
        'PUB_06_CONFIDENCE_AND_PARTICIPATION',
        'PUB_07_LOCAL_VS_FOREIGN',
        'PUB_08_CROSS_INDUSTRY_BENCHMARK',
        'PUB_09_SERVICE_EXCELLENCE_GAP',
        'PUB_10_INSTITUTIONAL_PERSPECTIVES',
      ].sort(),
    );
    const spec = NATIONAL_SECTIONS.find((x) => x.id === 'PUB_03_OPERATIONAL_FRICTIONS')!;
    const ctx = { segments: {}, regulatorsEngaged: 3, withheld };
    expect(evaluateSection(spec, ctx).disposition).toBe('suppressed');
  });

  it('caveats local vs foreign when both segments clear but are thin (D22)', () => {
    const spec = NATIONAL_SECTIONS.find((x) => x.id === 'PUB_07_LOCAL_VS_FOREIGN')!;
    const seg = { meets: true, thin: true };
    expect(
      evaluateSection(spec, {
        segments: { local_institution: seg, foreign_institution: seg },
        regulatorsEngaged: 3,
      }).disposition,
    ).toBe('caveated');
  });

  it('never gives the model the figures of a suppressed section (D24)', () => {
    const reading: InstitutionalReading = {
      key: 'A_SEC',
      role: 'Securities and Exchange Commission',
      code: 'SEC',
      familyCode: 'A',
      vantage: 'Supervision',
      responses: 1,
      topIssues: [],
      issue: { greatest: 'Client-complaints handling', others: [] },
      frequency: null,
      marks: [],
      consequence: { greatest: null, others: [] },
      capability: 'Adequate',
    };
    const content = {
      sections: [{ id: 'PUB_10_INSTITUTIONAL_PERSPECTIVES', disposition: 'suppressed' }],
      participation: [{ segment: 'firm', label: 'Firms', target: 3, achieved: 1, meets: false }],
      frictions: null,
      frustrations: null,
      participationImpact: null,
      confidenceLevers: null,
      localVsForeign: { rows: [] },
      comparators: null,
      selfVsInvestors: { firmSelfBelief: { value: null }, investorExperience: { value: null } },
      institutional: [reading],
      institutionalParticipation: { invited: 2, contributed: 1 },
      institutionalThemes: institutionalThemes([reading]),
    } as unknown as IndustryReportContent;
    const ids = industryNarrativeFacts(content).map((f) => f.id);
    expect(ids).toContain('PART.firm');
    expect(ids.some((id) => id.startsWith('INST.'))).toBe(false);
  });
});
