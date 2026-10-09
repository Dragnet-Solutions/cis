import { Pool } from 'pg';
import {
  getEditionById,
  getCalculationRun,
  listCalculationRuns,
  listCalculatedResults,
  listSampleFloors,
  getActiveMetricDefinitions,
  getFirmSeatCompletionMatrix,
  createSignoff,
  getSignoff,
  getLiveSignoffForRun,
  approveSignoffRow,
  rejectSignoffRow,
  supersedePriorSignoffs,
  hasSignedOffRun,
  getAuthoritativeSignoff,
  listSignoffs,
  withTransaction,
} from '@cis/db';
import type {
  CalculationRun,
  CalculatedResult,
  MetricDefinition,
  ScoringSignoff,
  ScoringCheckedAccount,
} from '@cis/shared-types';
import { DomainError } from './errors';
import { runScoring, type ScoringRunResult } from './calculation-service';
import { runCandidateScoring } from './candidate-scoring-service';
import { isMethodologyApproved } from './methodology-approval-service';

/**
 * UX-ADM-004 — Setup: Results, Scores (sign-off). The maker-checker gate on the
 * single most consequential action in the platform: which scoring run becomes
 * official. This service owns three things Phase 5 deliberately left open:
 *
 *   1. Scoring is BLOCKED while collection is open. A run against a changing
 *      dataset scores something that won't exist when anyone reads it, so the
 *      trigger REFUSES (it does not warn) unless the edition is locked.
 *   2. A run is made authoritative only by a signed-off record carrying a
 *      STRUCTURED account of what was checked — never a bare reason — approved
 *      by a different person than the requester. A later run supersedes an
 *      earlier signed one only WHEN THE NEW ONE IS SIGNED OFF; nothing already
 *      released is recalled.
 *   3. Per-index POPULATION predicates (OMI = all three seats; DMI = S1+S3) are
 *      read from metric_definitions config, never hardcoded, and each index's
 *      score is shown with its effective population and floor-clear status — a
 *      sub-floor index is FLAGGED, not hidden (what is reportable is decided at
 *      the national-report stage, not here).
 */

/**
 * The surface's state model, matching the artefact's `states_covered` exactly.
 * `blocked_collection_open`, `run_complete` and `validation_error` are surface
 * states not tied to a stored record; `request_signoff`/`review_request`/
 * `own_request`/`signed_off`/`superseded_run` are how a sign-off record reads
 * (the middle three being viewer-relative renderings of one row).
 */
export type ScoringSurfaceState =
  | 'blocked_collection_open'
  | 'run_complete'
  | 'request_signoff'
  | 'review_request'
  | 'own_request'
  | 'signed_off'
  | 'superseded_run'
  | 'validation_error';

export class ScoringSignoffError extends DomainError {
  constructor(message: string, code = 'SCORING_SIGNOFF') {
    super(message, code);
  }
}

/** The scoring trigger refused because the edition is not locked yet. */
export class ScoringBlockedError extends ScoringSignoffError {
  constructor(status: string) {
    super(
      `Scoring is blocked while collection is open — the edition must be locked first (current: ${status})`,
      'BLOCKED_COLLECTION_OPEN',
    );
  }
}

/** The sign-off payload was not the structured checked-account the gate requires. */
export class SignoffPayloadError extends ScoringSignoffError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

// ─── Trigger ─────────────────────────────────────────────────────────────────

/**
 * Trigger a scoring run over the edition's frozen dataset. HARD precondition:
 * the edition must be `locked` (Phase 1 lifecycle). This is a real gate on the
 * action, not a disabled button — a caller that reaches here with an open
 * edition is refused.
 */
export async function triggerScoringRun(
  pool: Pool,
  input: {
    editionId: string;
    methodologyVersion?: string;
    metricDefinitions?: MetricDefinition[];
    datasetHash?: string;
  },
): Promise<ScoringRunResult> {
  const edition = await getEditionById(pool, input.editionId);
  if (!edition) throw new ScoringSignoffError(`Edition ${input.editionId} not found`, 'NOT_FOUND');
  if (edition.status !== 'locked') {
    throw new ScoringBlockedError(edition.status);
  }
  // Once two people have approved the scoring methodology, a run computes the
  // five indices with it and is marked APPROVED; until then the provisional
  // placeholder runs, and no index score is reported.
  if (await isMethodologyApproved(pool)) {
    const result = await runCandidateScoring(pool, input.editionId, {
      methodologyStatus: 'APPROVED',
    });
    return { run: result.run, results: await listCalculatedResults(pool, result.run.id) };
  }
  return runScoring(pool, input);
}

/** Every run for an edition, newest first — the permanent scoring history. */
export async function listScoringRuns(pool: Pool, editionId: string): Promise<CalculationRun[]> {
  return listCalculationRuns(pool, editionId, 'scoring');
}

// ─── Structured sign-off payload ───────────────────────────────────────────────

/**
 * Validate the structured account. "The record is the check": every checklist
 * item must be explicitly confirmed. A bare string, a missing field, or an
 * unconfirmed item is a validation_error — the generic 4-character reason field
 * used elsewhere is deliberately not accepted here.
 */
export function validateCheckedAccount(account: unknown): asserts account is ScoringCheckedAccount {
  if (typeof account !== 'object' || account === null || Array.isArray(account)) {
    throw new SignoffPayloadError('A structured checked-account is required, not a bare reason');
  }
  const a = account as Record<string, unknown>;
  const required = [
    'populationCountsReviewed',
    'floorStatusReviewed',
    'dataQualityFlagsReviewed',
  ] as const;
  for (const field of required) {
    if (a[field] !== true) {
      throw new SignoffPayloadError(`The sign-off requires "${field}" to be explicitly confirmed`);
    }
  }
  if (a['notes'] !== undefined && typeof a['notes'] !== 'string') {
    throw new SignoffPayloadError('Notes, if present, must be text');
  }
}

/**
 * Request sign-off of a scoring run. Validates the structured payload, confirms
 * the run is a completed scoring run for this edition, and refuses if a live
 * (requested or signed-off) sign-off already exists for it.
 */
export async function requestSignoff(
  pool: Pool,
  input: {
    editionId: string;
    calculationRunId: string;
    requestedBy: string;
    checkedAccount: ScoringCheckedAccount;
  },
): Promise<ScoringSignoff> {
  validateCheckedAccount(input.checkedAccount);

  const run = await getCalculationRun(pool, input.calculationRunId);
  if (!run || run.editionId !== input.editionId) {
    throw new ScoringSignoffError('Scoring run not found for this edition', 'NOT_FOUND');
  }
  if (run.runType !== 'scoring' || run.status !== 'complete') {
    throw new ScoringSignoffError(
      'Only a completed scoring run can be signed off',
      'RUN_NOT_SCOREABLE',
    );
  }

  const existing = await getLiveSignoffForRun(pool, input.calculationRunId);
  if (existing) {
    throw new ScoringSignoffError(
      `This run already has a ${existing.state} sign-off`,
      'SIGNOFF_EXISTS',
    );
  }

  return createSignoff(pool, {
    editionId: input.editionId,
    calculationRunId: input.calculationRunId,
    requestedBy: input.requestedBy,
    checkedAccount: input.checkedAccount,
  });
}

/**
 * Approve a requested sign-off (maker ≠ checker). Approving it makes the run
 * authoritative AND supersedes any previously signed-off run for the edition —
 * the supersession happens HERE, at approval, not when the later run was merely
 * created. Both writes are one transaction so the edition never has two live
 * authoritative runs.
 */
export async function approveSignoff(
  pool: Pool,
  input: { signoffId: string; approvedBy: string },
): Promise<ScoringSignoff> {
  const signoff = await getSignoff(pool, input.signoffId);
  if (!signoff) throw new ScoringSignoffError('Sign-off not found', 'NOT_FOUND');
  if (signoff.state !== 'requested') {
    throw new ScoringSignoffError(
      `Only a requested sign-off can be approved (state: ${signoff.state})`,
      'NOT_REQUESTED',
    );
  }
  if (signoff.requestedBy === input.approvedBy) {
    throw new ScoringSignoffError(
      'A maker can never approve their own sign-off request',
      'SELF_APPROVAL',
    );
  }

  return withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const approved = await approveSignoffRow(c, input.signoffId, input.approvedBy);
    if (!approved) {
      // Lost a race, or the maker-checker DB CHECK rejected it.
      throw new ScoringSignoffError('Sign-off could not be approved', 'NOT_REQUESTED');
    }
    // Supersede any earlier authoritative run — never this one.
    await supersedePriorSignoffs(c, approved.editionId, approved.id);
    return approved;
  });
}

/**
 * Reject a requested sign-off (maker ≠ checker), with a reason — the same
 * maker-checker shape as `approveSignoff`, and the same requirement every
 * other reject path on the platform enforces (edition lock/instrument freeze
 * via `critical_actions`): a bare rejection with no reason is not accepted.
 * The run stays un-authoritative and free for a fresh sign-off request.
 */
export async function rejectSignoff(
  pool: Pool,
  input: { signoffId: string; rejectedBy: string; reason: string },
): Promise<ScoringSignoff> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new SignoffPayloadError('Rejecting a sign-off requires a reason');
  }

  const signoff = await getSignoff(pool, input.signoffId);
  if (!signoff) throw new ScoringSignoffError('Sign-off not found', 'NOT_FOUND');
  if (signoff.state !== 'requested') {
    throw new ScoringSignoffError(
      `Only a requested sign-off can be rejected (state: ${signoff.state})`,
      'NOT_REQUESTED',
    );
  }
  if (signoff.requestedBy === input.rejectedBy) {
    throw new ScoringSignoffError(
      'A maker can never reject their own sign-off request',
      'SELF_REJECTION',
    );
  }

  const rejected = await rejectSignoffRow(pool, input.signoffId, input.rejectedBy, reason);
  if (!rejected) {
    // Lost a race, or the maker-checker DB CHECK rejected it.
    throw new ScoringSignoffError('Sign-off could not be rejected', 'NOT_REQUESTED');
  }
  return rejected;
}

// ─── Score view (transparency before sign-off) ─────────────────────────────────

export interface IndexScoreView {
  metricCode: string;
  /** Aggregate score on the 0–100 scale, or null while the methodology is still
   *  a provisional placeholder (shown as "pending validation", never as final). */
  score: number | null;
  /** Human-readable description of the index's population predicate. */
  populationLabel: string;
  /** The effective population count, or null for an unspecified (gap) predicate. */
  effectivePopulation: number | null;
  /** The floor this population is measured against, or null when not applicable. */
  floor: number | null;
  /** Whether the population clears its floor; null when floor/pop is unknown. */
  clearsFloor: boolean | null;
  /** A sub-floor index is FLAGGED (not hidden). True only when we can tell. */
  subFloor: boolean;
  /** Whether the weighting is still provisional (pending methodology validation). */
  provisional: boolean;
  /** True when this index's population predicate is an unresolved methodology gap. */
  populationGap: boolean;
}

interface PopulationPredicate {
  kind: string;
  seats?: string[];
  gap?: boolean;
  note?: string;
}

type SeatMatrix = Array<{ organizationId: string; completeSeats: string[] }>;

/** The firms in a firm-side population: those whose named seats are ALL complete. */
function firmsWithSeatsComplete(seats: string[], matrix: SeatMatrix): string[] {
  return matrix
    .filter((f) => seats.every((s) => f.completeSeats.includes(s)))
    .map((f) => f.organizationId);
}

/** Seats each firm-side index needs when its metric definition names none. */
const DEFAULT_INDEX_SEATS: Record<'OMI' | 'DMI', string[]> = {
  OMI: ['S1', 'S2', 'S3'],
  DMI: ['S1', 'S3'],
};

/**
 * The OMI-complete / DMI-complete firms — the ONE definition the Scoring page's
 * effective population, the mission board (conditions 7/8) and the Responses
 * complete-firm lines all read, so they cannot disagree. It is the index's own
 * configured population predicate (OMI: S1, S2 and S3 complete; DMI: S1 and S3
 * complete). `asOf` reads it at an earlier instant (the board's pace window).
 */
export async function completeFirmsForIndex(
  pool: Pool,
  editionId: string,
  metricCode: 'OMI' | 'DMI',
  asOf?: Date,
): Promise<{ seats: string[]; firmIds: string[] }> {
  const metric = (await getActiveMetricDefinitions(pool)).find((m) => m.metricCode === metricCode);
  const predicate = (metric?.config as { population?: PopulationPredicate } | undefined)
    ?.population;
  const seats =
    predicate?.kind === 'firm_seats_complete' && Array.isArray(predicate.seats)
      ? predicate.seats
      : DEFAULT_INDEX_SEATS[metricCode];
  const matrix = await getFirmSeatCompletionMatrix(pool, editionId, asOf);
  return { seats, firmIds: firmsWithSeatsComplete(seats, matrix) };
}

/** Describe (and where possible count) an index's population from its config. */
function describePopulation(
  predicate: PopulationPredicate | undefined,
  matrix: SeatMatrix,
): { label: string; count: number | null; gap: boolean } {
  if (!predicate) {
    return { label: 'Population not configured', count: null, gap: true };
  }
  if (predicate.kind === 'firm_seats_complete' && Array.isArray(predicate.seats)) {
    const seats = predicate.seats;
    const count = firmsWithSeatsComplete(seats, matrix).length;
    const label =
      seats.length === 3
        ? 'Complete firms — all three seats (S1, S2, S3)'
        : `Firms with ${seats.join(' and ')} complete`;
    return { label, count, gap: false };
  }
  // investor_responses / matched_pairs / anything else: an unresolved gap.
  // The stored `note` is internal methodology commentary, so it is never the
  // on-screen label — the label is fixed per kind.
  const label =
    predicate.kind === 'matched_pairs'
      ? 'Matched firm–investor pairs (definition pending methodology sign-off)'
      : 'Investor responses (definition pending methodology sign-off)';
  return { label, count: null, gap: true };
}

/** Aggregate a run's per-firm values for a metric into a display score (mean of
 *  the non-null values), rounded to one decimal. Null when nothing scored. */
function aggregateScore(results: CalculatedResult[], metricCode: string): number | null {
  // A run under the approved methodology records the industry figure itself.
  const industry = results.find(
    (r) => r.subjectType === 'market' && r.subjectId === 'INDUSTRY' && r.metricCode === metricCode,
  );
  if (industry) return industry.value === null ? null : Math.round(industry.value * 10) / 10;
  const values = results
    .filter((r) => r.metricCode === metricCode && r.value !== null)
    .map((r) => r.value as number);
  if (values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(mean * 10) / 10;
}

/**
 * The pre-sign-off transparency view: every index with its score, effective
 * population, and floor-clear status. Firm-side indices are measured against the
 * participating-firm floor; a below-floor population is flagged, never hidden.
 */
export async function getScoreView(
  pool: Pool,
  editionId: string,
  calculationRunId: string,
): Promise<IndexScoreView[]> {
  const metrics = await getActiveMetricDefinitions(pool);
  const results = await listCalculatedResults(pool, calculationRunId);
  const matrix = await getFirmSeatCompletionMatrix(pool, editionId);
  const floors = await listSampleFloors(pool, editionId);
  const firmFloor = floors.find((f) => f.category === 'firm')?.floorValue ?? null;

  return metrics.map((m) => {
    const predicate = (m.config as { population?: PopulationPredicate }).population;
    const pop = describePopulation(predicate, matrix);
    // Firm-side indices clear against the participating-firm floor; investor-side
    // (gap) indices have no resolved floor here.
    const floor = pop.gap ? null : firmFloor;
    const clearsFloor = pop.count === null || floor === null ? null : pop.count >= floor;
    return {
      metricCode: m.metricCode,
      score: aggregateScore(results, m.metricCode),
      populationLabel: pop.label,
      effectivePopulation: pop.count,
      floor,
      clearsFloor,
      subFloor: clearsFloor === false,
      provisional: m.isProvisional,
      populationGap: pop.gap,
    };
  });
}

// ─── Re-exports of the raw queries the routes/tests read ───────────────────────
export { hasSignedOffRun, getAuthoritativeSignoff, listSignoffs, getSignoff };
