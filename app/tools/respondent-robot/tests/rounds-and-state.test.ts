import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  isLocalUrl,
  parseDuration,
  parseRate,
  parseRegulatorLinks,
  parseThink,
} from '../src/config';
import { buildPlan, DEFAULT_PLAN_OPTIONS } from '../src/plan';
import { Rng } from '../src/rng';
import { regulatorKey, roundTasks, selectRound, startOffsets } from '../src/schedule';
import { countsByInstrument, incompatibility, loadState, newState, saveState } from '../src/state';

const firms = Array.from({ length: 8 }, (_, i) => ({
  id: `firm-${i}`,
  displayName: `[Test] F${i}`,
}));
const plan = buildPlan(firms, {
  ...DEFAULT_PLAN_OPTIONS,
  seed: 's',
  targets: { firms: 8, retail: 120, local: 6, foreign: 4, regulators: 4 },
});
const tokens = ['tok-a', 'tok-b', 'tok-c', 'tok-d'];
const run = { baseUrl: 'http://localhost:3411', editionId: 'ed', seed: 's' };

describe('rounds', () => {
  it('a 30% round then the rest covers everything exactly once', () => {
    const state = newState({ ...run, firms });
    const first = selectRound(plan, state, 0.3, tokens);
    expect(first.retail).toHaveLength(36);
    expect(first.seats).toHaveLength(7);
    expect(first.regulators).toHaveLength(1);
    const seen = new Set<string>();
    for (const t of roundTasks(first, 's')) {
      seen.add(t.key);
      state.respondents[t.key] = { status: 'submitted', instrument: 'x', attempts: 1 };
    }
    // Re-running the same round does nothing more.
    expect(roundTasks(selectRound(plan, state, 0.3, tokens), 's')).toHaveLength(0);
    const rest = roundTasks(selectRound(plan, state, 1, tokens), 's');
    for (const t of rest) {
      expect(seen.has(t.key)).toBe(false);
      seen.add(t.key);
    }
    expect(seen.size).toBe(24 + 120 + 6 + 4 + 4);
  });

  it('retries a started or failed respondent in the next run', () => {
    const state = newState({ ...run, firms });
    const key = plan.retail[0]!.key;
    state.respondents[key] = {
      status: 'failed',
      instrument: 'S4',
      attempts: 1,
      respondentId: 'r1',
    };
    expect(selectRound(plan, state, 0.3, []).retail.map((r) => r.key)).toContain(key);
  });

  it('paces starts over the duration, in order, with jitter', () => {
    const offs = startOffsets(100, { durationMs: 3_600_000, ratePerMin: 1 }, new Rng(1));
    expect(offs).toHaveLength(100);
    expect(offs[0]!).toBeGreaterThanOrEqual(0);
    expect(offs[99]!).toBeLessThanOrEqual(3_600_000);
    expect([...offs].sort((a, b) => a - b)).toEqual(offs);
    const byRate = startOffsets(10, { durationMs: null, ratePerMin: 60 }, new Rng(1));
    expect(byRate[9]!).toBeLessThanOrEqual(10_000);
  });
});

describe('state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robot-state-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips atomically and counts per instrument', () => {
    const path = join(dir, 'nested', 'state.json');
    const s = newState({ ...run, firms });
    s.respondents['retail:0001'] = { status: 'submitted', instrument: 'S4', attempts: 1 };
    s.respondents['retail:0002'] = {
      status: 'started',
      instrument: 'S4',
      attempts: 1,
      respondentId: 'x',
    };
    s.respondents['seat:a:S1'] = { status: 'failed', instrument: 'S1', attempts: 2 };
    saveState(path, s);
    const back = loadState(path)!;
    expect(back.respondents).toEqual(s.respondents);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
    expect(countsByInstrument(back)).toEqual({
      S4: { started: 1, submitted: 1, failed: 0 },
      S1: { started: 0, submitted: 0, failed: 1 },
    });
    expect(loadState(join(dir, 'missing.json'))).toBeNull();
  });

  it('refuses a state file from another API, edition or seed', () => {
    const s = newState({ ...run, firms });
    expect(incompatibility(s, run)).toBeNull();
    expect(incompatibility(s, { ...run, editionId: 'other' })).toMatch(/edition/);
    expect(incompatibility(s, { ...run, seed: 'x' })).toMatch(/seed/);
    expect(incompatibility(s, { ...run, baseUrl: 'https://x' })).toMatch(/against/);
  });
});

describe('config parsing', () => {
  it('parses durations, rates and think times', () => {
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1500ms')).toBe(1500);
    expect(() => parseDuration('soon')).toThrow();
    expect(parseRate('20/min')).toBe(20);
    expect(parseRate('2/s')).toBe(120);
    expect(parseRate('600/h')).toBe(10);
    expect(parseThink('2s-8s')).toEqual([2000, 8000]);
    expect(parseThink('0')).toEqual([0, 0]);
  });

  it('reads regulator links in any form the Regulators screen gives', () => {
    const text = [
      '# links',
      'SEC A: https://dev-cis.idhub.ng/survey?resume=11111111-1111-4111-8111-111111111111',
      '/journeys/resume/22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      'I-DEP = 33333333-3333-4333-8333-333333333333',
    ].join('\n');
    expect(parseRegulatorLinks(text)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]);
    expect(regulatorKey('11111111-1111-4111-8111-111111111111')).toBe('regulator:111111111111');
  });

  it('treats only this machine as local', () => {
    expect(isLocalUrl('http://localhost:3411')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:3411/api')).toBe(true);
    expect(isLocalUrl('https://dev-cis.idhub.ng/api')).toBe(false);
  });
});
