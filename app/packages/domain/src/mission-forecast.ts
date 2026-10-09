import type { MissionSegment, SegmentForecast } from '@cis/shared-types';

/**
 * The mission board's forecast arithmetic (brief §4) — pure functions, no DB, no
 * clock, so they are deterministic and testable exactly against the spec.
 * "Do not alert because a number is low. Alert because the current trajectory
 * threatens an agreed outcome" — so everything here is forecast, not raw count.
 */

/**
 * velocity = valid completes in the last 7 days / 7. Before day 7, divide by
 * `daysElapsed` instead (dividing an early count by a full 7 understates pace
 * exactly when an early alarm is most useful). Undefined (null) on day 0.
 *
 * @param completesInWindow completes within the last min(daysElapsed,7) days.
 */
export function velocity(completesInWindow: number, daysElapsed: number): number | null {
  if (daysElapsed <= 0) return null;
  const divisor = Math.min(daysElapsed, 7);
  return completesInWindow / divisor;
}

/** required_velocity = max(0, target − current) / days_remaining. Null (suppress
 *  all forecast alerts) once collection has closed (days_remaining ≤ 0). */
export function requiredVelocity(
  target: number,
  current: number,
  daysRemaining: number,
): number | null {
  if (daysRemaining <= 0) return null;
  return Math.max(0, target - current) / daysRemaining;
}

/** forecast_at_close = current + (velocity × days_remaining). Deliberately plain;
 *  null when velocity is undefined (day 0) — no forecast alert that day. */
export function forecastAtClose(
  current: number,
  vel: number | null,
  daysRemaining: number,
): number | null {
  if (vel === null) return null;
  return current + vel * Math.max(0, daysRemaining);
}

/** projected_shortfall = max(0, target − forecast_at_close); 0 when no forecast. */
export function projectedShortfall(target: number, forecast: number | null): number {
  if (forecast === null) return 0;
  return Math.max(0, target - forecast);
}

/** at_risk = forecast_at_close < target. Never true without a forecast (day 0),
 *  and forecast-based alerts are suppressed at close by the caller (§6.3). */
export function atRisk(forecast: number | null, target: number): boolean {
  return forecast !== null && forecast < target;
}

/** Assemble a segment's full forecast state from its raw inputs. */
export function buildSegmentForecast(input: {
  segment: MissionSegment;
  target: number;
  current: number;
  completesInWindow: number;
  daysElapsed: number;
  daysRemaining: number;
}): SegmentForecast {
  const vel = velocity(input.completesInWindow, input.daysElapsed);
  const req = requiredVelocity(input.target, input.current, input.daysRemaining);
  const forecast = forecastAtClose(input.current, vel, input.daysRemaining);
  return {
    segment: input.segment,
    target: input.target,
    current: input.current,
    daysElapsed: input.daysElapsed,
    daysRemaining: input.daysRemaining,
    velocity: vel,
    requiredVelocity: req,
    forecastAtClose: forecast,
    projectedShortfall: projectedShortfall(input.target, forecast),
    atRisk: atRisk(forecast, input.target),
  };
}

// ─── Firm-side funnel diagnosis — FOUR DETERMINISTIC STATES (UX-OPS-003) ──────
//
// The calculation brief's §6.3 quartile/Q1 diagnosis was written for a
// continuous-ish distribution and does NOT fit the firm side, and UX-OPS-003's
// external QA corrected it: "With one invitation and three respondents per firm,
// conversion takes four possible values — 0, 33, 67, 100 per cent — and a
// quartile over four values is not a diagnosis." So the firm side names its state
// deterministically, each state saying exactly what is wrong with NO comparison
// and NO quartile. (Q1 quartiles are preserved for the investor side only, where
// there are enough distinct firms/respondents for a quartile to mean something —
// see `firstQuartile` below.)

export interface FirmFunnelInput {
  firmId: string;
  invited: boolean;
  claimed: boolean;
  assignedSeats: number; // of 3
  openedSeats: number;
  completedSeats: number;
}

/** The four deterministic firm-side states, earliest first (earliest wins:
 *  fixing a later stall is pointless while an earlier one still loses firms). */
export type FirmFunnelState =
  | 'not_claimed'
  | 'claimed_not_assigned'
  | 'assigned_not_opened'
  | 'opened_not_completed'
  | 'healthy';

interface FirmStateDef {
  state: FirmFunnelState;
  conditionId: number;
  label: string;
  remedy: string;
  /** Whether a firm is stuck in exactly this deterministic state. */
  stuck: (f: FirmFunnelInput) => boolean;
}

const FIRM_STATES: readonly FirmStateDef[] = [
  {
    state: 'not_claimed',
    conditionId: 18,
    label: 'Invited but not claimed — wrong person, dead address, or nobody acted.',
    remedy: 'Chase the firm',
    stuck: (f) => f.invited && !f.claimed,
  },
  {
    state: 'claimed_not_assigned',
    conditionId: 19,
    label: 'Claimed but nobody assigned — the coordinator is in and has named nobody.',
    remedy: 'Chase the coordinator',
    stuck: (f) => f.claimed && f.assignedSeats === 0,
  },
  {
    state: 'assigned_not_opened',
    conditionId: 19,
    label: 'Assigned but not opened — a named respondent has not looked.',
    remedy: 'Chase the respondents',
    stuck: (f) => f.assignedSeats > 0 && f.openedSeats === 0,
  },
  {
    state: 'opened_not_completed',
    conditionId: 20,
    label: 'Opened but not completed — started and stopped.',
    remedy: 'Chase the respondents',
    stuck: (f) => f.openedSeats > 0 && f.completedSeats < f.openedSeats,
  },
] as const;

/**
 * First quartile of a distribution (linear interpolation). INVESTOR-SIDE ONLY —
 * retail/local/foreign have enough distinct firms/respondents for a quartile to
 * be meaningful. It is deliberately NOT used by the firm-side diagnosis, which is
 * the four deterministic states above.
 */
export function firstQuartile(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * 0.25;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

export interface FunnelDiagnosis {
  /** The stuck state's key, or null when healthy (kept for compatibility). */
  stage: string | null;
  state: FirmFunnelState;
  conditionId: number;
  label: string;
  remedy: string;
  /** How many firms are in this state (0 when healthy). */
  count: number;
  reason?: 'healthy_default' | 'stuck_stage';
}

/**
 * Diagnose the firm-side funnel by DETERMINISTIC STATE, not quartile. The cohort's
 * diagnosis is the earliest state (not_claimed → claimed_not_assigned →
 * assigned_not_opened → opened_not_completed) in which any firm is stuck; each
 * names exactly what is wrong and its remedy, with no comparison and no minimum
 * population (there is no distribution to compute). When no firm is stuck at any
 * stage, the funnel is healthy and volume is simply short — condition 17, the
 * default, not a gap.
 */
export function diagnoseFirmFunnel(firms: FirmFunnelInput[]): FunnelDiagnosis {
  for (const s of FIRM_STATES) {
    const count = firms.filter(s.stuck).length;
    if (count > 0) {
      return {
        stage: s.state,
        state: s.state,
        conditionId: s.conditionId,
        label: s.label,
        remedy: s.remedy,
        count,
        reason: 'stuck_stage',
      };
    }
  }
  return {
    stage: null,
    state: 'healthy',
    conditionId: 17,
    label: 'Distribution problem — the funnel is healthy, not enough invitations sent.',
    remedy: 'Send more invitations',
    count: 0,
    reason: 'healthy_default',
  };
}

// ─── Firm-tier heatmap coverage (condition 13) ────────────────────────────────

/**
 * Tier coverage across top/middle/bottom third by operational-maturity score
 * (INFERENCE — flagged in README: score = each firm's S1-Q2 self-rating). Terciles
 * are computed over all scored firms; coverage is "uneven" when a participating
 * firm falls in only some terciles, so the heatmap cannot be built across all
 * three bands. Returns even=true when there is not yet enough data to judge.
 */
export function tierCoverageUneven(
  scores: Array<{ firmId: string; score: number }>,
  participatingFirmIds: Set<string>,
): { uneven: boolean; perTier: [number, number, number] } {
  const scored = [...scores].sort((a, b) => a.score - b.score);
  if (scored.length < 3 || participatingFirmIds.size === 0) {
    return { uneven: false, perTier: [0, 0, 0] };
  }
  const third = Math.floor(scored.length / 3);
  const tierOf = (i: number): 0 | 1 | 2 => (i < third ? 0 : i < third * 2 ? 1 : 2);
  const perTier: [number, number, number] = [0, 0, 0];
  scored.forEach((s, i) => {
    if (participatingFirmIds.has(s.firmId)) perTier[tierOf(i)] += 1;
  });
  const uneven = perTier.some((n) => n === 0);
  return { uneven, perTier };
}
