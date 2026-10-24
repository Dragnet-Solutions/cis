/**
 * D-23: the respondent's place survives a reload and a return to /survey on
 * the same device — the address carries the journey's recovery token, and the
 * device remembers it until the survey is sent.
 */
import { describe, it, expect } from 'vitest';
import {
  RESUME_STORAGE_KEY,
  forgetPlace,
  recalledPlace,
  rememberPlace,
  resumeSearch,
  type PlaceStore,
} from './resumePlace';

function memoryStore(): PlaceStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('resumeSearch', () => {
  it('points a reload at the same resume route the emailed link uses', () => {
    expect(new URLSearchParams(resumeSearch('tok-1', null)).get('resume')).toBe('tok-1');
  });
  it('keeps a firm outreach link alongside, so its finish still counts', () => {
    const q = new URLSearchParams(resumeSearch('tok-1', 'ref-9'));
    expect(q.get('resume')).toBe('tok-1');
    expect(q.get('ref')).toBe('ref-9');
  });
});

describe('device memory', () => {
  it('remembers the journey, then forgets it once sent', () => {
    const store = memoryStore();
    expect(recalledPlace(store)).toBeNull();
    rememberPlace(store, 'tok-1');
    expect(store.data.get(RESUME_STORAGE_KEY)).toBe('tok-1');
    expect(recalledPlace(store)).toBe('tok-1');
    forgetPlace(store);
    expect(recalledPlace(store)).toBeNull();
  });

  it('never throws when storage is blocked', () => {
    const blocked: PlaceStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => rememberPlace(blocked, 't')).not.toThrow();
    expect(recalledPlace(blocked)).toBeNull();
    expect(() => forgetPlace(blocked)).not.toThrow();
    expect(recalledPlace(null)).toBeNull();
  });
});
