import { describe, expect, it } from 'vitest';
import { isAnswered, type SurveyItem } from '@cis/survey';
import { generateAnswer, optionGoodness, type Persona } from '../src/answers';
import { Rng } from '../src/rng';

// Items shaped like the real Survey Register rows (one per kind / variant).
const base = { scope: 'shared' as const, isDrgOps: false, scored: true };
const ITEMS: SurveyItem[] = [
  { ...base, id: 'S4-Q1', kind: 'scale', text: 'Ease', scaleMin: 1, scaleMax: 10 },
  { ...base, id: 'S4-Q11', kind: 'scale', text: 'NPS', scaleMin: 0, scaleMax: 10 },
  {
    ...base,
    id: 'S1-Q6',
    kind: 'single',
    text: 'Escalations',
    options: ['Very frequently', 'Frequently', 'Occasionally', 'Rarely', 'Never'],
  },
  {
    ...base,
    id: 'S2-Q6',
    kind: 'single',
    text: 'Documentation',
    options: ['Yes, more than once', 'Yes, once', 'No', "Don't know"],
  },
  { ...base, id: 'S4-Q5', kind: 'yesno', text: 'Reduced', options: ['Yes', 'No'] },
  {
    ...base,
    id: 'S5a-Q4',
    kind: 'yesno',
    text: 'Failures',
    options: ['Yes', 'No'],
    conditionalDetailOn: 'Yes',
  },
  {
    ...base,
    id: 'S2-Q2',
    kind: 'select',
    text: 'Burden',
    options: ['A', 'B', 'C', 'D', 'E'],
    selectUpToN: 3,
  },
  {
    ...base,
    id: 'I-SEC-Q1',
    kind: 'select',
    text: 'Issues',
    options: ['A', 'B', 'C', 'D'],
    selectUpToN: 3,
    selectThenGreatest: true,
  },
  { ...base, id: 'S3-Q3', kind: 'multi', text: 'Tools', options: ['A', 'B', 'C', 'D', 'E', 'F'] },
  {
    ...base,
    id: 'S1-Q1',
    kind: 'rank',
    text: 'Rank',
    options: ['A', 'B', 'C', 'D', 'E'],
    rankExactlyN: 3,
  },
  {
    ...base,
    id: 'S3-Q4',
    kind: 'grid',
    text: 'Processes',
    gridRows: ['Onboarding', 'Transfers'],
    gridDimensions: {
      Risk: ['Very low', 'Low', 'Moderate', 'High', 'Very high'],
      Performance: ['Poor', 'Below average', 'Average', 'Good', 'Excellent'],
    },
  },
  {
    ...base,
    id: 'S5a-Q1',
    kind: 'grid',
    text: 'Rate',
    gridRows: ['Service quality', 'Reporting quality'],
    gridScale: { min: 1, max: 10 },
  },
  {
    ...base,
    id: 'S4-Q8',
    kind: 'grid',
    text: 'Compare',
    gridRows: ['Your primary bank', 'Fintech'],
    options: [
      'Significantly better',
      'Somewhat better',
      'About the same',
      'Somewhat worse',
      'Significantly worse',
    ],
  },
  { ...base, id: 'S1-Q7', kind: 'open', text: 'Issue' },
  { ...base, id: 'S4-Q10', kind: 'open', text: 'Improvement', answerOptional: true },
];

const PERSONAS: Persona[] = [
  { kind: 'normal' },
  { kind: 'speeder' },
  { kind: 'straightliner', position: 0 },
  { kind: 'straightliner', position: 0.5 },
  { kind: 'straightliner', position: 1 },
];

describe('generateAnswer', () => {
  it.each(ITEMS.map((i) => [i.id, i] as const))(
    'answers %s completely for every persona, as the server will check it',
    (_id, item) => {
      for (const persona of PERSONAS) {
        for (let n = 0; n < 40; n++) {
          const rng = new Rng(`${item.id}:${persona.kind}:${n}`);
          const answer = generateAnswer(item, { rng, persona, goodness: n / 39 });
          if (answer === null) {
            expect(item.answerOptional).toBe(true);
            continue;
          }
          expect(isAnswered(item, answer)).toBe(true);
        }
      }
    },
  );

  it('uses only offered options, and the shapes the renderer writes', () => {
    const rng = new Rng('shapes');
    const ctx = { rng, persona: { kind: 'normal' } as Persona, goodness: 0.5 };
    const byId = (id: string): SurveyItem => ITEMS.find((i) => i.id === id)!;

    expect(typeof generateAnswer(byId('S4-Q1'), ctx)!.a).toBe('number');
    const yn = generateAnswer(byId('S4-Q5'), ctx)!.a as { v: string };
    expect(['Yes', 'No']).toContain(yn.v);
    const sel = generateAnswer(byId('S2-Q2'), ctx)!.a as string[];
    expect(sel.length).toBeGreaterThanOrEqual(1);
    expect(sel.length).toBeLessThanOrEqual(3);
    expect(new Set(sel).size).toBe(sel.length);
    const greatest = generateAnswer(byId('I-SEC-Q1'), ctx)!.a as {
      picked: string[];
      greatest: string;
    };
    expect(greatest.picked).toContain(greatest.greatest);
    const rank = generateAnswer(byId('S1-Q1'), ctx)!.a as string[];
    expect(new Set(rank).size).toBe(3);
    const grid = generateAnswer(byId('S5a-Q1'), ctx)!.a as Record<string, Record<string, string>>;
    expect(Object.keys(grid)).toEqual(['Service quality', 'Reporting quality']);
    expect(typeof grid['Service quality']!['Rating']).toBe('string');
    const g3 = generateAnswer(byId('S3-Q4'), ctx)!.a as Record<string, Record<string, string>>;
    expect(Object.keys(g3['Onboarding']!)).toEqual(['Risk', 'Performance']);
  });

  it('gives the conditional detail only when the answer asks for it', () => {
    const item = ITEMS.find((i) => i.id === 'S5a-Q4')!;
    for (let n = 0; n < 50; n++) {
      const a = generateAnswer(item, {
        rng: new Rng(n),
        persona: { kind: 'normal' },
        goodness: 0.1,
      })!.a as { v: string; detail?: string };
      if (a.v === 'Yes') expect(a.detail?.trim()).toBeTruthy();
      else expect(a.detail).toBeUndefined();
    }
  });

  it('tilts ratings with the firm’s quality (good firms score higher)', () => {
    const scale = ITEMS.find((i) => i.id === 'S4-Q1')!;
    const yesno = ITEMS.find((i) => i.id === 'S4-Q5')!;
    const mean = (g: number): number => {
      let s = 0;
      for (let n = 0; n < 300; n++) {
        s += generateAnswer(scale, {
          rng: new Rng(`m${g}${n}`),
          persona: { kind: 'normal' },
          goodness: g,
        })!.a as number;
      }
      return s / 300;
    };
    expect(mean(0.9)).toBeGreaterThan(mean(0.2) + 4);
    const adverse = (g: number): number => {
      let s = 0;
      for (let n = 0; n < 400; n++) {
        const a = generateAnswer(yesno, {
          rng: new Rng(`y${g}${n}`),
          persona: { kind: 'normal' },
          goodness: g,
        })!.a as { v: string };
        if (a.v === 'Yes') s++;
      }
      return s / 400;
    };
    expect(adverse(0.1)).toBeGreaterThan(adverse(0.9) + 0.25);
  });

  it('inverts the negative scales (a high number is bad)', () => {
    const neg: SurveyItem = {
      ...base,
      id: 'S1-Q5',
      kind: 'scale',
      text: 'x',
      scaleMin: 1,
      scaleMax: 10,
    };
    const v = generateAnswer(neg, { rng: new Rng(1), persona: { kind: 'normal' }, goodness: 1 })!
      .a as number;
    expect(v).toBeLessThanOrEqual(3);
  });

  it('a straight-liner gives the same position on every item', () => {
    const persona: Persona = { kind: 'straightliner', position: 1 };
    const ctx = { rng: new Rng('sl'), persona, goodness: 0.5 };
    expect(generateAnswer(ITEMS[0]!, ctx)!.a).toBe(10);
    expect(generateAnswer(ITEMS[1]!, ctx)!.a).toBe(10);
    expect(generateAnswer(ITEMS[2]!, ctx)!.a).toBe('Never');
    const grid = generateAnswer(
      ITEMS.find((i) => i.id === 'S4-Q8')!,
      ctx,
    )!.a as Record<string, Record<string, string>>;
    expect(Object.values(grid).map((r) => r['Rating'])).toEqual([
      'Significantly worse',
      'Significantly worse',
    ]);
    const first: Persona = { kind: 'straightliner', position: 0 };
    expect(generateAnswer(ITEMS[1]!, { ...ctx, persona: first })!.a).toBe(0);
    expect(generateAnswer(ITEMS[4]!, { ...ctx, persona: first })!.a).toEqual({ v: 'Yes' });
  });

  it('is deterministic for the same seed', () => {
    const run = (): unknown[] =>
      ITEMS.map((i) =>
        generateAnswer(i, { rng: new Rng('same'), persona: { kind: 'normal' }, goodness: 0.4 }),
      );
    expect(run()).toEqual(run());
  });
});

describe('optionGoodness', () => {
  it('orders the scoring transforms’ labels', () => {
    expect(optionGoodness('Never')).toBe(1);
    expect(optionGoodness('Very frequently')).toBe(0);
    expect(optionGoodness('Very strong')).toBeGreaterThan(optionGoodness('Weak')!);
    expect(optionGoodness('0 to 10%')).toBeGreaterThan(optionGoodness('51 to 75%')!);
    expect(optionGoodness('More than 90%')).toBeLessThan(optionGoodness('76 to 90%')!);
    expect(optionGoodness('Onboarding')).toBeNull();
  });
});
