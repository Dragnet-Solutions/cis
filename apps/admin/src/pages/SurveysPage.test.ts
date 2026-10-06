/**
 * QA F2 — the Surveys lede hardcoded "Nine instruments" while the register
 * holds ten (I-DEP, Family D, was added in Phase 19). It now counts the data.
 */
import { describe, it, expect } from 'vitest';
import { instrumentSummary } from './SurveysPage';

const scored = (n: number) => Array.from({ length: n }, () => ({ scored: true }));
const contextual = (n: number) => Array.from({ length: n }, () => ({ scored: false }));

describe('instrumentSummary', () => {
  it('describes the current register: six scored, four contextual', () => {
    expect(instrumentSummary([...scored(6), ...contextual(4)])).toBe(
      'Ten instruments. Six are scored; four are contextual and never enter an index.',
    );
  });

  it('still reads correctly for the original nine', () => {
    expect(instrumentSummary([...scored(6), ...contextual(3)])).toBe(
      'Nine instruments. Six are scored; three are contextual and never enter an index.',
    );
  });

  it('handles a single contextual instrument and an all-scored set', () => {
    expect(instrumentSummary([...scored(2), ...contextual(1)])).toBe(
      'Three instruments. Two are scored; one is contextual and never enters an index.',
    );
    expect(instrumentSummary(scored(3))).toBe('Three instruments. All are scored.');
  });
});
