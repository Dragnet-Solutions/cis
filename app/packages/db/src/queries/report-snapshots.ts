import { Pool } from 'pg';
import type { FirmReport } from '@cis/shared-types';
import { query } from '../client';
import { getFirmReport } from './firm-reports';

/**
 * A report's content frozen at the moment it left CIS — a firm report on
 * release, the Industry report on publication. A released report is served
 * from here and never recomputed, so a later sign-off cannot change it.
 * Permanent: the DB refuses UPDATE and DELETE.
 */
export interface ReportSnapshot {
  id: string;
  editionId: string;
  kind: 'industry' | 'firm';
  subjectId: string | null;
  firmReportId: string | null;
  firmReportVersion: number | null;
  nationalReportId: string | null;
  scoringRunId: string | null;
  methodologyVersion: string | null;
  methodologyStatus: string | null;
  content: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
}

interface RawSnapshotRow {
  id: string;
  edition_id: string;
  kind: 'industry' | 'firm';
  subject_id: string | null;
  firm_report_id: string | null;
  firm_report_version: number | null;
  national_report_id: string | null;
  scoring_run_id: string | null;
  methodology_version: string | null;
  methodology_status: string | null;
  content: Record<string, unknown>;
  created_by: string;
  created_at: Date;
}

function mapSnapshot(r: RawSnapshotRow): ReportSnapshot {
  return {
    id: r.id,
    editionId: r.edition_id,
    kind: r.kind,
    subjectId: r.subject_id,
    firmReportId: r.firm_report_id,
    firmReportVersion: r.firm_report_version,
    nationalReportId: r.national_report_id,
    scoringRunId: r.scoring_run_id,
    methodologyVersion: r.methodology_version,
    methodologyStatus: r.methodology_status,
    content: r.content,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** Freeze a report's content. Idempotent: an existing snapshot for the same
 *  firm report version (or the edition's Industry report) is kept as it was
 *  and returned. */
export async function insertReportSnapshot(
  pool: Pool,
  data: Omit<ReportSnapshot, 'id' | 'createdAt'>,
): Promise<ReportSnapshot> {
  await query(
    pool,
    `INSERT INTO report_snapshots
       (edition_id, kind, subject_id, firm_report_id, firm_report_version, national_report_id,
        scoring_run_id, methodology_version, methodology_status, content, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING`,
    [
      data.editionId,
      data.kind,
      data.subjectId,
      data.firmReportId,
      data.firmReportVersion,
      data.nationalReportId,
      data.scoringRunId,
      data.methodologyVersion,
      data.methodologyStatus,
      JSON.stringify(data.content),
      data.createdBy,
    ],
  );
  const saved =
    data.kind === 'firm'
      ? await getFirmReportSnapshot(pool, data.firmReportId ?? '')
      : await getIndustryReportSnapshot(pool, data.editionId);
  if (!saved) throw new Error('report snapshot insert returned no rows');
  return saved;
}

export async function getFirmReportSnapshot(
  pool: Pool,
  firmReportId: string,
): Promise<ReportSnapshot | null> {
  const res = await query<RawSnapshotRow>(
    pool,
    `SELECT * FROM report_snapshots WHERE kind = 'firm' AND firm_report_id = $1`,
    [firmReportId],
  );
  return res.rows[0] ? mapSnapshot(res.rows[0]) : null;
}

export async function getIndustryReportSnapshot(
  pool: Pool,
  editionId: string,
): Promise<ReportSnapshot | null> {
  const res = await query<RawSnapshotRow>(
    pool,
    `SELECT * FROM report_snapshots WHERE kind = 'industry' AND edition_id = $1`,
    [editionId],
  );
  return res.rows[0] ? mapSnapshot(res.rows[0]) : null;
}

/** The newest RELEASED version of a firm's report for an edition, if any. */
export async function getLatestReleasedFirmReport(
  pool: Pool,
  editionId: string,
  organizationId: string,
): Promise<FirmReport | null> {
  const res = await query<{ id: string }>(
    pool,
    `SELECT id FROM firm_reports
      WHERE edition_id = $1 AND organization_id = $2 AND release_state = 'released'
      ORDER BY version DESC
      LIMIT 1`,
    [editionId, organizationId],
  );
  const id = res.rows[0]?.id;
  if (!id) return null;
  return getFirmReport(pool, id);
}
