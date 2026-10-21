import { Pool } from 'pg';
import {
  getCalculationRun,
  getFirmReportSnapshot,
  getIndustryReportSnapshot,
  getLatestNationalReportForEdition,
  getLatestReleasedFirmReport,
  insertReportSnapshot,
  type ReportSnapshot,
} from '@cis/db';
import type { FirmReport } from '@cis/shared-types';
import {
  buildFirmReportContent,
  buildIndustryReportContent,
  type FirmReportContent,
  type IndustryReportContent,
} from './report-content-service';

/**
 * Released reports, frozen. When a firm report is released (or the Industry
 * report published) its full content — every figure, the indices, the scoring
 * run they came from and that run's methodology version — is stored once, and
 * every later read of the released report is served from it. Signing off a
 * newer run changes drafts, never what a firm or the public was given; a
 * correction is a new firm report version with its own snapshot.
 *
 * A report released before snapshots existed is frozen on its first read, from
 * its own scoring run, and served from that snapshot from then on.
 */

const LEGACY_FREEZE = 'system:first-read-after-release';

type SnapshotData = Omit<ReportSnapshot, 'id' | 'createdAt'>;

/**
 * What a firm report version freezes to: its content built from its OWN
 * scoring run. Built with the pool, outside any transaction (content is many
 * reads); `insertReportSnapshot` then stores it, inside the release's.
 */
export async function firmReportSnapshotData(
  pool: Pool,
  report: FirmReport,
  createdBy: string,
): Promise<SnapshotData> {
  const run = await getCalculationRun(pool, report.scoringRunId);
  const content = await buildFirmReportContent(pool, report.editionId, report.organizationId, {
    firmReport: report,
    scoringRunId: report.scoringRunId,
  });
  return {
    editionId: report.editionId,
    kind: 'firm',
    subjectId: report.organizationId,
    firmReportId: report.id,
    firmReportVersion: report.version,
    nationalReportId: null,
    scoringRunId: report.scoringRunId,
    methodologyVersion: run?.methodologyVersion ?? null,
    methodologyStatus: run?.methodologyStatus ?? null,
    content: content as unknown as Record<string, unknown>,
    createdBy,
  };
}

/** What the Industry report freezes to: built from the approved national
 *  report's scoring run. */
export async function industryReportSnapshotData(
  pool: Pool,
  editionId: string,
  createdBy: string,
): Promise<SnapshotData> {
  const national = await getLatestNationalReportForEdition(pool, editionId);
  const approved = national?.status === 'approved' ? national : null;
  const run = approved ? await getCalculationRun(pool, approved.scoringRunId) : null;
  const content = await buildIndustryReportContent(
    pool,
    editionId,
    approved ? { scoringRunId: approved.scoringRunId } : {},
  );
  return {
    editionId,
    kind: 'industry',
    subjectId: null,
    firmReportId: null,
    firmReportVersion: null,
    nationalReportId: approved?.id ?? null,
    scoringRunId: approved?.scoringRunId ?? null,
    methodologyVersion: run?.methodologyVersion ?? null,
    methodologyStatus: run?.methodologyStatus ?? null,
    content: content as unknown as Record<string, unknown>,
    createdBy,
  };
}

/** Freeze one firm report version from its own scoring run. Idempotent. */
export async function freezeFirmReport(
  pool: Pool,
  report: FirmReport,
  createdBy: string,
): Promise<ReportSnapshot> {
  const existing = await getFirmReportSnapshot(pool, report.id);
  if (existing) return existing;
  return insertReportSnapshot(pool, await firmReportSnapshotData(pool, report, createdBy));
}

/** Freeze the edition's Industry report. Idempotent. */
export async function freezeIndustryReport(
  pool: Pool,
  editionId: string,
  createdBy: string,
): Promise<ReportSnapshot> {
  const existing = await getIndustryReportSnapshot(pool, editionId);
  if (existing) return existing;
  return insertReportSnapshot(pool, await industryReportSnapshotData(pool, editionId, createdBy));
}

/** The frozen content of a firm's newest released report, or null when none
 *  of its versions has been released. Never recomputed. */
export async function releasedFirmReportContent(
  pool: Pool,
  editionId: string,
  firmId: string,
): Promise<{ content: FirmReportContent; snapshot: ReportSnapshot } | null> {
  const report = await getLatestReleasedFirmReport(pool, editionId, firmId);
  if (!report) return null;
  const snapshot = await freezeFirmReport(pool, report, LEGACY_FREEZE);
  return { content: snapshot.content as unknown as FirmReportContent, snapshot };
}

/** The frozen content of the edition's published Industry report. Call only
 *  once it is published. */
export async function publishedIndustryReportContent(
  pool: Pool,
  editionId: string,
): Promise<{ content: IndustryReportContent; snapshot: ReportSnapshot }> {
  const snapshot = await freezeIndustryReport(pool, editionId, LEGACY_FREEZE);
  return { content: snapshot.content as unknown as IndustryReportContent, snapshot };
}
