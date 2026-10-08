import { Pool } from 'pg';
import {
  getEditionById,
  getOrganizationById,
  getReportPublication,
  hasApprovedNationalReport,
  insertReportPublication,
  listActiveCoordinators,
  queueEmail,
  type ReportNarrative,
  type ReportPublication,
} from '@cis/db';
import type { FirmReport } from '@cis/shared-types';
import {
  buildFirmReportContent,
  buildIndustryReportContent,
  type FirmReportContent,
  type IndustryReportContent,
} from './report-content-service';
import {
  ensureIndustryNarrative,
  getFirmNarrative,
  getIndustryNarrative,
  ReportPublicationError,
  type NarrativeModel,
} from './report-narrative-service';

/**
 * Report delivery: what leaves CIS, frozen as it left.
 *
 * - The Industry report is PUBLISHED once the national report is approved —
 *   its narrative drafted if it is due, then pinned, so the public copy never
 *   changes afterwards.
 * - A firm report is RELEASED to its firm (firm-report-service.ts), its
 *   narrative pinned the same way; the firm's coordinators are then told it is
 *   in their portal. The notice says only that — no figure ever goes by email.
 *
 * What leaves is the narrative's PASSED sentences only: the held-back ones, and
 * who drafted it, stay with CIS.
 */

export interface PublicNarrative {
  model: string;
  createdAt: Date;
  sentences: Array<{ section: string; text: string; factIds: string[]; finding: null }>;
}

export function publicNarrative(n: ReportNarrative | null): PublicNarrative | null {
  return (
    n && {
      model: n.model,
      createdAt: n.createdAt,
      sentences: n.sentences
        .filter((s) => s.finding === null)
        .map((s) => ({ section: s.section, text: s.text, factIds: s.factIds, finding: null })),
    }
  );
}

/**
 * Publish the Industry report: only once the national report is approved, and
 * only with a written analysis. Idempotent — a published report stays as it was.
 */
export async function publishIndustryReport(
  pool: Pool,
  editionId: string,
  model: () => NarrativeModel,
  publishedBy: string,
): Promise<ReportPublication> {
  const existing = await getReportPublication(pool, editionId, 'industry', null);
  if (existing) return existing;
  if (!(await hasApprovedNationalReport(pool, editionId))) {
    throw new ReportPublicationError(
      'The Industry report is published once the national report is approved.',
      'NATIONAL_NOT_APPROVED',
    );
  }
  const narrative = await ensureIndustryNarrative(pool, editionId, model, publishedBy);
  if (!narrative) {
    throw new ReportPublicationError(
      'There are no figures to publish yet — too few responses have been received.',
      'NO_FIGURES',
    );
  }
  return insertReportPublication(pool, {
    editionId,
    kind: 'industry',
    subjectId: null,
    firmReportId: null,
    narrativeId: narrative.id,
    publishedBy,
  });
}

/** The public Industry report — only once published. */
export async function getPublishedIndustryReport(
  pool: Pool,
  editionId: string,
): Promise<IndustryReportContent & { narrative: PublicNarrative | null; publishedAt: Date }> {
  const published = await getReportPublication(pool, editionId, 'industry', null);
  if (!published) {
    throw new ReportPublicationError(
      'This Industry report has not been published.',
      'NOT_PUBLISHED',
    );
  }
  const content = await buildIndustryReportContent(pool, editionId);
  return {
    ...content,
    narrative: publicNarrative(await getIndustryNarrative(pool, editionId)),
    publishedAt: published.publishedAt,
  };
}

/** A firm's own report as released to it, or null while it has not been released. */
export async function getReleasedFirmReport(
  pool: Pool,
  editionId: string,
  firmId: string,
): Promise<(FirmReportContent & { narrative: PublicNarrative | null; releasedAt: Date }) | null> {
  const published = await getReportPublication(pool, editionId, 'firm', firmId);
  if (!published) return null;
  const content = await buildFirmReportContent(pool, editionId, firmId);
  return {
    ...content,
    narrative: publicNarrative(await getFirmNarrative(pool, editionId, firmId)),
    releasedAt: published.publishedAt,
  };
}

/**
 * Tell each released firm's active coordinators their report is in the portal.
 * Queued in the outbox (delivered, or logged when no mail server is set); a
 * notice never carries a figure, only where to find the report.
 */
export async function queueReleaseNotices(
  pool: Pool,
  released: FirmReport[],
  portalUrl: string,
): Promise<number> {
  let queued = 0;
  for (const report of released) {
    const [org, edition, coordinators] = await Promise.all([
      getOrganizationById(pool, report.organizationId),
      getEditionById(pool, report.editionId),
      listActiveCoordinators(pool, report.organizationId),
    ]);
    const firm = org?.displayName ?? 'your firm';
    const label = edition?.label ?? '';
    for (const c of coordinators) {
      await queueEmail(pool, {
        kind: 'firm-report-released',
        refId: report.id,
        toAddress: c.email,
        subject: `Your ${label} CIS-Dragnet firm report is ready`,
        bodyText: [
          `Dear ${c.name},`,
          '',
          `The private ${label} CIS-Dragnet Benchmark report for ${firm} has been released.`,
          'It sets your firm’s results against the anonymised industry benchmark, with your own investors’ view of your service.',
          '',
          `Sign in to the firm portal to read it and download the PDF: ${portalUrl}`,
          '',
          'The report is private to your firm. It is never shared with other firms or any third party.',
          '',
          'CIS × Dragnet Benchmark Study',
        ].join('\n'),
      });
      queued += 1;
    }
  }
  return queued;
}
