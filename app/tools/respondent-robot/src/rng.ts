/**
 * Deterministic pseudo-random numbers. Every random choice the robot makes is
 * drawn from an `Rng` seeded from the run's `--seed` plus a stable key (a firm
 * id, a respondent's plan key), so a plan — and the answers each planned
 * respondent gives — can be reproduced exactly.
 *
 * Not for anything secret: coordinator PINs come from `node:crypto` instead.
 */

/** 32-bit string hash (cyrb53-style mix, truncated) used to derive seeds. */
export function hashString(input: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  }

  /** A child generator for a sub-key — independent of how much of this one was used. */
  static derive(seed: string, ...keys: Array<string | number>): Rng {
    return new Rng(hashString([seed, ...keys].join('␟')));
  }

  /** Uniform in [0, 1) — mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal (Box–Muller). */
  normal(mean = 0, sd = 1): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** A new array, Fisher–Yates shuffled. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** `k` distinct items, uniformly. */
  sample<T>(items: readonly T[], k: number): T[] {
    return this.shuffle(items).slice(0, Math.max(0, Math.min(k, items.length)));
  }

  /** Index chosen with probability proportional to its (non-negative) weight. */
  weightedIndex(weights: readonly number[]): number {
    const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
    if (total <= 0) return Math.floor(this.next() * weights.length);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i] ?? 0);
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
