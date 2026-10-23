import { Pool } from 'pg';
import {
  getEditionById,
  getOrganizationById,
  getReportPublication,
  hasApprovedNationalReport,
  insertReportPublication,
  listActiveCoordinators,
  listReviewedNarrativeIds,
  getLatestNationalReportForEdition,
  withTransaction,
  insertReportSnapshot,
  claimReportDeliveryRecipients,
  countReportDeliverySends,
  type ReportNarrative,
  type ReportPublication,
} from '@cis/db';
import type { FirmReport } from '@cis/shared-types';
import type { FirmReportContent, IndustryReportContent } from './report-content-service';
import {
  industryReportSnapshotData,
  publishedIndustryReportContent,
  releasedFirmReportContent,
} from './report-snapshot-service';
import {
  ensureIndustryNarrative,
  getFirmNarrative,
  getIndustryNarrative,
  ReportPublicationError,
  type NarrativeModel,
} from './report-narrative-service';
import { writeAudit } from '@cis/audit';
import { queueTemplate } from './email-content';
import { emailBrand } from './email-templates';
import { siteOrigin } from './notice-links';
import { reportOptOutLink } from './submission-confirmation-service';

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
  // What goes public is the narrative the approved national report reviewed —
  // never one drafted after approval.
  const approved = await getLatestNationalReportForEdition(pool, editionId);
  const reviewed =
    approved?.status === 'approved' ? (await listReviewedNarrativeIds(pool, approved.id))[0] : null;
  const narrative = reviewed
    ? { id: reviewed }
    : await ensureIndustryNarrative(pool, editionId, model, publishedBy);
  if (!narrative) {
    throw new ReportPublicationError(
      'There are no figures to publish yet — too few responses have been received.',
      'NO_FIGURES',
    );
  }
  // Published and frozen together: the public report is served from this
  // snapshot from now on, never recomputed from a later sign-off.
  const frozen = await industryReportSnapshotData(pool, editionId, publishedBy);
  return withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const publication = await insertReportPublication(c, {
      editionId,
      kind: 'industry',
      subjectId: null,
      firmReportId: null,
      narrativeId: narrative.id,
      publishedBy,
    });
    await insertReportSnapshot(c, frozen);
    return publication;
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
  // Served from the snapshot frozen at publication — never recomputed.
  const { content } = await publishedIndustryReportContent(pool, editionId);
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
  // The newest released version, served from the snapshot frozen at release.
  const released = await releasedFirmReportContent(pool, editionId, firmId);
  if (!released) return null;
  const { content } = released;
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
    for (const c of coordinators) {
      await queueTemplate(pool, {
        kind: 'firm-report-released',
        refId: report.id,
        to: c.email,
        toName: c.name,
        template: 'F-13',
        fields: { contact_name: c.name, edition: edition?.label, firm, portal_link: portalUrl },
      });
      queued += 1;
    }
  }
  return queued;
}

// ─── D-04: the published report, to the investors who asked for it ───────────

/** Outbox kind of the published-report email; ref_id is the respondent. */
export const REPORT_PUBLISHED_EMAIL_KIND = 'report-published';

const DELIVERY_BATCH = 200;

export interface ReportDeliveryOptions {
  /** The public site's address (PORTAL_URL); links are built from its origin. */
  portalUrl?: string | null;
  /** Where questions go (SUPPORT_EMAIL); defaults to support@idhub.ng. */
  supportEmail?: string | null;
  /** The operator who published, for the audit entry. */
  actor?: { userId: string | null; ipAddress?: string | null; userAgent?: string | null };
  /** Respondents claimed and queued per transaction. */
  batchSize?: number;
}

/**
 * Email the published Industry report to every investor of its edition who
 * asked for it by email (report delivery 'email' or 'both', with an address,
 * submitted, not withdrawn, not opted out — opting out sets delivery to
 * 'none'). The Institutional Perspectives report is published with it, so one
 * email links both.
 *
 * Never twice: each respondent is written to the `report_delivery_sends`
 * ledger for this publication in the same transaction as their outbox email,
 * ON CONFLICT DO NOTHING, and only newly written rows are emailed. Safe to
 * retry, and to run again after a publish retry; a publication is permanent,
 * so an edition's report goes to a respondent once. Batched, so a long list
 * is never one huge transaction; the mail dispatcher throttles sending.
 *
 * The email carries a link only — never an answer or a figure. Returns how
 * many emails this call queued; an audit entry records the count.
 */
export async function sendPublishedReportToInvestors(
  pool: Pool,
  publication: ReportPublication,
  opts: ReportDeliveryOptions = {},
): Promise<number> {
  if (publication.kind !== 'industry') return 0;
  const origin = siteOrigin(opts.portalUrl);
  const edParam = `edition=${encodeURIComponent(publication.editionId)}`;
  const reportUrl = `${origin}/reports/industry?${edParam}`;
  const institutionalUrl = `${origin}/reports/institutional?${edParam}`;
  const edition = (await getEditionById(pool, publication.editionId))?.label;
  const batch = Math.max(1, opts.batchSize ?? DELIVERY_BATCH);
  const brand = opts.supportEmail?.trim()
    ? { ...emailBrand(), supportEmail: opts.supportEmail.trim() }
    : null;

  let queued = 0;
  for (;;) {
    const n = await withTransaction(pool, async (client) => {
      const recipients = await claimReportDeliveryRecipients(
        client,
        publication.id,
        publication.editionId,
        batch,
      );
      for (const r of recipients) {
        await queueTemplate(client, {
          kind: REPORT_PUBLISHED_EMAIL_KIND,
          refId: r.respondentId,
          to: r.email,
          template: 'P-05',
          fields: {
            report_url: reportUrl,
            institutional_url: institutionalUrl,
            optout_url: r.recoveryToken ? reportOptOutLink(opts.portalUrl, r.recoveryToken) : null,
            edition,
          },
          ...(brand ? { brand } : {}),
        });
      }
      return recipients.length;
    });
    queued += n;
    if (n < batch) break;
  }

  if (queued > 0) {
    await writeAudit(pool, {
      actorId: opts.actor?.userId ?? null,
      actionType: 'report_delivery.sent',
      entityType: 'report_publication',
      entityId: publication.id,
      editionId: publication.editionId,
      newValue: { count: queued, kind: REPORT_PUBLISHED_EMAIL_KIND },
      ipAddress: opts.actor?.ipAddress ?? null,
      userAgent: opts.actor?.userAgent ?? null,
    });
  }
  return queued;
}

/** How many investors a publication's report has been emailed to. */
export async function reportEmailedCount(pool: Pool, publicationId: string): Promise<number> {
  return countReportDeliverySends(pool, publicationId);
}
