import { Pool } from 'pg';
import {
  getEditionById,
  listSampleFloors,
  countCompletedBySegment,
  countCompletedBySegmentSince,
  countDistinctInstitutions,
  countDistinctInstitutionsSince,
  countFirmsFirstCompletedSince,
  getFirmSeatCompletionCounts,
  countAttributable,
  listInstitutionEngagement,
  getFirmFunnelRows,
  getFirmMaturityScores,
  type InstitutionEngagement,
} from '@cis/db';
import type { MissionCard, MissionSegment, SegmentForecast, EditionPhase } from '@cis/shared-types';
import { DomainError } from './errors';
import {
  buildSegmentForecast,
  diagnoseFirmFunnel,
  tierCoverageUneven,
  type FirmFunnelInput,
} from './mission-forecast';
import {
  missingOmiRoleCounts,
  industrySeiState,
  type IndustrySeiState,
} from './candidate-scoring-service';
import { completeFirmsForIndex } from './scoring-signoff-service';

/**
 * Format a value read from `institution_engagement.target_by` (a DATE
 * column) for display. Never `.toISOString()` here: node-postgres parses a
 * plain "YYYY-MM-DD" DATE value as LOCAL midnight (no timezone exists on a
 * calendar date), so reading it back through a UTC method flips the day in
 * any timezone ahead of UTC (see the identical fix in
 * regulator-engagement-service.ts's `dbDateStr`, condition 16's own data
 * source). Local getters are the correct, symmetric inverse.
 */
function dbDateStr(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * UX-OPS-001 — the mission board evaluator. One board, one audience: what needs
 * a person today, ranked by consequence. Every condition is forecast-based (§2):
 * a card exists because the trajectory threatens an agreed outcome AND a concrete
 * bulk action is available — never because a number is merely low.
 *
 * The 23 conditions are a data-driven rule table (CONDITIONS below) a study-team
 * member can read against the brief. Two (6 and 21 — volume concentration, D-1)
 * are DISABLED: specified, inert, and carrying NO threshold value, exactly as the
 * brief requires. Card deduplication (§4A) folds every Engine-2 output depending
 * on a segment into that segment's live Engine-1 card, so one root cause is one
 * card. At close (days_remaining = 0) forecast alerts suppress and condition 14
 * switches from forecast to actual (§6.3).
 */

export class MissionBoardError extends DomainError {
  constructor(message: string, code = 'MISSION_BOARD') {
    super(message, code);
  }
}

const FLOOR_CATEGORY: Record<MissionSegment, string> = {
  firm: 'firm',
  retail: 'retail',
  local_institution: 'local_institution',
  foreign_institution: 'foreign_institution',
};

// ─── Remediation cohorts → UX-OPS-002 audiences (the §9 decision) ─────────────
//
// DECISION (documented in README): APPROACH 2 — the mission board computes the
// firm-id list for cohorts Phase 9 has no first-class audience for, and hands it
// to Phase 9's existing "a list I upload" audience as a GENERATED (not
// user-uploaded) list. This leaves Phase 9 unchanged and keeps cohort definition
// with the board that understands it. Cohorts that map cleanly use the existing
// audience id directly; the bounced cohort has no bulk action at all (export
// only — Phase 9 already does the right thing).
export type RemediationCohort =
  | 'not_claimed'
  | 'claimed_no_assign'
  | 'assigned_outstanding'
  | 'started_not_submitted'
  | 'no_outreach'
  | 'no_link_activity'
  | 'institutional_all_firms'
  | 'bounced'
  | 'regulator_follow_up'
  | 'before_launch';

export function remediationForCohort(cohort: RemediationCohort): {
  label: string;
  audienceId: string | null;
  generated: boolean;
} {
  switch (cohort) {
    case 'not_claimed':
      return {
        label: 'Bulk reminder to the coordinator',
        audienceId: 'unclaimed',
        generated: false,
      };
    case 'claimed_no_assign':
      return { label: 'Bulk nudge to assign', audienceId: 'noassign', generated: false };
    case 'assigned_outstanding':
      return {
        label: 'Bulk chase to the named respondents',
        audienceId: 'partial',
        generated: false,
      };
    case 'no_outreach':
      return {
        label: 'Bulk nudge with the outreach copy',
        audienceId: 'noreach',
        generated: false,
      };
    // Cohorts Phase 9 has no first-class audience for → generated upload list.
    case 'started_not_submitted':
      return { label: 'Bulk final reminder', audienceId: 'upload', generated: true };
    case 'no_link_activity':
      return {
        label: 'Bulk nudge',
        audienceId: 'upload',
        generated: true,
      };
    case 'institutional_all_firms':
      return {
        label: 'Message all participating firms',
        audienceId: 'upload',
        generated: true,
      };
    case 'bounced':
      // No bulk action anywhere to send — Phase 9 lists/exports for CIS.
      return {
        label: 'Export the bounced addresses for CIS',
        audienceId: null,
        generated: false,
      };
    // A regulator is reached through its named contact on the Regulators
    // screen, never through a firm mailing.
    case 'regulator_follow_up':
      return {
        label: 'Follow up with the named contact on the Regulators screen',
        audienceId: null,
        generated: false,
      };
    // Before launch nobody has been invited, assigned or started, so no chase
    // exists yet. What can move every firm-side forecast is getting the
    // invitations out and each firm's coordinator onboard.
    case 'before_launch':
      return {
        label: 'Send the firm invitations so each coordinator can claim their firm',
        audienceId: 'all',
        generated: false,
      };
  }
}

// ─── The rule table ───────────────────────────────────────────────────────────

type Engine = 1 | 2 | 'funnel' | 'firm';

interface ConditionMeta {
  id: number;
  engine: Engine;
  /** Segment an Engine-1 condition governs (for dedup). */
  segment?: MissionSegment;
  /** Report output id an Engine-2 condition serves (report_dependency). */
  output?: string;
  severity: MissionCard['severity'];
  enabled: boolean;
  cohort: RemediationCohort;
  what: string;
  /** Human-readable inputs/expression, so the table reads against the brief. */
  inputs: string;
}

/** The full 23-condition catalogue. 6 and 21 are DISABLED and carry NO threshold. */
export const CONDITIONS: readonly ConditionMeta[] = [
  {
    id: 1,
    engine: 1,
    segment: 'firm',
    severity: 2,
    enabled: true,
    cohort: 'not_claimed',
    what: 'Participating firms likely to miss target',
    inputs: 'forecast(firm) < 80',
  },
  {
    id: 2,
    engine: 1,
    segment: 'retail',
    severity: 2,
    enabled: true,
    cohort: 'no_link_activity',
    what: 'Retail participation likely to miss target',
    inputs: 'forecast(retail) < 1111',
  },
  {
    id: 3,
    engine: 1,
    segment: 'local_institution',
    severity: 2,
    enabled: true,
    cohort: 'institutional_all_firms',
    what: 'Local institutions likely to miss target',
    inputs: 'forecast(distinct local) < 25',
  },
  {
    id: 4,
    engine: 1,
    segment: 'foreign_institution',
    severity: 2,
    enabled: true,
    cohort: 'institutional_all_firms',
    what: 'Foreign institutions likely to miss target',
    inputs: 'forecast(distinct foreign) < 15',
  },
  {
    id: 5,
    engine: 1,
    severity: 5,
    enabled: true,
    cohort: 'institutional_all_firms',
    what: 'Distinct institution count short despite response volume',
    inputs: 'forecast(distinct) < floor AND response_count >= floor',
  },
  // DISABLED — D-1 dropped for Year 1. NO threshold value exists here.
  {
    id: 6,
    engine: 1,
    severity: 5,
    enabled: false,
    cohort: 'no_link_activity',
    what: 'Volume concentrated in few firms',
    inputs: 'DISABLED — D-1 dropped for Year 1; no threshold set',
  },
  {
    id: 7,
    engine: 2,
    output: 'OMI',
    segment: 'firm',
    severity: 3,
    enabled: true,
    cohort: 'not_claimed',
    what: 'OMI at risk',
    inputs: 'at_risk(firm)',
  },
  {
    id: 8,
    engine: 2,
    output: 'DMI',
    segment: 'firm',
    severity: 3,
    enabled: true,
    cohort: 'not_claimed',
    what: 'DMI at risk',
    inputs: 'at_risk(firm)',
  },
  {
    id: 9,
    engine: 2,
    output: 'IEI_ICI_HEADLINE',
    segment: 'retail',
    severity: 3,
    enabled: true,
    cohort: 'no_link_activity',
    what: 'IEI / ICI headline at risk',
    inputs: 'at_risk(retail)',
  },
  {
    id: 10,
    engine: 2,
    output: 'IEI_ICI_BY_SEGMENT',
    severity: 3,
    enabled: true,
    cohort: 'no_link_activity',
    what: 'IEI / ICI by segment at risk',
    inputs: 'at_risk(retail) OR at_risk(local) OR at_risk(foreign)',
  },
  {
    id: 11,
    engine: 2,
    output: 'SEI_GAP',
    severity: 3,
    enabled: true,
    cohort: 'no_link_activity',
    what: 'SEI gap at risk',
    inputs: 'at_risk(firm) OR at_risk(retail)',
  },
  {
    id: 12,
    engine: 2,
    output: 'LOCAL_VS_FOREIGN',
    severity: 3,
    enabled: true,
    cohort: 'institutional_all_firms',
    what: 'Local vs foreign comparison at risk',
    inputs: 'at_risk(local) OR at_risk(foreign)',
  },
  {
    id: 13,
    engine: 2,
    output: 'FIRM_TIER_HEATMAP',
    severity: 3,
    enabled: true,
    cohort: 'not_claimed',
    what: 'Firm-tier heatmap coverage uneven',
    inputs: 'tier coverage uneven across maturity thirds',
  },
  {
    id: 14,
    engine: 2,
    output: 'PARTICIPATING_FIRM_REPORT',
    severity: 3,
    enabled: true,
    cohort: 'assigned_outstanding',
    what: 'Participating-firm report at risk',
    inputs: 'forecast(attributable) < required; actual(attributable) < required after close',
  },
  {
    id: 15,
    engine: 2,
    output: 'TOP_INVESTOR_FRUSTRATIONS',
    segment: 'retail',
    severity: 3,
    enabled: true,
    cohort: 'no_link_activity',
    what: 'Top investor frustrations at risk',
    inputs: 'at_risk(retail)',
  },
  {
    id: 16,
    engine: 2,
    output: 'INSTITUTIONAL_PERSPECTIVES',
    severity: 3,
    enabled: true,
    cohort: 'regulator_follow_up',
    what: 'Institutional Perspectives at risk',
    inputs: 'institution late against target_by, or declined',
  },
  {
    id: 17,
    engine: 'funnel',
    severity: 4,
    enabled: true,
    cohort: 'not_claimed',
    what: 'Distribution problem — not enough invitations sent',
    inputs: 'no firm stuck at any stage (deterministic default)',
  },
  {
    id: 18,
    engine: 'funnel',
    severity: 4,
    enabled: true,
    cohort: 'not_claimed',
    what: 'Message or channel problem',
    inputs: 'firms invited but not claimed (deterministic state)',
  },
  {
    id: 19,
    engine: 'funnel',
    severity: 4,
    enabled: true,
    cohort: 'assigned_outstanding',
    what: 'Entry-friction problem',
    inputs: 'claimed-not-assigned or assigned-not-opened (deterministic state)',
  },
  {
    id: 20,
    engine: 'funnel',
    severity: 4,
    enabled: true,
    cohort: 'started_not_submitted',
    what: 'Questionnaire problem',
    inputs: 'opened but not completed (deterministic state)',
  },
  // DISABLED — D-1 dropped for Year 1. NO threshold value exists here.
  {
    id: 21,
    engine: 'funnel',
    severity: 5,
    enabled: false,
    cohort: 'no_link_activity',
    what: 'Concentration, funnel view',
    inputs: 'DISABLED — D-1 dropped for Year 1; no threshold set',
  },
  {
    id: 22,
    engine: 'funnel',
    segment: 'foreign_institution',
    severity: 5,
    enabled: true,
    cohort: 'institutional_all_firms',
    what: 'Foreign institutional shortfall — route problem',
    inputs: 'foreign distinct short',
  },
  {
    id: 23,
    engine: 'firm',
    severity: 6,
    enabled: true,
    cohort: 'no_link_activity',
    what: 'Firm invited, no activity for five days',
    inputs: 'invited_at set, last_funnel_activity null, 5 days elapsed',
  },
] as const;

// ─── Evaluation ────────────────────────────────────────────────────────────────

export interface BoardContext {
  forecasts: Record<MissionSegment, SegmentForecast>;
  /**
   * Phase 11 correction: OMI/DMI at-risk (conditions 7/8) are evaluated against
   * complete-firm forecasts — how many firms will be OMI-complete / DMI-complete
   * by close — NOT raw firm participation. A firm can participate yet be neither
   * OMI- nor DMI-complete, so these forecasts can be at risk while the firm
   * participation forecast is on track. "Complete" is the Scoring page's own
   * definition (`completeFirmsForIndex`), never a second one.
   */
  omiCompleteForecast: SegmentForecast;
  dmiCompleteForecast: SegmentForecast;
  /** Firms missing each OMI role sub-index (zero substantive items for it). */
  missingRoleCounts: Record<string, number>;
  /** Industry SEI methodology state — NOT_CALCULABLE blocks it structurally. */
  industrySei: IndustrySeiState;
  /** Raw response counts per segment (for condition 5, distinct-vs-volume). */
  responseCounts: Record<string, number>;
  attributable: { forecast: number; actual: number; required: number };
  institutions: InstitutionEngagement[];
  today: Date;
  daysRemaining: number;
  /** The edition has not launched yet (draft): nobody can be chased, so a
   *  card's action is the pre-launch one that is actually available. */
  beforeLaunch?: boolean;
  firmFunnel: FirmFunnelInput[];
  /** Per-firm invited/last-activity timestamps for condition 23 (kept beside the
   *  funnel inputs so evaluateBoard stays pure over its context). */
  firmFunnelMeta?: Map<string, { invitedAt: Date | null; lastFunnelActivity: Date | null }>;
  maturity: Array<{ firmId: string; score: number }>;
  participatingFirmIds: Set<string>;
  /** Median per-firm conversion, or null when there isn't enough history yet. */
  medianFirmConversion: number | null;
}

/** "1 firm", "2 firms" — a count with its noun in the right number. */
function countOf(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function segForecastEvidence(f: SegmentForecast): string[] {
  return [
    `Current ${f.current} of ${f.target}`,
    `${countOf(f.daysRemaining, 'day')} left`,
    f.velocity === null ? 'No pace yet' : `Pace ${f.velocity.toFixed(1)} a day`,
    f.requiredVelocity === null
      ? 'Pace needed: not yet known'
      : `Needed ${f.requiredVelocity.toFixed(1)} a day`,
    f.forecastAtClose === null
      ? 'No forecast yet'
      : `Forecast at close ${Math.round(f.forecastAtClose)}`,
  ];
}

/**
 * Evaluate the whole board from a fully-resolved context. Pure over its input, so
 * it is deterministic and testable. Returns cards ranked by severity then
 * projected shortfall descending; a card with no recommended action never
 * appears (an alarm is not a mission).
 */
export function evaluateBoard(ctx: BoardContext): MissionCard[] {
  const closed = ctx.daysRemaining <= 0;
  const cards: MissionCard[] = [];
  const enabled = (id: number) => CONDITIONS.find((c) => c.id === id)?.enabled ?? false;

  // Which segments have a LIVE Engine-1 card (drives §4A dedup).
  const engine1LiveSegments = new Set<MissionSegment>();

  // ── Engine 1: statistical floors (1–4) + distinct-vs-volume (5) ──────────────
  // All forecast-based → entirely suppressed at close (§6.3).
  const ENGINE1_SEGMENTS: MissionSegment[] = [
    'firm',
    'retail',
    'local_institution',
    'foreign_institution',
  ];
  if (!closed) {
    for (const seg of ENGINE1_SEGMENTS) {
      const f = ctx.forecasts[seg];
      const cond = CONDITIONS.find((c) => c.engine === 1 && c.segment === seg)!;
      if (f.atRisk && enabled(cond.id)) engine1LiveSegments.add(seg);
    }
  }

  // Funnel diagnosis (computed once) drives the Why/Do of the firm Engine-1 card,
  // and can raise its own card when a stage collapses without a target threatened.
  const diagnosis = diagnoseFirmFunnel(ctx.firmFunnel);

  const expectedImpact = (cohortCount: number): string | undefined => {
    if (ctx.medianFirmConversion === null) return undefined; // omit, never invent
    const projected = Math.round(cohortCount * ctx.medianFirmConversion);
    return `~${projected} additional responses at the current median per-firm conversion`;
  };

  // Build one Engine-1 card per live segment, folding dependent Engine-2 outputs
  // into its consequence (§4A) rather than letting them raise their own cards.
  for (const seg of engine1LiveSegments) {
    const f = ctx.forecasts[seg];
    const cond = CONDITIONS.find((c) => c.engine === 1 && c.segment === seg)!;
    const consequence: string[] = [
      `${labelSegment(seg)} floor missed by ${Math.round(f.projectedShortfall)}`,
    ];
    for (const e2 of CONDITIONS) {
      if (e2.engine !== 2 || !enabled(e2.id)) continue;
      if (dependsOnSegment(e2, seg)) consequence.push(e2.what);
    }
    const rem = remediationForCohort(cond.cohort);
    const impact = expectedImpact(cohortCountFor(ctx, cond.cohort));
    cards.push({
      conditionId: cond.id,
      severity: cond.severity,
      whatIsAtRisk: cond.what,
      evidence: segForecastEvidence(f),
      consequence,
      why: seg === 'firm' ? diagnosis.label : null,
      recommendedAction: { label: rem.label, cohort: cond.cohort, audienceId: rem.audienceId },
      ...(impact !== undefined ? { expectedImpact: impact } : {}),
      projectedShortfall: f.projectedShortfall,
    });
  }

  // ── Condition 5: distinct short despite volume (institutional only) ──────────
  if (!closed) {
    for (const seg of ['local_institution', 'foreign_institution'] as MissionSegment[]) {
      const f = ctx.forecasts[seg];
      const responses = ctx.responseCounts[seg] ?? 0;
      if (enabled(5) && f.atRisk && responses >= f.target && !engine1LiveSegments.has(seg)) {
        cards.push(
          makeSimpleCard(5, f.projectedShortfall, segForecastEvidence(f), [
            `Too few different ${labelSegment(seg).toLowerCase()}s, though ${countOf(responses, 'response')} came in`,
          ]),
        );
      }
    }
  }

  // ── Conditions 7 & 8: OMI / DMI at risk against ITEM-LEVEL complete forecasts ─
  // Phase 11 correction: these track how many firms will be OMI-complete /
  // DMI-complete by close, NOT raw firm participation. Forecast-based → suppressed
  // at close. Raised as their own cards (never folded into the firm Engine-1 card).
  if (!closed) {
    const completeConds: Array<{ id: number; label: string; f: SegmentForecast; extra: string[] }> =
      [
        {
          id: 7,
          label: 'OMI',
          f: ctx.omiCompleteForecast,
          extra: Object.entries(ctx.missingRoleCounts)
            .filter(([, n]) => n > 0)
            .map(
              ([role, n]) =>
                `${n} participating firm${n > 1 ? 's' : ''} missing the ${role} sub-index`,
            ),
        },
        { id: 8, label: 'DMI', f: ctx.dmiCompleteForecast, extra: [] },
      ];
    for (const { id, label, f, extra } of completeConds) {
      if (!enabled(id) || !f.atRisk) continue;
      const cond = CONDITIONS.find((c) => c.id === id)!;
      const rem = remediationForCohort(cond.cohort);
      const impact = expectedImpact(cohortCountFor(ctx, cond.cohort));
      cards.push({
        conditionId: id,
        severity: cond.severity,
        whatIsAtRisk: cond.what,
        evidence: segForecastEvidence(f),
        consequence: [
          `Forecast ${f.forecastAtClose === null ? 'n/a' : Math.round(f.forecastAtClose)} of ${f.target} ${label}-complete firms required`,
          ...extra,
        ],
        why: null,
        recommendedAction: { label: rem.label, cohort: cond.cohort, audienceId: rem.audienceId },
        ...(impact !== undefined ? { expectedImpact: impact } : {}),
        projectedShortfall: f.projectedShortfall,
      });
    }
  }

  // ── Industry SEI not yet calculable (Phase 19: real derivation) ──────────────
  // Industry SEI is derived from participating firms' own Firm_SEI once a
  // signed-off scoring run exists (never during open collection, since no
  // firm-level SEI values exist yet). This is a genuine data-shortfall/
  // sign-off-pending state, not a permanent methodology gate — it survives
  // close because the state itself is still meaningful information, but it
  // carries no bulk-outreach recommendation of its own (this board has no
  // action for "sign off the scoring run").
  if (ctx.industrySei.status === 'NOT_CALCULABLE') {
    cards.push({
      conditionId: -1,
      severity: 3,
      whatIsAtRisk: 'The industry service excellence gap cannot be calculated yet',
      evidence: [
        `${countOf(ctx.industrySei.contributingFirms, 'firm')} ${ctx.industrySei.contributingFirms === 1 ? 'has' : 'have'} a service excellence gap score that can be reported`,
        ctx.industrySei.contributingFirms === 0 && /signed-off/i.test(ctx.industrySei.reason ?? '')
          ? 'No scoring run has been signed off yet'
          : 'Too few firms to combine into an industry figure safely',
      ],
      consequence: [
        'The industry figure cannot be produced yet. It can be once scoring is signed off and enough firms have a reportable score of their own.',
      ],
      why: null,
      recommendedAction: null,
      projectedShortfall: 0,
      kind: 'methodology_block',
    });
  }

  // ── Engine 2 that raise INDEPENDENTLY (not covered by a live Engine-1) ───────
  // 13 (coverage, not volume) and 14 (attributable) always independent; the
  // others raise only if their segment has no live Engine-1 card.
  if (!closed && enabled(13)) {
    const tier = tierCoverageUneven(ctx.maturity, ctx.participatingFirmIds);
    if (tier.uneven) {
      cards.push(
        makeSimpleCard(
          13,
          0,
          [`Tier coverage ${tier.perTier.join(' / ')} across maturity thirds`],
          ['Firm-tier heatmap cannot be built evenly'],
        ),
      );
    }
  }
  // Condition 14: forecast while open, ACTUAL once closed (§6.3).
  if (enabled(14)) {
    const value = closed ? ctx.attributable.actual : ctx.attributable.forecast;
    if (value < ctx.attributable.required) {
      cards.push(
        makeSimpleCard(
          14,
          ctx.attributable.required - value,
          [
            `${closed ? 'Actual' : 'Forecast'} responses through firms' own links: ${Math.round(value)} of ${ctx.attributable.required} needed`,
          ],
          [
            'Every participating firm still receives its combined report, but with few responses through its own links that report will be thin and its client breakdowns may be withheld',
          ],
        ),
      );
    }
  }

  // ── Funnel-diagnosis cards raised ALONE (a firm-side stage is stuck, no firm
  // target card). The firm-side diagnosis is now a deterministic state, not a
  // quartile collapse (UX-OPS-003 correction). ─
  if (!closed && diagnosis.reason === 'stuck_stage' && !engine1LiveSegments.has('firm')) {
    if (enabled(diagnosis.conditionId)) {
      cards.push(
        makeSimpleCard(
          diagnosis.conditionId,
          0,
          [
            `${diagnosis.count} firm${diagnosis.count > 1 ? 's' : ''} in this state — ${diagnosis.remedy}.`,
          ],
          [diagnosis.label],
        ),
      );
    }
  }

  // ── Condition 16: Institutional Perspectives (status model, §7A) ─────────────
  // Does NOT evaluate while target_by is unset (DECISION NEEDED). Reporting-
  // dependency alert → survives close.
  if (enabled(16)) {
    for (const inst of ctx.institutions) {
      if (inst.status === 'declined') {
        cards.push(
          makeSimpleCard(
            16,
            0,
            [`${inst.institutionName} has declined`],
            ['Institutional Perspectives must be replanned, not chased'],
            1,
          ),
        );
        continue;
      }
      if (inst.targetBy === null) continue; // inert until a study-team date exists
      const late =
        ['not_started', 'invited', 'in_progress'].includes(inst.status) &&
        ctx.today > inst.targetBy;
      if (late) {
        cards.push(
          makeSimpleCard(
            16,
            0,
            [`${inst.institutionName} not engaged past its target of ${dbDateStr(inst.targetBy)}`],
            ['Institutional Perspectives at risk'],
          ),
        );
      }
    }
  }

  // ── Condition 23: firm invited, no activity for five days ────────────────────
  if (!closed && enabled(23)) {
    const stale = ctx.firmFunnel.filter((f) => {
      const row = ctx.firmFunnelMeta?.get(f.firmId);
      return (
        row &&
        row.invitedAt !== null &&
        row.lastFunnelActivity === null &&
        daysSince(row.invitedAt, ctx.today) >= 5
      );
    });
    if (stale.length > 0) {
      const rem = remediationForCohort('no_link_activity');
      const impact = expectedImpact(stale.length);
      cards.push({
        conditionId: 23,
        severity: 6,
        whatIsAtRisk: 'Firms invited five days ago with no activity of any kind',
        evidence: [
          `${countOf(stale.length, 'firm')} invited five or more days ago, with no activity since`,
        ],
        consequence: ['These firms have demonstrably not acted'],
        why: null,
        recommendedAction: {
          label: rem.label,
          cohort: 'no_link_activity',
          audienceId: rem.audienceId,
        },
        ...(impact !== undefined ? { expectedImpact: impact } : {}),
        projectedShortfall: 0,
      });
    }
  }

  // Before launch no one has been invited, so no chase or reminder exists yet:
  // every firm- or investor-side card points at the action that IS available —
  // getting the invitations out. Regulator cards keep their own follow-up.
  if (ctx.beforeLaunch) {
    const preLaunch = remediationForCohort('before_launch');
    for (const card of cards) {
      if (!card.recommendedAction || card.recommendedAction.cohort === 'regulator_follow_up') {
        continue;
      }
      card.recommendedAction = {
        label: preLaunch.label,
        cohort: 'before_launch',
        audienceId: preLaunch.audienceId,
      };
      delete card.expectedImpact;
    }
  }

  // Rank by severity (1 highest), then projected shortfall descending.
  cards.sort((a, b) => a.severity - b.severity || b.projectedShortfall - a.projectedShortfall);
  // A card with no recommended action does not belong on the board — EXCEPT a
  // methodology-block card (Phase 11), which has no action by design and must
  // still display.
  return cards.filter(
    (c) =>
      c.kind === 'methodology_block' ||
      (c.recommendedAction !== null &&
        (c.recommendedAction.audienceId !== null ||
          c.conditionId === 16 ||
          c.conditionId === 5 ||
          c.conditionId === 13 ||
          c.conditionId === 14)),
  );
}

function makeSimpleCard(
  conditionId: number,
  shortfall: number,
  evidence: string[],
  consequence: string[],
  severityOverride?: MissionCard['severity'],
): MissionCard {
  const cond = CONDITIONS.find((c) => c.id === conditionId)!;
  const rem = remediationForCohort(cond.cohort);
  return {
    conditionId,
    severity: severityOverride ?? cond.severity,
    whatIsAtRisk: cond.what,
    evidence,
    consequence,
    why: null,
    recommendedAction: { label: rem.label, cohort: cond.cohort, audienceId: rem.audienceId },
    projectedShortfall: shortfall,
  };
}

function dependsOnSegment(cond: ConditionMeta, seg: MissionSegment): boolean {
  // Engine-2 dependency by segment, matching the report_dependency map.
  // OMI/DMI (conditions 7/8) are NOT folded here (Phase 11): they are evaluated
  // against item-level complete-firm forecasts and raise their own cards, because
  // firm participation being on track does not make OMI/DMI complete.
  const map: Record<string, MissionSegment[]> = {
    IEI_ICI_HEADLINE: ['retail'],
    IEI_ICI_BY_SEGMENT: ['retail', 'local_institution', 'foreign_institution'],
    SEI_GAP: ['firm', 'retail'],
    LOCAL_VS_FOREIGN: ['local_institution', 'foreign_institution'],
    TOP_INVESTOR_FRUSTRATIONS: ['retail'],
  };
  return !!cond.output && (map[cond.output] ?? []).includes(seg);
}

function labelSegment(seg: MissionSegment): string {
  return seg === 'firm'
    ? 'Participating-firm'
    : seg === 'retail'
      ? 'National retail'
      : seg === 'local_institution'
        ? 'Local institution'
        : 'Foreign institution';
}

function cohortCountFor(ctx: BoardContext, cohort: RemediationCohort): number {
  // A coarse cohort size for expected-impact; the exact list is produced at
  // remediation time. Uses firm-funnel rows as the population proxy.
  switch (cohort) {
    case 'not_claimed':
      return ctx.firmFunnel.filter((f) => f.invited && !f.claimed).length;
    case 'claimed_no_assign':
      return ctx.firmFunnel.filter((f) => f.claimed && f.assignedSeats === 0).length;
    case 'assigned_outstanding':
      return ctx.firmFunnel.filter((f) => f.assignedSeats > 0 && f.completedSeats < 3).length;
    case 'no_outreach':
      return ctx.firmFunnel.filter((f) => f.completedSeats === 3).length;
    default:
      return ctx.firmFunnel.length;
  }
}

function daysSince(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

// ─── Building the context from live data ──────────────────────────────────────

/** Derive which of the four phases the edition is in (rail awareness). */
export function editionPhase(status: string, daysRemaining: number): EditionPhase {
  if (status === 'draft') return 'before_launch';
  if (status === 'locked' || status === 'archived' || daysRemaining <= 0) return 'closed';
  if (daysRemaining <= 7) return 'closing_week';
  return 'collection_open';
}

const SEGMENT_TARGET_DEFAULTS: Record<MissionSegment, number> = {
  firm: 80,
  retail: 1111,
  local_institution: 25,
  foreign_institution: 15,
};

/**
 * Assemble the board context from live tables at an evaluation instant. `asOf`
 * is injectable so evaluation is deterministic in tests; in production it is the
 * hourly cycle's timestamp.
 */
export async function buildBoardContext(
  pool: Pool,
  editionId: string,
  asOf: Date,
): Promise<BoardContext> {
  const edition = await getEditionById(pool, editionId);
  if (!edition) throw new MissionBoardError('Edition not found', 'NOT_FOUND');

  const openAt = edition.surveyOpenAt ?? edition.createdAt;
  const closeAt = edition.surveyCloseAt ?? asOf;
  const daysElapsed = Math.max(0, daysSince(openAt, asOf));
  const daysRemaining = Math.max(0, daysSince(asOf, closeAt));
  const windowStart = new Date(asOf.getTime() - Math.min(daysElapsed, 7) * 86_400_000);

  const floors = await listSampleFloors(pool, editionId);
  const floorOf = (seg: MissionSegment): number =>
    floors.find((f) => f.category === FLOOR_CATEGORY[seg])?.floorValue ??
    SEGMENT_TARGET_DEFAULTS[seg];

  const completedBySeg = await countCompletedBySegment(pool, editionId);
  const completedSince = await countCompletedBySegmentSince(pool, editionId, windowStart);
  // The participating-firms floor counts FIRMS with ≥1 seat complete (the same
  // rule as eligibility-service), never seat responses — three seats from one
  // firm are one participating firm.
  const firmCurrent = (await getFirmSeatCompletionCounts(pool, editionId)).filter(
    (c) => c.complete >= 1,
  ).length;
  const firmWindow = await countFirmsFirstCompletedSince(pool, editionId, windowStart);
  const localCurrent = await countDistinctInstitutions(pool, editionId, 'local_institution');
  const foreignCurrent = await countDistinctInstitutions(pool, editionId, 'foreign_institution');
  const localWindow = await countDistinctInstitutionsSince(
    pool,
    editionId,
    'local_institution',
    windowStart,
  );
  const foreignWindow = await countDistinctInstitutionsSince(
    pool,
    editionId,
    'foreign_institution',
    windowStart,
  );

  const currentOf: Record<MissionSegment, number> = {
    firm: firmCurrent,
    retail: completedBySeg['retail'] ?? 0,
    local_institution: localCurrent,
    foreign_institution: foreignCurrent,
  };
  const windowOf: Record<MissionSegment, number> = {
    firm: firmWindow,
    retail: completedSince['retail'] ?? 0,
    local_institution: localWindow,
    foreign_institution: foreignWindow,
  };

  const forecasts = {} as Record<MissionSegment, SegmentForecast>;
  for (const seg of [
    'firm',
    'retail',
    'local_institution',
    'foreign_institution',
  ] as MissionSegment[]) {
    forecasts[seg] = buildSegmentForecast({
      segment: seg,
      target: floorOf(seg),
      current: currentOf[seg],
      completesInWindow: windowOf[seg],
      daysElapsed,
      daysRemaining,
    });
  }

  // Item-level OMI/DMI complete forecasts (Phase 11): current vs as-of the window
  // start, so the pace of firms BECOMING complete drives the forecast — not raw
  // participation. Target is the firm floor (a complete-firm count is required).
  // OMI-/DMI-complete is the SAME function the Scoring page counts its effective
  // population with (completeFirmsForIndex), so the board, the Responses lines
  // and Scoring can never show different numbers for one firm.
  const firmFloor = floorOf('firm');
  const completeCount = async (metric: 'OMI' | 'DMI', at?: Date): Promise<number> =>
    (await completeFirmsForIndex(pool, editionId, metric, at)).firmIds.length;
  const omiCompleteNow = await completeCount('OMI');
  const omiCompleteThen = await completeCount('OMI', windowStart);
  const dmiCompleteNow = await completeCount('DMI');
  const dmiCompleteThen = await completeCount('DMI', windowStart);
  const missingRoleCounts = await missingOmiRoleCounts(pool, editionId);
  const omiCompleteForecast = buildSegmentForecast({
    segment: 'firm',
    target: firmFloor,
    current: omiCompleteNow,
    completesInWindow: Math.max(0, omiCompleteNow - omiCompleteThen),
    daysElapsed,
    daysRemaining,
  });
  const dmiCompleteForecast = buildSegmentForecast({
    segment: 'firm',
    target: firmFloor,
    current: dmiCompleteNow,
    completesInWindow: Math.max(0, dmiCompleteNow - dmiCompleteThen),
    daysElapsed,
    daysRemaining,
  });
  const industrySei = await industrySeiState(pool, editionId);

  const attributableCount = await countAttributable(pool, editionId);
  const funnelRows = await getFirmFunnelRows(pool, editionId);
  const firmFunnel: FirmFunnelInput[] = funnelRows.map((r) => ({
    firmId: r.firmId,
    invited: r.invitedAt !== null,
    claimed: r.claimedAt !== null,
    assignedSeats: r.assignedSeats,
    openedSeats: r.openedSeats,
    completedSeats: r.completedSeats,
  }));
  const firmFunnelMeta = new Map(
    funnelRows.map((r) => [
      r.firmId,
      { invitedAt: r.invitedAt, lastFunnelActivity: r.lastFunnelActivity },
    ]),
  );
  const participatingFirmIds = new Set(
    funnelRows.filter((r) => r.completedSeats >= 1).map((r) => r.firmId),
  );
  const maturity = await getFirmMaturityScores(pool, editionId);
  const institutions = await listInstitutionEngagement(pool, editionId);

  return {
    forecasts,
    omiCompleteForecast,
    dmiCompleteForecast,
    missingRoleCounts,
    industrySei,
    responseCounts: {
      local_institution: completedBySeg['local_institution'] ?? 0,
      foreign_institution: completedBySeg['foreign_institution'] ?? 0,
    },
    attributable: {
      forecast: forecasts.firm.forecastAtClose ?? attributableCount,
      actual: attributableCount,
      required: floorOf('firm'),
    },
    institutions,
    today: asOf,
    daysRemaining,
    beforeLaunch: edition.status === 'draft',
    firmFunnel,
    firmFunnelMeta,
    maturity,
    participatingFirmIds,
    medianFirmConversion: null, // no history model in Year-1 early fieldwork
  };
}

/** Evaluate the board live for an edition. */
export async function getMissionBoard(
  pool: Pool,
  editionId: string,
  asOf: Date,
): Promise<{ cards: MissionCard[]; phase: EditionPhase }> {
  const ctx = await buildBoardContext(pool, editionId, asOf);
  const edition = await getEditionById(pool, editionId);
  const cards = evaluateBoard(ctx);
  return { cards, phase: editionPhase(edition?.status ?? 'draft', ctx.daysRemaining) };
}
