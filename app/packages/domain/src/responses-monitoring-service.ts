import { Pool } from 'pg';
import { listReportDependencies, getConfig, type InstitutionEngagement } from '@cis/db';
import type { MissionSegment, SegmentForecast, ReportDependency } from '@cis/shared-types';
import { buildBoardContext } from './mission-board-service';
import { diagnoseFirmFunnel, type FunnelDiagnosis } from './mission-forecast';

/**
 * UX-OPS-003 — Responses monitoring. This surface REPORTS; the mission board is
 * where actions live (two places offering the same action is how they drift
 * apart), so every card links to its board condition rather than offering its own
 * action.
 *
 * Critically it does NOT re-implement any calculation: it reads the SAME
 * `buildBoardContext` the mission board evaluates, so the complete-firm risk it
 * shows and the board's conditions 7/8 can never diverge — one function, not two
 * (§B2). Firm-side complete-firm status is a STRUCTURED second line on the
 * participating-firms card (§B3), and the firm report is TWO dependency rows: the
 * guaranteed combined report, and the per-firm category cuts whose suppression is
 * designed, not a failure (§B4).
 */

const SEGMENTS: MissionSegment[] = ['firm', 'retail', 'local_institution', 'foreign_institution'];

const SEGMENT_LABEL: Record<MissionSegment, string> = {
  firm: 'Participating firms',
  retail: 'Retail investors',
  local_institution: 'Local institutions',
  foreign_institution: 'Foreign institutions',
};

/** The Engine-1 mission-board condition each segment card links to (§B6). */
const SEGMENT_BOARD_CONDITION: Record<MissionSegment, number> = {
  firm: 1,
  retail: 2,
  local_institution: 3,
  foreign_institution: 4,
};

export type SegmentCardState = 'on_track' | 'will_miss' | 'closed';

/** One completeness sub-line (OMI-complete or DMI-complete). */
export interface CompleteFirmLine {
  metric: 'OMI' | 'DMI';
  /** Instruments this completeness requires (S1+S2+S3 for OMI, S1+S3 for DMI). */
  requiredInstruments: string[];
  current: number;
  forecast: number | null;
  state: SegmentCardState;
}

export interface SegmentCard {
  segment: MissionSegment;
  label: string;
  current: number;
  target: number;
  /** current ÷ target as a %, capped at 100 (the grey bar). */
  greyBarPct: number;
  /** forecast ÷ target as a % (the red marker); null once closed / no forecast. */
  redMarkerPct: number | null;
  forecast: number | null;
  shortfall: number;
  velocity: number | null;
  requiredVelocity: number | null;
  daysRemaining: number;
  state: SegmentCardState;
  /** The mission-board condition this state links to (never an action of its own). */
  boardConditionId: number;
  /** Firm card only: complete-firm status as its OWN structured lines (§B3). */
  completeFirm?: CompleteFirmLine[];
}

export type DependencyDisplayState = 'guaranteed' | 'some_suppressed' | 'at_risk' | 'on_track';

export interface DependencyRow {
  outputId: string;
  dependsOn: string[];
  requiredInstruments: string[] | null;
  enabled: boolean;
  displayState: DependencyDisplayState;
  note: string;
  /** Regulator-dependent outputs only: regulators that have responded, of those required. */
  regulators?: { confirmed: number; required: number };
}

/**
 * Outputs that rest on the regulators, not on any investor segment: the
 * Institutional Perspectives section (PUB_10). Whatever segments a stored
 * dependency row lists, these read the regulator roles.
 */
const REGULATOR_OUTPUTS = new Set(['INSTITUTIONAL_PERSPECTIVES', 'PUBLIC_REPORT.PUB_10']);

/**
 * Institutional Perspectives is only published with all three regulators (SEC,
 * NGX and CSCS) — the national report's own `requires_all_regulators` rule,
 * which counts distinct institutions with a confirmed response.
 */
const REGULATORS_REQUIRED = 3;

export interface RegulatorStanding {
  confirmed: number;
  required: number;
  /** A regulator has declined, or is past the target date it was given. */
  slipping: boolean;
  closed: boolean;
}

function regulatorStanding(
  institutions: InstitutionEngagement[],
  today: Date,
  closed: boolean,
): RegulatorStanding {
  const confirmed = new Set(
    institutions.filter((i) => i.status === 'confirmed').map((i) => i.institutionId),
  ).size;
  const slipping = institutions.some(
    (i) =>
      i.status === 'declined' ||
      (i.targetBy !== null &&
        ['not_started', 'invited', 'in_progress'].includes(i.status) &&
        today > i.targetBy),
  );
  return { confirmed, required: REGULATORS_REQUIRED, slipping, closed };
}

export interface ResponsesMonitor {
  cards: SegmentCard[];
  dependencies: DependencyRow[];
  funnelDiagnosis: FunnelDiagnosis;
  industrySeiNotCalculable: boolean;
}

function cardStateOf(f: SegmentForecast): SegmentCardState {
  if (f.daysRemaining <= 0) return 'closed';
  return f.atRisk ? 'will_miss' : 'on_track';
}

function cap100(pct: number): number {
  return Math.min(100, Math.max(0, pct));
}

function toCard(f: SegmentForecast, complete?: CompleteFirmLine[]): SegmentCard {
  const state = cardStateOf(f);
  const greyBarPct = f.target > 0 ? cap100((f.current / f.target) * 100) : 0;
  const redMarkerPct =
    f.forecastAtClose === null || f.target <= 0 ? null : (f.forecastAtClose / f.target) * 100;
  return {
    segment: f.segment,
    label: SEGMENT_LABEL[f.segment],
    current: f.current,
    target: f.target,
    greyBarPct,
    redMarkerPct,
    forecast: f.forecastAtClose === null ? null : Math.round(f.forecastAtClose),
    shortfall: f.projectedShortfall,
    velocity: f.velocity,
    requiredVelocity: f.requiredVelocity,
    daysRemaining: f.daysRemaining,
    state,
    boardConditionId: SEGMENT_BOARD_CONDITION[f.segment],
    ...(complete ? { completeFirm: complete } : {}),
  };
}

function dependencyDisplay(
  dep: ReportDependency,
  atRiskSegments: Set<MissionSegment>,
  retailThin: boolean,
  regulators: RegulatorStanding,
): DependencyRow {
  const base = {
    outputId: dep.outputId,
    dependsOn: dep.dependsOn,
    requiredInstruments: dep.requiredInstruments,
    enabled: dep.enabled,
  };
  // Institutional Perspectives rests on the regulators, never on the local or
  // foreign investor segments: on track while all three can still respond, at
  // risk once one declines or slips past its target, or collection closes short.
  if (REGULATOR_OUTPUTS.has(dep.outputId)) {
    const { confirmed, required } = regulators;
    const met = confirmed >= required;
    const atRisk = !met && (regulators.slipping || regulators.closed);
    const progress = `${confirmed} of ${required} regulators have responded`;
    return {
      ...base,
      dependsOn: ['regulators'],
      requiredInstruments: null,
      regulators: { confirmed, required },
      displayState: atRisk ? 'at_risk' : 'on_track',
      note: met
        ? `${progress}.`
        : atRisk
          ? `${progress}. The section is published only with all ${required}.`
          : `${progress} so far. The section is published only with all ${required}.`,
    };
  }
  // §B4: the two firm-report rows are special.
  if (dep.outputId === 'PARTICIPATING_FIRM_REPORT') {
    return {
      ...base,
      displayState: 'guaranteed',
      note: 'Every participating firm receives its combined report, however few responses it has; few responses make it thinner, never withheld.',
    };
  }
  if (dep.outputId === 'PARTICIPATING_FIRM_REPORT_CATEGORY_CUTS') {
    return {
      ...base,
      displayState: retailThin ? 'some_suppressed' : 'on_track',
      note: 'A firm with too few retail clients responding does not get the breakdown for that group. This is expected for some firms and does not put the report at risk.',
    };
  }
  // Generic rows: at risk when any depended-on segment is at risk (matches the
  // OR sufficiency rules). Never re-derives a value — reads the segment states.
  const atRisk = dep.dependsOn.some((s) => atRiskSegments.has(s as MissionSegment));
  return {
    ...base,
    displayState: atRisk ? 'at_risk' : 'on_track',
    note: atRisk
      ? 'A group this output needs is forecast to miss its target.'
      : 'Every group this output needs is on course for its target.',
  };
}

/**
 * Build the whole Responses monitoring view for an edition at an instant. Reuses
 * `buildBoardContext` (the mission board's own computation) so nothing here can
 * diverge from the board.
 */
export async function getResponsesMonitor(
  pool: Pool,
  editionId: string,
  asOf: Date = new Date(),
): Promise<ResponsesMonitor> {
  const ctx = await buildBoardContext(pool, editionId, asOf);

  // Firm card carries OMI-complete / DMI-complete as structured lines, read from
  // the SAME forecasts conditions 7/8 use.
  const completeFirm: CompleteFirmLine[] = [
    {
      metric: 'OMI',
      requiredInstruments: ['S1', 'S2', 'S3'],
      current: ctx.omiCompleteForecast.current,
      forecast:
        ctx.omiCompleteForecast.forecastAtClose === null
          ? null
          : Math.round(ctx.omiCompleteForecast.forecastAtClose),
      state: cardStateOf(ctx.omiCompleteForecast),
    },
    {
      metric: 'DMI',
      requiredInstruments: ['S1', 'S3'],
      current: ctx.dmiCompleteForecast.current,
      forecast:
        ctx.dmiCompleteForecast.forecastAtClose === null
          ? null
          : Math.round(ctx.dmiCompleteForecast.forecastAtClose),
      state: cardStateOf(ctx.dmiCompleteForecast),
    },
  ];

  const cards = SEGMENTS.map((seg) =>
    toCard(ctx.forecasts[seg], seg === 'firm' ? completeFirm : undefined),
  );

  const atRiskSegments = new Set<MissionSegment>(SEGMENTS.filter((s) => ctx.forecasts[s].atRisk));
  const retailThin = ctx.forecasts.retail.atRisk;
  const deps = await listReportDependencies(pool);
  const regulators = regulatorStanding(ctx.institutions, ctx.today, ctx.daysRemaining <= 0);
  const dependencies = deps.map((d) =>
    dependencyDisplay(d, atRiskSegments, retailThin, regulators),
  );

  const funnelDiagnosis = diagnoseFirmFunnel(ctx.firmFunnel);

  return {
    cards,
    dependencies,
    funnelDiagnosis,
    industrySeiNotCalculable: ctx.industrySei.status === 'NOT_CALCULABLE',
  };
}

/** Read the current firm-report retail-cut thresholds (governed; for display). */
export async function getRetailCutForDisplay(
  pool: Pool,
): Promise<{ directional: number; reportable: number } | null> {
  const cfg = await getConfig<{ directional: number; reportable: number }>(
    pool,
    'reporting.retail_cut_thresholds',
  );
  return cfg ? { directional: cfg.directional, reportable: cfg.reportable } : null;
}
