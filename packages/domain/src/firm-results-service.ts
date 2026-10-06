import { Pool } from 'pg';
import {
  getAuthoritativeSignoff,
  listCalculatedResults,
  getActiveMetricDefinitions,
  getConfig,
  getCoordinatorByAccessCode,
  countRetailRespondentsRatingFirm,
  hasReleasedFirmReport,
} from '@cis/db';
import type { FirmReportCutState, CalculatedResult } from '@cis/shared-types';
import { DomainError } from './errors';
import { getScoreView } from './scoring-signoff-service';
import { getRetailCutThresholds, cutStateFor } from './firm-report-service';

/**
 * UX-FRM-RES-001 — Firm Private Results. The display layer that finally lets a
 * firm SEE the report Phase 6 built the pipeline to produce. It READS existing
 * scoring output; it computes no new scores and applies NO secondary scaling.
 *
 * The one correctness rule that matters most (the v1.0 defect): comparison
 * direction is DERIVED from whether an index is structurally a gap (SEI, lower is
 * better) or a score (OMI/DMI/IEI/ICI, higher is better) — in ONE place
 * (`isGapIndex`), reused. There is deliberately NO per-index "better direction"
 * flag anywhere; a second hand-set flag is exactly the mismatch that read a
 * gap of 1.3 against 1.8 as "above the benchmark".
 *
 * Permanent nevers enforced structurally here: no institutional cut at firm level;
 * no other firm named and no ranking; a difference inside the margin makes no
 * claim; and figures reflect investors who RATED the firm (by `rated_firm_id`),
 * never investors who merely arrived via the firm's outreach link.
 */

export class FirmResultsError extends DomainError {
  constructor(message: string, code = 'FIRM_RESULTS') {
    super(message, code);
  }
}
export class FirmResultsAccessError extends DomainError {
  constructor(message: string, code = 'FIRM_RESULTS_ACCESS') {
    super(message, code);
  }
}

/** The five indices in display order, with their names. */
const INDICES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'OMI', name: 'Operational maturity' },
  { code: 'DMI', name: 'Digital maturity' },
  { code: 'IEI', name: 'Investor experience' },
  { code: 'ICI', name: 'Investor confidence' },
  { code: 'SEI', name: 'Service excellence gap' },
];

/**
 * THE SINGLE derivation point for comparison direction. SEI is structurally the
 * service-excellence GAP index (lower/narrower is better); the other four are
 * scores (higher is better). Never a per-index config/schema flag — deriving it
 * once removes the opportunity for the flag-set-by-hand mismatch to recur.
 */
export function isGapIndex(metricCode: string): boolean {
  return metricCode === 'SEI';
}

/**
 * Standing of `you` vs `industry`. Returns true (better), false (worse), or null
 * (inside the margin — NO claim either way). Direction is derived solely from
 * `gap`. Pure — the exact function from the artefact, MARGIN injected.
 */
export function standing(
  you: number,
  industry: number,
  gap: boolean,
  margin: number,
): boolean | null {
  const d = you - industry;
  if (Math.abs(d) < margin) return null;
  return gap ? d < 0 : d > 0;
}

export type StandingLabel = 'better' | 'worse' | 'within_margin' | 'unavailable';

/** Twelve-month active-broker scoping (§8). Investors answer firm-specific
 *  questions only for brokers actively used in the past twelve months, so the
 *  firm sees its RECENT clients, free of dormant accounts. Pure and structurally
 *  ready for 2027+; in Year 1 (one edition) every rating is within the window. */
export const ACTIVE_BROKER_MONTHS = 12;
export function withinActiveBrokerWindow(
  ratedAt: Date,
  asOf: Date,
  months: number = ACTIVE_BROKER_MONTHS,
): boolean {
  const windowStart = new Date(asOf);
  windowStart.setMonth(windowStart.getMonth() - months);
  return ratedAt.getTime() >= windowStart.getTime();
}

/** Provenance label DERIVED from the index's metric_definitions population, not
 *  hardcoded prose — a firm reading a low DMI must know it told us that itself. */
function provenanceFor(populationKind: string | undefined): string {
  switch (populationKind) {
    case 'firm_seats_complete':
      return 'From your own three surveys';
    case 'investor_responses':
      return 'From investors who rated you';
    case 'matched_pairs':
      return 'Your answers against what investors reported';
    default:
      return 'Source pending methodology';
  }
}

export interface FirmIndexResult {
  metricCode: string;
  name: string;
  /** The firm's own 0–100 value read straight from calculated_results — no scaling. */
  you: number | null;
  /** The anonymised industry aggregate (mean of per-firm values), from getScoreView. */
  industry: number | null;
  /** Whether this is structurally a gap index (SEI) — the comparison direction. */
  gap: boolean;
  /** Which side the number comes from, derived from the index's composition. */
  provenance: string;
  /** better / worse / within_margin / unavailable. */
  standing: StandingLabel;
  /** The unit line, which states "lower is better" on a gap index. */
  unit: string;
}

export interface FirmRetailCut {
  count: number;
  state: FirmReportCutState;
}

export interface FirmResults {
  firmId: string;
  editionId: string;
  margin: number;
  /** The five indices. There is deliberately NO institutional field, ever. */
  indices: FirmIndexResult[];
  retail: FirmRetailCut;
  /** The combined report is UNCONDITIONAL — always present regardless of volume. */
  combinedReportAvailable: true;
}

/** Verify the requester is an active coordinator OF THIS FIRM. Interim
 *  coordinator-only access default (§9) — a distinct decision from UX-FRM-007's
 *  handover/PIN boundary, flagged in the README, not hardcoded as final. */
async function assertCoordinatorAccess(
  pool: Pool,
  firmId: string,
  coordinatorAccessCode: string,
): Promise<void> {
  const coordinator = await getCoordinatorByAccessCode(pool, coordinatorAccessCode);
  if (!coordinator || coordinator.organizationId !== firmId) {
    throw new FirmResultsAccessError(
      'Only a coordinator of this firm may view its results',
      'ACCESS_DENIED',
    );
  }
}

function firmValue(results: CalculatedResult[], firmId: string, metricCode: string): number | null {
  const row = results.find(
    (r) => r.subjectType === 'firm' && r.subjectId === firmId && r.metricCode === metricCode,
  );
  return row ? row.value : null;
}

/**
 * Build a firm's private results for the authoritative signed-off run. Reads
 * per-firm values verbatim (no rescale), derives the industry aggregate via the
 * shared getScoreView, derives standing via the single `isGapIndex` rule, and
 * reuses Phase 6's retail-cut sufficiency. Coordinator-only.
 */
export async function getFirmResults(
  pool: Pool,
  input: { editionId: string; firmId: string; coordinatorAccessCode: string },
): Promise<FirmResults> {
  await assertCoordinatorAccess(pool, input.firmId, input.coordinatorAccessCode);

  // A firm sees its results with its report, never before: nothing reaches a
  // firm until CIS has approved and released its report.
  if (!(await hasReleasedFirmReport(pool, input.editionId, input.firmId))) {
    throw new FirmResultsError(
      'Your results are shared with your firm report, once CIS has released it.',
      'NOT_RELEASED',
    );
  }

  const signoff = await getAuthoritativeSignoff(pool, input.editionId);
  if (!signoff) {
    throw new FirmResultsError(
      'No signed-off scoring run exists for this edition yet',
      'NO_AUTHORITATIVE_RUN',
    );
  }
  const runId = signoff.calculationRunId;

  const marginCfg = await getConfig<number>(pool, 'reporting.comparison_margin');
  const margin = typeof marginCfg === 'number' ? marginCfg : 3;

  const results = await listCalculatedResults(pool, runId);
  const scoreView = await getScoreView(pool, input.editionId, runId);
  const metrics = await getActiveMetricDefinitions(pool);
  const populationKindOf = (code: string): string | undefined => {
    const m = metrics.find((x) => x.metricCode === code);
    const pop = (m?.config as { population?: { kind?: string } } | undefined)?.population;
    return pop?.kind;
  };

  const indices: FirmIndexResult[] = INDICES.map(({ code, name }) => {
    const you = firmValue(results, input.firmId, code);
    const industry = scoreView.find((v) => v.metricCode === code)?.score ?? null;
    const gap = isGapIndex(code);
    let label: StandingLabel;
    if (you === null || industry === null) {
      label = 'unavailable';
    } else {
      const st = standing(you, industry, gap, margin);
      label = st === null ? 'within_margin' : st ? 'better' : 'worse';
    }
    return {
      metricCode: code,
      name,
      you,
      industry,
      gap,
      provenance: provenanceFor(populationKindOf(code)),
      standing: label,
      unit: gap ? 'point gap — lower is better' : 'out of 100',
    };
  });

  // Retail category cut — Phase 6's EXISTING sufficiency, counted by rating
  // (rated_firm_id), never by arrival route.
  const retailCount = await countRetailRespondentsRatingFirm(pool, input.editionId, input.firmId);
  const thresholds = await getRetailCutThresholds(pool);
  const retail: FirmRetailCut = { count: retailCount, state: cutStateFor(retailCount, thresholds) };

  return {
    firmId: input.firmId,
    editionId: input.editionId,
    margin,
    indices,
    retail,
    combinedReportAvailable: true,
  };
}
