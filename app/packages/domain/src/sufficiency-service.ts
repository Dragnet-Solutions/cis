import type { SufficiencyState, SegmentDisplayState } from '@cis/shared-types';

/**
 * Sufficiency computation — a direct encoding of EVIDENCE_PACK_CONTRACT rules.
 * Sufficiency is computed BEFORE any evidence reaches a generator; a suppressed
 * result never carries its underlying value.
 *
 * The contract's FRM_04 (retail cut) rule, applied as the general point-value
 * thresholds:
 *   n < 10  → SUPPRESSED (nothing)
 *   10–29   → DIRECTIONAL
 *   30+     → REPORTABLE
 *
 * Binary consequence signals (proportions such as reduced willingness, delayed
 * transactions, moved assets) are a re-identification risk at small n — the
 * contract's own example notes a 30% rate at n=30 rests on nine people. Those
 * metrics are BANDED (a band, never a point value) whenever they clear the
 * suppression floor, and SUPPRESSED below it.
 */

export const SUPPRESS_BELOW = 10;
export const REPORTABLE_AT = 30;

export function computeSufficiency(
  n: number,
  opts: { binaryConsequenceSignal?: boolean } = {},
): SufficiencyState {
  if (n < SUPPRESS_BELOW) return 'SUPPRESSED';
  if (opts.binaryConsequenceSignal) return 'BANDED';
  return n >= REPORTABLE_AT ? 'REPORTABLE' : 'DIRECTIONAL';
}

/**
 * A coarse band for a proportion — never the exact rate. Deliberately wide
 * buckets so a band can never be inverted to a person count at small n.
 */
export function bandForProportion(rate: number): string {
  if (rate < 0.1) return 'under 10%';
  if (rate < 0.25) return '10–25%';
  if (rate < 0.5) return '25–50%';
  if (rate < 0.75) return '50–75%';
  return '75% or more';
}

/**
 * Phase 21 §2.1 (v0.15) — a segment's STANDALONE display state, collapsed
 * from `computeSufficiency()`'s five-state ladder (never a re-derived
 * threshold): REPORTABLE and SUPPRESSED map directly; DIRECTIONAL and BANDED
 * both collapse to SHOWN_DIRECTIONALLY (shown, not at full precision);
 * NOT_CALCULABLE collapses to SUPPRESSED (no result to display either way).
 */
export function segmentDisplayState(
  n: number,
  opts: { binaryConsequenceSignal?: boolean } = {},
): SegmentDisplayState {
  const s = computeSufficiency(n, opts);
  if (s === 'REPORTABLE') return 'REPORTABLE';
  if (s === 'DIRECTIONAL' || s === 'BANDED') return 'SHOWN_DIRECTIONALLY';
  return 'SUPPRESSED';
}

/** Sufficiency states whose fact carries an actual point value a reader could
 *  subtract with — REPORTABLE and DIRECTIONAL. BANDED is a bucket, never a
 *  point value (enforced in `evidence-pack-service.ts`); SUPPRESSED and
 *  NOT_CALCULABLE carry no value at all. */
const CARRIES_POINT_VALUE: ReadonlySet<SufficiencyState> = new Set(['REPORTABLE', 'DIRECTIONAL']);

export interface ReconstructabilityMember {
  /** Distinguishes the group's total row from its individual segment rows. */
  isTotal?: boolean;
  sufficiencyState: SufficiencyState;
}

/**
 * Strict non-reconstructability check (Phase 21 §2.1). A single SUPPRESSED
 * segment is reconstructable — and so must be rejected — the moment every
 * OTHER member of its group (every sibling segment, plus the group's total)
 * carries an exact point value: total minus the sum of every visible sibling
 * uniquely determines the suppressed value. Two or more SUPPRESSED siblings
 * are safe (one equation, multiple unknowns); a BANDED or otherwise
 * non-value-carrying sibling is safe (it contributes no exact subtrahend).
 */
export function isSegmentGroupReconstructable(
  members: readonly ReconstructabilityMember[],
): boolean {
  const total = members.find((m) => m.isTotal);
  const siblings = members.filter((m) => !m.isTotal);
  if (!total || !CARRIES_POINT_VALUE.has(total.sufficiencyState)) return false;

  const suppressedSiblings = siblings.filter((m) => m.sufficiencyState === 'SUPPRESSED');
  if (suppressedSiblings.length !== 1) return false;

  const otherSiblings = siblings.filter((m) => m.sufficiencyState !== 'SUPPRESSED');
  return otherSiblings.every((m) => CARRIES_POINT_VALUE.has(m.sufficiencyState));
}
