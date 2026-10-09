/**
 * CIS-SCORE-2026 v0.15 candidate methodology — Phase 11 PURE-function DoD.
 * No database: transform binding, the privacy-safe pooled headline, like-for-like
 * cross-edition recalculation, the Industry-SEI NOT_CALCULABLE methodology block,
 * the §11 investor-side item-level completeness predicates, and the mission-board
 * wiring of conditions 7/8 to the item-level complete forecasts. Every value is
 * read from the sole authoritative YAML config.
 */
import { describe, it, expect } from 'vitest';
import type { MissionSegment, SegmentForecast } from '@cis/shared-types';
import {
  scoreItem,
  scoreS3Q4Composite,
  pooledHeadline,
  canCompareHeadlinesDirectly,
  computeLikeForLike,
  evaluateBoard,
  segmentDisplayState,
  isSegmentGroupReconstructable,
  retailIeiEligible,
  retailIciEligible,
  localIeiEligible,
  localIciEligible,
  foreignIeiEligible,
  foreignIciEligible,
  retailIeiRelationshipScore,
  retailIciRelationshipScore,
  localIeiRelationshipScore,
  localIciRelationshipScore,
  foreignIeiUnitScore,
  foreignIciUnitScore,
  foreignIeiFirmSpecificObservation,
  foreignIciFirmSpecificObservation,
  type BoardContext,
  type EditionSegmentEvidence,
} from '../src';
import { methodologyVersionString } from '@cis/db';

describe('Transform binding (N1–N8) — direction lives only in the binding', () => {
  it('scores the canonical spot-check items direction-correctly', () => {
    // N1 positive_1_10 (S1-Q2): ((x-1)/9)*100
    expect(scoreItem('S1-Q2', '10')).toBe(100);
    expect(scoreItem('S1-Q2', '1')).toBe(0);
    // N2 negative_1_10 (S1-Q5): ((10-x)/9)*100 — direction reversed by the transform
    expect(scoreItem('S1-Q5', '1')).toBe(100);
    expect(scoreItem('S1-Q5', '10')).toBe(0);
    // N3 adverse_frequency (S1-Q6)
    expect(scoreItem('S1-Q6', 'Never')).toBe(100);
    expect(scoreItem('S1-Q6', 'Very frequently')).toBe(0);
    // N4 manual_process_band (S3-Q2): 100 - midpoint
    expect(scoreItem('S3-Q2', '0-10%')).toBe(95);
    expect(scoreItem('S3-Q2', 'More than 90%')).toBe(5);
    // N8 adverse_yes_no (S4-Q5)
    expect(scoreItem('S4-Q5', 'No')).toBe(100);
    expect(scoreItem('S4-Q5', 'Yes')).toBe(0);
  });

  it('a missing / non-substantive answer is MISSING (null), never neutral', () => {
    expect(scoreItem('S1-Q2', "Don't know")).toBeNull();
    expect(scoreItem('S1-Q2', '')).toBeNull();
    expect(scoreItem('S1-Q2', 'Not applicable')).toBeNull();
    // An unbound item has no score.
    expect(scoreItem('S9-Q99', '10')).toBeNull();
  });
});

describe('Pooled public headline — plain unit mean over reportable segments', () => {
  it('excludes sub-floor segments entirely and uses NO equal-third weighting', () => {
    const result = pooledHeadline('IEI', [
      { segment: 'A', label: 'retail', unitScores: [100, 100, 100], reportabilityFloor: 3 },
      { segment: 'B', label: 'local institutions', unitScores: [0, 0], reportabilityFloor: 2 },
      { segment: 'C', label: 'foreign institutions', unitScores: [50], reportabilityFloor: 3 },
    ]);
    // Plain mean over units = (100+100+100+0+0)/5 = 60 — NOT the mean of segment
    // means (100+0)/2 = 50. Segment C (sub-floor) contributes to neither the
    // numerator nor the denominator.
    expect(result.headline).toBe(60);
    expect(result.totalUnits).toBe(5);
    expect(result.excludedSegments).toEqual(['C']);
    expect(result.composition).toHaveLength(2);
    // The composition disclosure is a mandatory structured field, never optional.
    expect(result.disclosure).toContain('5 reportable investor units');
    expect(result.disclosure).toContain('retail');
    expect(result.disclosure).toContain('local institutions');
  });

  it('is not reportable when no segment clears its floor', () => {
    const result = pooledHeadline('ICI', [
      { segment: 'A', label: 'retail', unitScores: [70], reportabilityFloor: 15 },
    ]);
    expect(result.headline).toBeNull();
    expect(result.disclosure).toContain('not reportable');
  });

  it('computes standalone display state independently of pooling eligibility (Phase 21 §2.1)', () => {
    const result = pooledHeadline('IEI', [
      { segment: 'A', label: 'retail', unitScores: [100, 100, 100], reportabilityFloor: 3 },
      { segment: 'B', label: 'local institutions', unitScores: [0, 0], reportabilityFloor: 2 },
      { segment: 'C', label: 'foreign institutions', unitScores: [50], reportabilityFloor: 3 },
    ]);
    // A pools (n=3 clears its own reportabilityFloor of 3) but at n=3 it is
    // SUPPRESSED standalone (below the shared segmentDisplayState floor of
    // 10) — pooling inclusion and standalone display are genuinely separate
    // decisions, not the same gate read twice.
    expect(result.excludedSegments).not.toContain('A');
    expect(result.standaloneState['A']).toBe('SUPPRESSED');
    expect(result.standaloneState['B']).toBe('SUPPRESSED');
    // C is excluded from pooling (n=1 < its own floor of 3) but its
    // standalone state is reported too, on the same independent axis.
    expect(result.excludedSegments).toContain('C');
    expect(result.standaloneState['C']).toBe('SUPPRESSED');
  });
});

describe('Segment display state (Phase 21 §2.1)', () => {
  it('collapses the sufficiency ladder to REPORTABLE / SHOWN_DIRECTIONALLY / SUPPRESSED', () => {
    expect(segmentDisplayState(9)).toBe('SUPPRESSED');
    expect(segmentDisplayState(10)).toBe('SHOWN_DIRECTIONALLY');
    expect(segmentDisplayState(29)).toBe('SHOWN_DIRECTIONALLY');
    expect(segmentDisplayState(30)).toBe('REPORTABLE');
    // A binary-consequence signal is BANDED at any n above the floor — still
    // SHOWN_DIRECTIONALLY, never REPORTABLE (never a point value).
    expect(segmentDisplayState(50, { binaryConsequenceSignal: true })).toBe('SHOWN_DIRECTIONALLY');
    expect(segmentDisplayState(5, { binaryConsequenceSignal: true })).toBe('SUPPRESSED');
  });
});

describe('Strict segment non-reconstructability (Phase 21 §2.1)', () => {
  it('flags a lone SUPPRESSED segment as reconstructable against an exact total and exact siblings', () => {
    expect(
      isSegmentGroupReconstructable([
        { sufficiencyState: 'REPORTABLE' },
        { sufficiencyState: 'REPORTABLE' },
        { sufficiencyState: 'SUPPRESSED' },
        { isTotal: true, sufficiencyState: 'REPORTABLE' },
      ]),
    ).toBe(true);
  });

  it('is safe once the total is withheld', () => {
    expect(
      isSegmentGroupReconstructable([
        { sufficiencyState: 'REPORTABLE' },
        { sufficiencyState: 'REPORTABLE' },
        { sufficiencyState: 'SUPPRESSED' },
      ]),
    ).toBe(false);
  });

  it('is safe with two or more SUPPRESSED siblings (one equation, multiple unknowns)', () => {
    expect(
      isSegmentGroupReconstructable([
        { sufficiencyState: 'REPORTABLE' },
        { sufficiencyState: 'SUPPRESSED' },
        { sufficiencyState: 'SUPPRESSED' },
        { isTotal: true, sufficiencyState: 'REPORTABLE' },
      ]),
    ).toBe(false);
  });

  it('is safe when a non-suppressed sibling is BANDED (carries no exact value)', () => {
    expect(
      isSegmentGroupReconstructable([
        { sufficiencyState: 'BANDED' },
        { sufficiencyState: 'SUPPRESSED' },
        { isTotal: true, sufficiencyState: 'REPORTABLE' },
      ]),
    ).toBe(false);
  });

  it('a DIRECTIONAL sibling still carries a point value, so reconstruction still applies', () => {
    expect(
      isSegmentGroupReconstructable([
        { sufficiencyState: 'DIRECTIONAL' },
        { sufficiencyState: 'SUPPRESSED' },
        { isTotal: true, sufficiencyState: 'REPORTABLE' },
      ]),
    ).toBe(true);
  });
});

describe('§11 investor-side item-level completeness (v0.15 follow-up)', () => {
  it('Retail IEI requires ALL of S4-Q1/Q2/Q3 — no partial allowance', () => {
    expect(retailIeiEligible({ q1: '8', q2: '9', q3: '7' })).toBe(true);
    expect(retailIeiEligible({ q1: '8', q2: '9', q3: null })).toBe(false);
    expect(retailIeiEligible({ q1: '8', q2: "Don't know", q3: '7' })).toBe(false);
  });

  it('Retail ICI requires Q4 PLUS at least 2 of the Q5-Q7 behavioural bundle', () => {
    // Full completeness clears it.
    expect(retailIciEligible({ q4: '8', q5: 'Yes', q6: 'No', q7: 'Yes' })).toBe(true);
    // Exactly 2 of 3 — the explicit partial allowance §11 grants.
    expect(retailIciEligible({ q4: '8', q5: 'Yes', q6: 'No', q7: null })).toBe(true);
    expect(retailIciEligible({ q4: '8', q5: null, q6: 'No', q7: 'Yes' })).toBe(true);
    // Only 1 of 3 — below the allowance, correctly excluded.
    expect(retailIciEligible({ q4: '8', q5: 'Yes', q6: null, q7: null })).toBe(false);
    // Q4 itself is never optional, even with all three behavioural items present.
    expect(retailIciEligible({ q4: null, q5: 'Yes', q6: 'No', q7: 'Yes' })).toBe(false);
  });

  it('Local IEI requires at least 3 of the 4 S5a-Q1 attributes, PLUS S5a-Q2', () => {
    // All 4 attributes present.
    expect(localIeiEligible({ q1Attributes: ['8', '7', '9', '6'], q2: '5' })).toBe(true);
    // Exactly 3 of 4 — the explicit partial allowance §11 grants.
    expect(localIeiEligible({ q1Attributes: ['8', '7', '9', null], q2: '5' })).toBe(true);
    // Only 2 of 4 — below the allowance, correctly excluded.
    expect(localIeiEligible({ q1Attributes: ['8', '7', null, null], q2: '5' })).toBe(false);
    // 3 of 4 attributes but Q2 missing — still ineligible, Q2 is never optional.
    expect(localIeiEligible({ q1Attributes: ['8', '7', '9', null], q2: null })).toBe(false);
  });

  it('Local ICI requires BOTH S5a-Q5 and S5a-Q6 — no partial allowance', () => {
    expect(localIciEligible({ q5: 'Yes', q6: 'No' })).toBe(true);
    expect(localIciEligible({ q5: 'Yes', q6: null })).toBe(false);
    expect(localIciEligible({ q5: null, q6: 'No' })).toBe(false);
  });

  it('Foreign IEI requires S5b-Q1 PLUS both aggregated Q2 and Q3 — an absent aggregate fails it', () => {
    expect(foreignIeiEligible({ q1: '8', aggregatedQ2: 70, aggregatedQ3: 65 })).toBe(true);
    expect(foreignIeiEligible({ q1: '8', aggregatedQ2: null, aggregatedQ3: 65 })).toBe(false);
    expect(foreignIeiEligible({ q1: '8', aggregatedQ2: 70, aggregatedQ3: null })).toBe(false);
    expect(foreignIeiEligible({ q1: null, aggregatedQ2: 70, aggregatedQ3: 65 })).toBe(false);
  });

  it('Foreign ICI requires aggregated Q4 PLUS S5b-Q8 — an absent aggregate fails it', () => {
    expect(foreignIciEligible({ aggregatedQ4: 55, q8: 'Yes' })).toBe(true);
    expect(foreignIciEligible({ aggregatedQ4: null, q8: 'Yes' })).toBe(false);
    expect(foreignIciEligible({ aggregatedQ4: 55, q8: null })).toBe(false);
  });
});

describe('Like-for-like cross-edition recalculation', () => {
  it('refuses direct comparison when reportable segment sets differ', () => {
    expect(canCompareHeadlinesDirectly(['retail', 'local'], ['retail', 'local'])).toBe(true);
    expect(canCompareHeadlinesDirectly(['retail', 'local'], ['retail'])).toBe(false);
  });

  it('recomputes both editions on the common segment set, preserving originals', () => {
    const a: EditionSegmentEvidence = {
      reportable: ['retail', 'local', 'foreign'],
      unitScoresBySegment: { retail: [80, 80], local: [40], foreign: [10] },
      publishedHeadline: 58,
    };
    const b: EditionSegmentEvidence = {
      reportable: ['retail', 'local'],
      unitScoresBySegment: { retail: [90, 90], local: [30] },
      publishedHeadline: 70,
    };
    const lfl = computeLikeForLike(a, b);
    expect(lfl.commonSegments).toEqual(['local', 'retail']);
    // A on {retail, local} = (80+80+40)/3 = 66.67; B = (90+90+30)/3 = 70.
    expect(lfl.recalculatedA).toBeCloseTo(66.6667, 3);
    expect(lfl.recalculatedB).toBeCloseTo(70, 6);
    // The originally-published headlines are never overwritten.
    expect(lfl.originalHeadlineA).toBe(58);
    expect(lfl.originalHeadlineB).toBe(70);
  });
});

// Industry SEI's real-derivation cases (Phase 19, item 5) need live
// calculated_results, so they live in the DB-backed candidate-scoring.test.ts
// now — `industrySeiState` is no longer a pure function.

describe('Methodology identity', () => {
  it('stamps runs with the candidate id@version', () => {
    expect(methodologyVersionString()).toBe('CIS-SCORE-2026@0.15');
  });
});

// ─── Mission board wiring (pure over a hand-built context) ─────────────────────

function forecast(seg: MissionSegment, over: Partial<SegmentForecast> = {}): SegmentForecast {
  return {
    segment: seg,
    target: 80,
    current: 80,
    daysElapsed: 10,
    daysRemaining: 10,
    velocity: 4,
    requiredVelocity: 0,
    forecastAtClose: 120,
    projectedShortfall: 0,
    atRisk: false,
    ...over,
  };
}

function baseContext(over: Partial<BoardContext> = {}): BoardContext {
  const onTrack = (seg: MissionSegment) => forecast(seg);
  return {
    forecasts: {
      firm: onTrack('firm'),
      retail: onTrack('retail'),
      local_institution: onTrack('local_institution'),
      foreign_institution: onTrack('foreign_institution'),
    },
    omiCompleteForecast: forecast('firm'),
    dmiCompleteForecast: forecast('firm'),
    missingRoleCounts: { CEO: 0, Compliance: 0, Operations: 0 },
    industrySei: {
      status: 'CALCULABLE',
      value: 15,
      contributingFirms: 32,
      sufficiency: 'REPORTABLE',
    },
    responseCounts: {},
    attributable: { forecast: 80, actual: 80, required: 80 },
    institutions: [],
    today: new Date('2026-10-01T00:00:00Z'),
    daysRemaining: 10,
    firmFunnel: [],
    maturity: [],
    participatingFirmIds: new Set(),
    medianFirmConversion: null,
    ...over,
  };
}

describe('Mission board — conditions 7/8 track item-level complete forecasts', () => {
  it('raises OMI (7) / DMI (8) cards when the complete-forecast is at risk even though firm participation is on track', () => {
    const ctx = baseContext({
      // Firm participation forecast is healthy…
      forecasts: {
        firm: forecast('firm', { atRisk: false, forecastAtClose: 120 }),
        retail: forecast('retail'),
        local_institution: forecast('local_institution'),
        foreign_institution: forecast('foreign_institution'),
      },
      // …but item-level OMI/DMI completeness is not on track to reach the floor.
      omiCompleteForecast: forecast('firm', {
        atRisk: true,
        current: 20,
        forecastAtClose: 40,
        projectedShortfall: 40,
      }),
      dmiCompleteForecast: forecast('firm', {
        atRisk: true,
        current: 25,
        forecastAtClose: 50,
        projectedShortfall: 30,
      }),
      missingRoleCounts: { CEO: 2, Compliance: 12, Operations: 3 },
    });
    const cards = evaluateBoard(ctx);
    const omi = cards.find((c) => c.conditionId === 7);
    const dmi = cards.find((c) => c.conditionId === 8);
    expect(omi).toBeTruthy();
    expect(dmi).toBeTruthy();
    expect(omi!.consequence.join(' ')).toContain('OMI-complete firms required');
    // The missing-role breakdown is surfaced on the OMI card.
    expect(omi!.consequence.join(' ')).toContain('Compliance sub-index');
  });

  it('does NOT raise 7/8 when the complete-forecasts are on track', () => {
    const cards = evaluateBoard(baseContext());
    expect(cards.some((c) => c.conditionId === 7)).toBe(false);
    expect(cards.some((c) => c.conditionId === 8)).toBe(false);
  });
});

describe('Mission board — Industry SEI methodology block', () => {
  it('shows a NO-action methodology-block card exempt from the "no action → off board" filter', () => {
    const ctx = baseContext({
      industrySei: {
        status: 'NOT_CALCULABLE',
        reason: 'Only 3 firms have reportable Firm_SEI so far — too few to aggregate safely',
        contributingFirms: 3,
      },
    });
    const cards = evaluateBoard(ctx);
    const block = cards.find((c) => c.kind === 'methodology_block');
    expect(block).toBeTruthy();
    // No cohort, no remediation shown on THIS card — but the underlying
    // shortfall is still an ordinary participation problem elsewhere on the
    // board (chasing respondents does resolve it, unlike the old permanent
    // methodology gate).
    expect(block!.recommendedAction).toBeNull();
    expect(block!.evidence.join(' ')).toContain('3 firms have');
    expect(block!.consequence.join(' ')).toContain('cannot be produced yet');
  });

  it('omits the block card once Industry SEI is calculable', () => {
    const cards = evaluateBoard(
      baseContext({
        industrySei: {
          status: 'CALCULABLE',
          value: 15,
          contributingFirms: 32,
          sufficiency: 'REPORTABLE',
        },
      }),
    );
    expect(cards.some((c) => c.kind === 'methodology_block')).toBe(false);
  });
});

describe('Phase 22 §7/§8 relationship-level investor scores (pure)', () => {
  const n1 = (x: number): number => ((x - 1) / 9) * 100;

  it('retailIeiRelationshipScore = mean(N1(Q1),N1(Q2),N1(Q3)), null when ineligible', () => {
    expect(retailIeiRelationshipScore({ q1: '8', q2: '7', q3: '9' })).toBeCloseTo(
      (n1(8) + n1(7) + n1(9)) / 3,
      6,
    );
    expect(retailIeiRelationshipScore({ q1: '8', q2: null, q3: '9' })).toBeNull();
  });

  it('retailIciRelationshipScore = 0.5(N1(Q4)) + 0.5(mean of valid Q5-Q7 after N8), null when ineligible', () => {
    const score = retailIciRelationshipScore({ q4: '8', q5: 'Yes', q6: 'No', q7: null });
    expect(score).toBeCloseTo(0.5 * n1(8) + 0.5 * ((0 + 100) / 2), 6);
    // Only 1 of 3 behavioural items — below §11's allowance.
    expect(retailIciRelationshipScore({ q4: '8', q5: 'Yes', q6: null, q7: null })).toBeNull();
  });

  it('localIeiRelationshipScore = mean(S5a-Q1_composite, Q2), tolerating 3 of 4 attributes', () => {
    const score = localIeiRelationshipScore({ q1Attributes: ['8', '8', '8', null], q2: '8' });
    expect(score).toBeCloseTo(n1(8), 6); // every valid input is 8, so composite and Q2 agree
    expect(localIeiRelationshipScore({ q1Attributes: ['8', '8', null, null], q2: '8' })).toBeNull();
  });

  it('localIciRelationshipScore = mean(N1(Q5), N8(Q6)), null when either is missing', () => {
    expect(localIciRelationshipScore({ q5: '8', q6: 'No' })).toBeCloseTo((n1(8) + 100) / 2, 6);
    expect(localIciRelationshipScore({ q5: '8', q6: null })).toBeNull();
  });

  it('foreignIeiUnitScore aggregates firm-specific Q2/Q3 across the institution BEFORE combining with shared Q1', () => {
    const score = foreignIeiUnitScore({ q1: '8', q2Values: ['9', '7'], q3Values: ['6'] });
    const aggregatedQ2 = (n1(9) + n1(7)) / 2;
    const aggregatedQ3 = n1(6);
    expect(score).toBeCloseTo((n1(8) + aggregatedQ2 + aggregatedQ3) / 3, 6);
    // No contributing firm-specific Q2/Q3 at all — an absent aggregate fails
    // eligibility, same as a missing item (§11).
    expect(foreignIeiUnitScore({ q1: '8', q2Values: [], q3Values: [] })).toBeNull();
  });

  it('foreignIciUnitScore aggregates firm-specific Q4 across the institution before combining with shared Q8', () => {
    const score = foreignIciUnitScore({ q4Values: ['9', '7'], q8: '8' });
    expect(score).toBeCloseTo(((n1(9) + n1(7)) / 2 + n1(8)) / 2, 6);
    expect(foreignIciUnitScore({ q4Values: [], q8: '8' })).toBeNull();
  });

  it('firm-attributable foreign observations use ONLY firm-specific components — never the shared items', () => {
    // Same firm-specific inputs as above, but per-relationship rather than
    // aggregated across the institution — a different, smaller mean.
    expect(foreignIeiFirmSpecificObservation({ q2: '9', q3: '6' })).toBeCloseTo(
      (n1(9) + n1(6)) / 2,
      6,
    );
    expect(foreignIciFirmSpecificObservation({ q4: '9' })).toBeCloseTo(n1(9), 6);
  });
});

// Regression (2026-10-06): two scoring inputs never matched a real answer.
describe('Scoring inputs match the register as answered', () => {
  it('N4 scores the register’s own band labels ("0 to 10%"), not only "0-10%"', () => {
    expect(scoreItem('S3-Q2', '0 to 10%')).toBe(95);
    expect(scoreItem('S3-Q2', '11 to 25%')).toBe(82);
    expect(scoreItem('S2-Q3', '76 to 90%')).toBe(17);
    expect(scoreItem('S3-Q2', 'More than 90%')).toBe(5);
    expect(scoreItem('S3-Q2', "Don't know")).toBeNull();
  });

  it('S3-Q4’s stored grid scores through its Performance (N5) and Risk (N6) bindings', () => {
    // Good → 75, Low risk → 75; Excellent → 100, Very low risk → 100.
    expect(
      scoreS3Q4Composite({
        'New client onboarding': { Performance: 'Good', Risk: 'Low' },
        Reconciliation: { Performance: 'Excellent', Risk: 'Very low' },
      }),
    ).toBe(87.5);
    expect(scoreS3Q4Composite({ 'Share transfers': { Performance: 'Poor' } })).toBe(0);
    expect(scoreS3Q4Composite(null)).toBeNull();
    expect(scoreS3Q4Composite({})).toBeNull();
  });
});
