import { Pool } from 'pg';
import {
  getConfig,
  createFirmReport,
  getFirmReport,
  listFirmReports,
  latestVersionFor,
  setGenerationState,
  setApprovalState,
  setReleaseState,
  insertReleaseHistory,
  hasApprovedNationalReport,
  hasSignedOffRun,
  countRetailRespondentsRatingFirm,
  insertReportPublication,
} from '@cis/db';
import type { FirmReport, FirmReportCutState } from '@cis/shared-types';
import { DomainError } from './errors';
import { eligibleFirmIds } from './eligibility-service';
import { assertRunOfficialUsable } from './candidate-scoring-service';

/**
 * Firm reports — generation, reconciliation, and ATOMIC-PER-REPORT release of
 * 80+ individual reports. The guarantee: FRM_01/02/03 are produced for every
 * participating firm regardless of volume; only the retail cut (FRM_04) is
 * gated. A firm never receives an institutional cut of itself — this module has
 * no code path that could produce one. Nothing released is ever recalled.
 */

export class FirmReportError extends DomainError {
  constructor(message: string, code = 'FIRM_REPORT') {
    super(message, code);
  }
}

/** The FRM_04 retail-cut thresholds are governed configuration, explicitly
 *  provisional — never hardcoded constants. */
export interface RetailCutThresholds {
  directional: number;
  reportable: number;
  provisional?: boolean;
}

const DEFAULT_THRESHOLDS: RetailCutThresholds = {
  directional: 10,
  reportable: 30,
  provisional: true,
};

export async function getRetailCutThresholds(pool: Pool): Promise<RetailCutThresholds> {
  const cfg = await getConfig<RetailCutThresholds>(pool, 'reporting.retail_cut_thresholds');
  return cfg ?? DEFAULT_THRESHOLDS;
}

/** Three states, not two: below `directional` nothing; `directional`..`reportable`-1
 *  DIRECTIONAL only; `reportable`+ unlocked. */
export function cutStateFor(n: number, t: RetailCutThresholds): FirmReportCutState {
  if (n >= t.reportable) return 'unlocked';
  if (n >= t.directional) return 'directional';
  return 'none';
}

export interface GenerationResult {
  zeroFirms: boolean;
  reports: FirmReport[];
  reconciled: boolean;
  expectedCount: number;
  generatedCount: number;
}

/**
 * Generate one report per participating firm (≥1 of S1/S2/S3 complete), as its
 * own tracked phase before any release. Reconciles the produced set against the
 * participating-firm count. Zero participating firms is a real, valid outcome —
 * "nothing to produce" — reported distinctly, never as a suppression.
 *
 * `failFor` lets a caller inject a generation failure for a firm (a recoverable
 * fault) — that report is marked `failed`, held later, never silently excluded.
 */
export async function generateFirmReports(
  pool: Pool,
  data: { editionId: string; scoringRunId: string; failFor?: string[] },
): Promise<GenerationResult> {
  // Hard methodology gate (Phase 11, build note §2): a TEST_UNAPPROVED run can
  // never produce firm reports. Checked before the sign-off gate so an unapproved
  // methodology is refused even in the (impossible) event such a run signed off.
  await assertRunOfficialUsable(pool, data.scoringRunId, 'firm report generation');
  // A run may back a firm report only if it has a genuine signed-off record
  // (UX-ADM-004) — the same rule that gates the national report. A merely
  // completed run is not eligible.
  if (!(await hasSignedOffRun(pool, data.scoringRunId))) {
    throw new FirmReportError(
      'Firm reports can only be generated from a signed-off scoring run',
      'SCORING_RUN_NOT_SIGNED_OFF',
    );
  }
  const firms = await eligibleFirmIds(pool, data.editionId);
  if (firms.length === 0) {
    return { zeroFirms: true, reports: [], reconciled: true, expectedCount: 0, generatedCount: 0 };
  }
  const thresholds = await getRetailCutThresholds(pool);
  const failSet = new Set(data.failFor ?? []);
  const reports: FirmReport[] = [];

  for (const firmId of firms) {
    const retailN = await countRetailRespondentsRatingFirm(pool, data.editionId, firmId);
    const version = (await latestVersionFor(pool, data.editionId, firmId)) + 1;
    const report = await createFirmReport(pool, {
      editionId: data.editionId,
      organizationId: firmId,
      scoringRunId: data.scoringRunId,
      version,
      retailN,
      cutState: cutStateFor(retailN, thresholds),
      generationState: failSet.has(firmId) ? 'failed' : 'generated',
    });
    reports.push(report);
  }

  const generatedCount = reports.filter((r) => r.generationState === 'generated').length;
  return {
    zeroFirms: false,
    reports,
    // The full set was produced (one row per participating firm) even if some
    // rows are in a `failed` state — reconciliation is about coverage, and a
    // failure is named and retriable, never a silent gap.
    reconciled: reports.length === firms.length,
    expectedCount: firms.length,
    generatedCount,
  };
}

/** Mark a firm report approved (only once it has generated). */
export async function approveFirmReport(pool: Pool, id: string): Promise<FirmReport> {
  const report = await getFirmReport(pool, id);
  if (!report) throw new FirmReportError('Firm report not found', 'NOT_FOUND');
  if (report.generationState !== 'generated') {
    throw new FirmReportError(
      'A report can be approved only once it has generated',
      'NOT_GENERATED',
    );
  }
  return setApprovalState(pool, id, 'approved');
}

/**
 * Retry a failed (or held) report's generation (a recoverable fault) — never a
 * released one. A released report is immutable structurally (the DB itself
 * refuses any UPDATE to a released row); this checks it first so the refusal
 * is a clean domain error, not a raw trigger exception. A correction to a
 * released report is a new version, never an edit to the released one.
 */
export async function regenerateFirmReport(pool: Pool, id: string): Promise<FirmReport> {
  const report = await getFirmReport(pool, id);
  if (!report) throw new FirmReportError('Firm report not found', 'NOT_FOUND');
  if (report.releaseState === 'released') {
    throw new FirmReportError(
      'A released firm report is immutable and cannot be regenerated',
      'ALREADY_RELEASED',
    );
  }
  const updated = await setGenerationState(pool, id, 'generated');
  await insertReleaseHistory(pool, {
    firmReportId: id,
    editionId: report.editionId,
    organizationId: report.organizationId,
    action: 'regenerated',
  });
  return updated;
}

export interface ReleaseResult {
  released: FirmReport[];
  held: Array<{ report: FirmReport; reason: string }>;
}

/**
 * Release, ATOMIC PER REPORT. Blocked entirely until the national report is
 * approved (firm reports carry the industry aggregate a firm is measured
 * against). Each report that has individually generated AND been approved
 * releases; every other is HELD — not excluded — with a reason, and the release
 * history records which released, which were held, and why. A held report does
 * not block any other firm. An already-released report is left untouched
 * (releasing is not repeated — the DB also forbids editing a released row).
 *
 * With `prepare`, a report goes out only with its written analysis: `prepare`
 * returns the narrative to freeze into it (drafting it if due), and a report
 * whose analysis cannot be prepared is HELD with the reason, like any other
 * report that is not ready. Preparation runs a few reports at a time.
 */
export interface ReleaseOptions {
  prepare: (report: FirmReport) => Promise<{ narrativeId: string }>;
  releasedBy: string;
  concurrency?: number;
}

export async function releaseFirmReports(
  pool: Pool,
  editionId: string,
  options?: ReleaseOptions,
): Promise<ReleaseResult> {
  if (!(await hasApprovedNationalReport(pool, editionId))) {
    throw new FirmReportError(
      'Firm reports cannot be released until the national report is approved',
      'NATIONAL_NOT_APPROVED',
    );
  }

  const reports = await listFirmReports(pool, editionId);
  const released: FirmReport[] = [];
  const held: Array<{ report: FirmReport; reason: string }> = [];

  // Hard methodology gate (Phase 11, build note §2): the release path is the
  // final official-output boundary. No report backed by a TEST_UNAPPROVED run may
  // pass it — a structural failure, checked once per distinct scoring run.
  const gatedRuns = new Set<string>();
  for (const r of reports) {
    if (r.releaseState === 'released' || gatedRuns.has(r.scoringRunId)) continue;
    await assertRunOfficialUsable(pool, r.scoringRunId, 'firm report release');
    gatedRuns.add(r.scoringRunId);
  }

  const isReady = (r: FirmReport) =>
    r.releaseState !== 'released' &&
    r.generationState === 'generated' &&
    r.approvalState === 'approved';
  const prepared = new Map<string, { narrativeId: string } | { failed: string }>();
  if (options) {
    const queue = reports.filter(isReady);
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        try {
          prepared.set(r.id, await options.prepare(r));
        } catch (err) {
          prepared.set(r.id, { failed: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: options.concurrency ?? 4 }, worker));
  }

  for (const r of reports) {
    if (r.releaseState === 'released') continue; // never recalled, never re-released
    const prep = prepared.get(r.id);
    const unprepared = prep && 'failed' in prep ? prep.failed : null;
    const ready = isReady(r) && unprepared === null;
    if (ready) {
      const updated = await setReleaseState(pool, r.id, 'released');
      if (prep && 'narrativeId' in prep && options) {
        await insertReportPublication(pool, {
          editionId,
          kind: 'firm',
          subjectId: r.organizationId,
          firmReportId: r.id,
          narrativeId: prep.narrativeId,
          publishedBy: options.releasedBy,
        });
      }
      await insertReleaseHistory(pool, {
        firmReportId: r.id,
        editionId,
        organizationId: r.organizationId,
        action: 'released',
      });
      released.push(updated);
    } else {
      const reason =
        unprepared !== null
          ? `The written analysis could not be prepared — held until it can: ${unprepared}`
          : r.generationState === 'failed'
            ? 'Report failed to generate — held for regeneration, not excluded.'
            : r.generationState !== 'generated'
              ? 'Report has not finished generating.'
              : 'Report has not been approved.';
      const updated = await setReleaseState(pool, r.id, 'held', reason);
      await insertReleaseHistory(pool, {
        firmReportId: r.id,
        editionId,
        organizationId: r.organizationId,
        action: 'held',
        reason,
      });
      held.push({ report: updated, reason });
    }
  }
  return { released, held };
}

/**
 * A correction after release is a NEW, separately-versioned report — never an
 * edit to the released one (the DB blocks that too). The released report stands.
 */
export async function correctFirmReport(
  pool: Pool,
  data: { editionId: string; organizationId: string; scoringRunId: string },
): Promise<FirmReport> {
  // Hard methodology gate (Phase 11): a correction is an official firm report too.
  await assertRunOfficialUsable(pool, data.scoringRunId, 'a firm report correction');
  // A correction is generated from a NEW signed-off run (§ "nothing already
  // released is recalled; a correction is a new, separately-versioned report").
  if (!(await hasSignedOffRun(pool, data.scoringRunId))) {
    throw new FirmReportError(
      'A firm report correction can only be generated from a signed-off scoring run',
      'SCORING_RUN_NOT_SIGNED_OFF',
    );
  }
  const thresholds = await getRetailCutThresholds(pool);
  const retailN = await countRetailRespondentsRatingFirm(pool, data.editionId, data.organizationId);
  const version = (await latestVersionFor(pool, data.editionId, data.organizationId)) + 1;
  return createFirmReport(pool, {
    editionId: data.editionId,
    organizationId: data.organizationId,
    scoringRunId: data.scoringRunId,
    version,
    retailN,
    cutState: cutStateFor(retailN, thresholds),
    generationState: 'generated',
  });
}

export async function getFirmReports(pool: Pool, editionId: string): Promise<FirmReport[]> {
  return listFirmReports(pool, editionId);
}
