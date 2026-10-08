import { Pool } from 'pg';
import { listReportDependencies, getConfig } from '@cis/db';
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
): DependencyRow {
  const base = {
    outputId: dep.outputId,
    dependsOn: dep.dependsOn,
    requiredInstruments: dep.requiredInstruments,
    enabled: dep.enabled,
  };
  // §B4: the two firm-report rows are special.
  if (dep.outputId === 'PARTICIPATING_FIRM_REPORT') {
    return {
      ...base,
      displayState: 'guaranteed',
      note: 'Combined report is guaranteed to every participating firm. At risk here means thin, not withheld.',
    };
  }
  if (dep.outputId === 'PARTICIPATING_FIRM_REPORT_CATEGORY_CUTS') {
    return {
      ...base,
      displayState: retailThin ? 'some_suppressed' : 'on_track',
      note: 'Per-firm category cuts are suppressed by design where a firm is thin — "Some suppressed", never "At risk".',
    };
  }
  // Generic rows: at risk when any depended-on segment is at risk (matches the
  // OR sufficiency rules). Never re-derives a value — reads the segment states.
  const atRisk = dep.dependsOn.some((s) => atRiskSegments.has(s as MissionSegment));
  return {
    ...base,
    displayState: atRisk ? 'at_risk' : 'on_track',
    note: atRisk ? 'A depended-on segment is forecast to miss its floor.' : 'On track.',
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
  const dependencies = deps.map((d) => dependencyDisplay(d, atRiskSegments, retailThin));

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
