import { requestBlob, type AdminClient } from '../api/client';
import { ApiError, type FirmReportContent, type IndustryReportContent } from '../api/types';
import { portalClient } from '../firm/portalClient';

/**
 * Where a report document comes from, and what its reader may do with it. One
 * report component renders for three readers:
 *
 * - `operator` — CIS staff: the live document, its narrative drafted by itself
 *   when due, with regenerate / publish controls and the review notes.
 * - `firm` — a firm's coordinators, in their portal: their OWN released report,
 *   frozen as released. Read and download only.
 * - `public` — anyone: the published Industry report. Read and download only.
 */
export type Audience = 'operator' | 'firm' | 'public';

export interface ReportSource<T> {
  audience: Audience;
  /** Identifies the document and reader: a source rebuilt each render with the same key is the same source. */
  key: string;
  load(): Promise<T>;
  /** Draft the narrative if it is due (operator only). */
  ensure?: () => Promise<unknown>;
  /** Redraft the narrative now (operator only, until the document is published). */
  regenerate?: () => Promise<unknown>;
  /** Publish the Industry report (operator only; normally automatic on approval). */
  publish?: () => Promise<unknown>;
  pdf: () => Promise<Blob>;
}

export const operatorIndustrySource = (
  client: AdminClient,
  editionId: string,
): ReportSource<IndustryReportContent> => ({
  audience: 'operator',
  key: `operator:industry:${editionId}`,
  load: () => client.getIndustryReport(editionId),
  ensure: () => client.ensureIndustryNarrative(editionId),
  regenerate: () => client.generateIndustryNarrative(editionId),
  publish: () => client.publishIndustryReport(editionId),
  pdf: () => client.downloadIndustryPdf(editionId),
});

export const operatorFirmSource = (
  client: AdminClient,
  editionId: string,
  firmId: string,
): ReportSource<FirmReportContent> => ({
  audience: 'operator',
  key: `operator:firm:${editionId}:${firmId}`,
  load: () => client.getFirmReport(editionId, firmId),
  ensure: () => client.ensureFirmNarrative(editionId, firmId),
  regenerate: () => client.generateFirmNarrative(editionId, firmId),
  pdf: () => client.downloadFirmPdf(editionId, firmId),
});

export const portalFirmSource = (
  token: string,
  editionId: string,
): ReportSource<FirmReportContent> => ({
  audience: 'firm',
  key: `firm:${editionId}`,
  load: async () => {
    const r = await portalClient.getReport(token, editionId);
    if (!r.report) throw new ApiError(404, 'Your firm report has not been released yet.');
    return r.report;
  },
  pdf: () => requestBlob(`/portal/editions/${editionId}/report/pdf`, token),
});

export const publicIndustrySource = (editionId: string): ReportSource<IndustryReportContent> => ({
  audience: 'public',
  key: `public:industry:${editionId}`,
  load: async () => {
    const res = await fetch(`/api/public/editions/${editionId}/industry-report`);
    const data = (await res.json()) as IndustryReportContent & { message?: string };
    if (!res.ok) throw new ApiError(res.status, data.message ?? 'This report is not available.');
    return data;
  },
  pdf: () => requestBlob(`/public/editions/${editionId}/industry-report/pdf`, null),
});

/**
 * Institutional Perspectives: the Industry report's own content and narrative
 * (it is that report's section 10), printed as its own document.
 */
export const operatorInstitutionalSource = (
  client: AdminClient,
  editionId: string,
): ReportSource<IndustryReportContent> => {
  // Published with the Industry report — never on its own, so no publish here.
  const { publish: _published, ...industry } = operatorIndustrySource(client, editionId);
  void _published;
  return {
    ...industry,
    key: `operator:institutional:${editionId}`,
    pdf: () => client.downloadInstitutionalPdf(editionId),
  };
};

export const publicInstitutionalSource = (
  editionId: string,
): ReportSource<IndustryReportContent> => ({
  ...publicIndustrySource(editionId),
  key: `public:institutional:${editionId}`,
  pdf: () => requestBlob(`/public/editions/${editionId}/institutional-report/pdf`, null),
});
