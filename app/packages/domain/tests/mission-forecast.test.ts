/**
 * Mission board — Phase 10 (UX-OPS-001) DoD §13, pure-logic half.
 * Forecast arithmetic, funnel-diagnosis Q1 collapse, the 23-condition rule table,
 * card dedup, disabled 6/21, after-close forecast→actual, card completeness, and
 * the remediation-cohort mapping — all deterministic, no DB.
 */
import { describe, it, expect } from 'vitest';
import {
  velocity,
  requiredVelocity,
  forecastAtClose,
  projectedShortfall,
  atRisk,
  buildSegmentForecast,
  diagnoseFirmFunnel,
  firstQuartile,
  evaluateBoard,
  CONDITIONS,
  remediationForCohort,
  type BoardContext,
  type FirmFunnelInput,
  type RemediationCohort,
} from '../src';
import type { MissionSegment, SegmentForecast } from '@cis/shared-types';

describe('Forecast arithmetic (brief §4)', () => {
  it('velocity divides by days_elapsed before day 7, by 7 after, and is null on day 0', () => {
    expect(velocity(9, 0)).toBeNull(); // day 0 undefined
    expect(velocity(9, 3)).toBeCloseTo(3); // 9 / 3 (early: divide by days_elapsed)
    expect(velocity(14, 7)).toBeCloseTo(2); // 14 / 7
    expect(velocity(70, 30)).toBeCloseTo(10); // last-7 window / 7
  });
  it('required velocity is max(0,target-current)/days_remaining, null at close', () => {
    expect(requiredVelocity(1111, 800, 10)).toBeCloseTo(31.1);
    expect(requiredVelocity(80, 100, 10)).toBe(0); // already met → 0, not negative
    expect(requiredVelocity(80, 10, 0)).toBeNull(); // days_remaining 0 → suppress
  });
  it('forecast, shortfall and at-risk follow the plain formulas', () => {
    expect(forecastAtClose(100, 30, 10)).toBe(400); // current + velocity*days
    expect(forecastAtClose(100, null, 10)).toBeNull(); // day 0 → no forecast
    expect(projectedShortfall(1111, 800)).toBe(311);
    expect(projectedShortfall(1111, 1200)).toBe(0);
    expect(projectedShortfall(1111, null)).toBe(0);
    expect(atRisk(800, 1111)).toBe(true);
    expect(atRisk(1200, 1111)).toBe(false);
    expect(atRisk(null, 1111)).toBe(false); // never at risk without a forecast
  });
});

// ── Helpers to build forecasts in a known risk state ─────────────────────────
function notAtRisk(segment: MissionSegment, target: number): SegmentForecast {
  return buildSegmentForecast({
    segment,
    target,
    current: target,
    completesInWindow: target,
    daysElapsed: 10,
    daysRemaining: 10,
  });
}
function atRiskSeg(segment: MissionSegment, target: number): SegmentForecast {
  return buildSegmentForecast({
    segment,
    target,
    current: 1,
    completesInWindow: 0,
    daysElapsed: 10,
    daysRemaining: 10,
  });
}
function baseContext(overrides: Partial<BoardContext> = {}): BoardContext {
  return {
    forecasts: {
      firm: notAtRisk('firm', 80),
      retail: notAtRisk('retail', 1111),
      local_institution: notAtRisk('local_institution', 25),
      foreign_institution: notAtRisk('foreign_institution', 15),
    },
    omiCompleteForecast: notAtRisk('firm', 80),
    dmiCompleteForecast: notAtRisk('firm', 80),
    missingRoleCounts: { CEO: 0, Compliance: 0, Operations: 0 },
    industrySei: {
      status: 'CALCULABLE',
      value: 15,
      contributingFirms: 32,
      sufficiency: 'REPORTABLE',
    },
    responseCounts: { local_institution: 0, foreign_institution: 0 },
    attributable: { forecast: 100, actual: 100, required: 80 },
    institutions: [],
    today: new Date('2026-10-01T00:00:00Z'),
    daysRemaining: 10,
    firmFunnel: [],
    firmFunnelMeta: new Map(),
    maturity: [],
    participatingFirmIds: new Set(),
    medianFirmConversion: null,
    ...overrides,
  };
}

describe('Card dedup — one root cause, one card (§4A)', () => {
  it('a retail shortfall produces ONE card with dependent outputs folded into consequence', () => {
    const ctx = baseContext({
      forecasts: {
        firm: notAtRisk('firm', 80),
        retail: atRiskSeg('retail', 1111),
        local_institution: notAtRisk('local_institution', 25),
        foreign_institution: notAtRisk('foreign_institution', 15),
      },
    });
    const cards = evaluateBoard(ctx);
    const retailCards = cards.filter((c) => c.conditionId === 2);
    expect(retailCards).toHaveLength(1);
    // Engine-2 outputs depending on retail are folded in, not raised separately.
    expect(cards.some((c) => [9, 10, 11, 15].includes(c.conditionId))).toBe(false);
    const consequence = retailCards[0]!.consequence.join(' | ');
    expect(consequence).toMatch(/IEI \/ ICI headline/);
    expect(consequence).toMatch(/by segment/);
    expect(consequence).toMatch(/Top investor frustrations/);
  });
});

describe('Disabled conditions 6 and 21 (D-1 dropped)', () => {
  it('exist in the table, disabled, with no threshold value', () => {
    const c6 = CONDITIONS.find((c) => c.id === 6)!;
    const c21 = CONDITIONS.find((c) => c.id === 21)!;
    expect(c6.enabled).toBe(false);
    expect(c21.enabled).toBe(false);
    expect(c6.inputs).toMatch(/DISABLED/);
    expect(c21.inputs).toMatch(/DISABLED/);
    // No threshold EXPRESSION (comparison operator) — unlike every live condition,
    // which carries one. A descriptive "no threshold set" is what's expected.
    expect(c6.inputs).not.toMatch(/[<>≥≤]|>=|<=/);
    expect(c21.inputs).not.toMatch(/[<>≥≤]|>=|<=/);
    expect(c6.inputs).toMatch(/no threshold/);
    expect(c21.inputs).toMatch(/no threshold/);
  });
  it('never emit a card even when everything else is failing', () => {
    const ctx = baseContext({
      forecasts: {
        firm: atRiskSeg('firm', 80),
        retail: atRiskSeg('retail', 1111),
        local_institution: atRiskSeg('local_institution', 25),
        foreign_institution: atRiskSeg('foreign_institution', 15),
      },
    });
    const cards = evaluateBoard(ctx);
    expect(cards.some((c) => c.conditionId === 6 || c.conditionId === 21)).toBe(false);
  });
});

describe('After close — forecast suppressed, condition 14 switches to actual (§6.3)', () => {
  it('while open, cond 14 reads forecast (viable → no card); a retail forecast card is live', () => {
    const open = baseContext({
      forecasts: {
        firm: notAtRisk('firm', 80),
        retail: atRiskSeg('retail', 1111),
        local_institution: notAtRisk('local_institution', 25),
        foreign_institution: notAtRisk('foreign_institution', 15),
      },
      attributable: { forecast: 100, actual: 10, required: 80 }, // forecast viable
      daysRemaining: 10,
    });
    const cards = evaluateBoard(open);
    expect(cards.some((c) => c.conditionId === 2)).toBe(true); // forecast alert live
    expect(cards.some((c) => c.conditionId === 14)).toBe(false); // forecast(attributable) ≥ required
  });

  it('at close, all forecast alerts suppress but cond 14 fires on ACTUAL', () => {
    const closed = baseContext({
      forecasts: {
        firm: notAtRisk('firm', 80),
        retail: atRiskSeg('retail', 1111), // would fire while open
        local_institution: notAtRisk('local_institution', 25),
        foreign_institution: notAtRisk('foreign_institution', 15),
      },
      attributable: { forecast: 100, actual: 10, required: 80 }, // actual short
      daysRemaining: 0,
    });
    const cards = evaluateBoard(closed);
    expect(cards.some((c) => c.conditionId === 2)).toBe(false); // forecast suppressed
    const c14 = cards.find((c) => c.conditionId === 14)!;
    expect(c14).toBeTruthy();
    expect(c14.evidence.join(' ')).toMatch(/Actual/); // reads actual, not forecast
  });
});

describe('Investor-side forecasting uses NO "sent" denominator (UX-OPS-003 A2)', () => {
  it('velocity is completes-per-DAY, never completes-over-sends', () => {
    // The investor funnel is opened → started → completed; the platform cannot
    // know send volume, so a rate against sends is not calculable. The pace is
    // completes in the window over DAYS — never divided by any invited/sent count.
    for (const seg of ['retail', 'local_institution', 'foreign_institution'] as MissionSegment[]) {
      const f = buildSegmentForecast({
        segment: seg,
        target: 1000,
        current: 100,
        completesInWindow: 70,
        daysElapsed: 10,
        daysRemaining: 20,
      });
      // 70 completes over min(10,7)=7 days = 10/day. If any "sent" denominator
      // were involved the number would differ; it is purely completes ÷ days.
      expect(f.velocity).toBeCloseTo(10);
      expect(f.forecastAtClose).toBeCloseTo(100 + 10 * 20);
    }
    // buildSegmentForecast's input surface has no sent/invited field at all —
    // the only denominators in the forecast are days.
  });
});

describe('Firm-side funnel diagnosis — FOUR DETERMINISTIC STATES (UX-OPS-003 fix)', () => {
  const complete = (i: number): FirmFunnelInput => ({
    firmId: `f${i}`,
    invited: true,
    claimed: true,
    assignedSeats: 3,
    openedSeats: 3,
    completedSeats: 3,
  });

  it('firstQuartile is preserved for the investor side only (still exported, still correct)', () => {
    expect(firstQuartile([0, 1, 1, 1, 1, 1, 1, 1, 1, 1])).toBeCloseTo(1);
    expect(firstQuartile([0, 1, 2, 3, 4])).toBeCloseTo(1);
  });

  it('diagnoses even below 10 firms — no minimum population, no quartiles', () => {
    // Three firms, all invited-not-claimed. The old quartile rule refused a
    // diagnosis under 10 firms; the deterministic rule names the state.
    const firms: FirmFunnelInput[] = [0, 1, 2].map((i) => ({
      firmId: `f${i}`,
      invited: true,
      claimed: false,
      assignedSeats: 0,
      openedSeats: 0,
      completedSeats: 0,
    }));
    const d = diagnoseFirmFunnel(firms);
    expect(d.state).toBe('not_claimed');
    expect(d.reason).toBe('stuck_stage');
    expect(d.count).toBe(3);
    expect(d.remedy).toBe('Chase the firm');
  });

  it('is healthy (condition 17) only when no firm is stuck at any stage', () => {
    const d = diagnoseFirmFunnel(Array.from({ length: 12 }, (_, i) => complete(i)));
    expect(d.state).toBe('healthy');
    expect(d.conditionId).toBe(17);
    expect(d.reason).toBe('healthy_default');
  });

  it('names the EARLIEST stuck state when several apply', () => {
    const firms = Array.from({ length: 12 }, (_, i) => complete(i));
    // One firm claimed-not-assigned, another assigned-not-opened. Earliest wins.
    firms[0] = {
      firmId: 'a',
      invited: true,
      claimed: true,
      assignedSeats: 0,
      openedSeats: 0,
      completedSeats: 0,
    };
    firms[1] = {
      firmId: 'b',
      invited: true,
      claimed: true,
      assignedSeats: 3,
      openedSeats: 0,
      completedSeats: 0,
    };
    const d = diagnoseFirmFunnel(firms);
    expect(d.state).toBe('claimed_not_assigned');
    expect(d.remedy).toBe('Chase the coordinator');
  });

  it('REGRESSION: never re-derives from quartile math — uniform failure is named, not hidden', () => {
    // Every firm is equally stuck at opened→completed (uniform failure). The old
    // Q1 rule found NO outlier (nothing below Q1) and returned healthy_default,
    // hiding the cause. The deterministic rule names the stuck state instead —
    // proving the diagnosis no longer depends on a distribution/quartile.
    const firms: FirmFunnelInput[] = Array.from({ length: 12 }, (_, i) => ({
      firmId: `f${i}`,
      invited: true,
      claimed: true,
      assignedSeats: 3,
      openedSeats: 3,
      completedSeats: 0, // all opened, none completed — identical across firms
    }));
    const d = diagnoseFirmFunnel(firms);
    expect(d.state).toBe('opened_not_completed');
    expect(d.reason).toBe('stuck_stage'); // NOT healthy_default
    expect(d.count).toBe(12);
  });
});

describe('Card completeness (§10)', () => {
  it('omits expected impact when no history median exists, includes it when present', () => {
    const risky = {
      firm: notAtRisk('firm', 80),
      retail: atRiskSeg('retail', 1111),
      local_institution: notAtRisk('local_institution', 25),
      foreign_institution: notAtRisk('foreign_institution', 15),
    };
    const noHist = evaluateBoard(baseContext({ forecasts: risky, medianFirmConversion: null }));
    expect(noHist.find((c) => c.conditionId === 2)!.expectedImpact).toBeUndefined();

    const withHist = evaluateBoard(
      baseContext({
        forecasts: risky,
        medianFirmConversion: 0.5,
        firmFunnel: [
          {
            firmId: 'x',
            invited: true,
            claimed: false,
            assignedSeats: 0,
            openedSeats: 0,
            completedSeats: 0,
          },
        ],
      }),
    );
    // expected impact is present (a string) when a median exists.
    expect(typeof withHist.find((c) => c.conditionId === 2)!.expectedImpact).toBe('string');
  });

  it('every rendered card carries a recommended action', () => {
    const cards = evaluateBoard(
      baseContext({
        forecasts: {
          firm: atRiskSeg('firm', 80),
          retail: atRiskSeg('retail', 1111),
          local_institution: notAtRisk('local_institution', 25),
          foreign_institution: notAtRisk('foreign_institution', 15),
        },
      }),
    );
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.recommendedAction.label.length).toBeGreaterThan(0);
  });
});

describe('Condition 16 — Institutional Perspectives status model (§7A)', () => {
  it('does not fire with an empty target_by; fires once late and unengaged', () => {
    const noDate = evaluateBoard(
      baseContext({
        institutions: [
          {
            id: '1',
            editionId: 'e',
            institutionId: 'sec-id',
            familyCode: 'A',
            institutionName: 'Securities and Exchange Commission',
            status: 'not_started',
            statusChangedAt: new Date(),
            targetBy: null,
          },
        ],
      }),
    );
    expect(noDate.some((c) => c.conditionId === 16)).toBe(false);

    const late = evaluateBoard(
      baseContext({
        today: new Date('2026-10-10T00:00:00Z'),
        institutions: [
          {
            id: '1',
            editionId: 'e',
            institutionId: 'sec-id',
            familyCode: 'A',
            institutionName: 'Securities and Exchange Commission',
            status: 'invited',
            statusChangedAt: new Date(),
            targetBy: new Date('2026-10-01'),
          },
        ],
      }),
    );
    expect(late.some((c) => c.conditionId === 16)).toBe(true);
  });

  it('a declined institution raises a replan card even at close (survives §6.3)', () => {
    const cards = evaluateBoard(
      baseContext({
        daysRemaining: 0,
        institutions: [
          {
            id: '1',
            editionId: 'e',
            institutionId: 'ngx-id',
            familyCode: 'B',
            institutionName: 'Nigerian Exchange Limited',
            status: 'declined',
            statusChangedAt: new Date(),
            targetBy: null,
          },
        ],
      }),
    );
    const c16 = cards.find((c) => c.conditionId === 16)!;
    expect(c16).toBeTruthy();
    expect(c16.severity).toBe(1);
    expect(c16.consequence.join(' ')).toMatch(/replanned/);
  });
});

describe('Remediation mapping — all eight cohorts resolve (§9, Approach 2)', () => {
  it('each cohort maps to a real Phase 9 audience, a generated upload list, or null (bounced)', () => {
    const VALID = new Set([
      'all',
      'newaddr2',
      'unclaimed',
      'noassign',
      'partial',
      'noreach',
      'complete',
      'regsall',
      'retail',
      'localinst',
      'foreigninst',
      'allpart',
      'upload',
    ]);
    const cohorts: RemediationCohort[] = [
      'not_claimed',
      'claimed_no_assign',
      'assigned_outstanding',
      'started_not_submitted',
      'no_outreach',
      'no_link_activity',
      'institutional_all_firms',
      'bounced',
    ];
    for (const cohort of cohorts) {
      const r = remediationForCohort(cohort);
      expect(r.label.length).toBeGreaterThan(0);
      if (cohort === 'bounced') {
        expect(r.audienceId).toBeNull(); // no bulk send
      } else {
        expect(VALID.has(r.audienceId!)).toBe(true);
        if (
          ['started_not_submitted', 'no_link_activity', 'institutional_all_firms'].includes(cohort)
        ) {
          expect(r.generated).toBe(true); // computed list handed to the upload audience
          expect(r.audienceId).toBe('upload');
        }
      }
    }
  });
});
