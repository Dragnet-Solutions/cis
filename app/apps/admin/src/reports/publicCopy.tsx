/**
 * The public report pages' own words for the states before a report exists:
 * `/reports/industry` and its companion `/reports/institutional` each say which
 * document is not there yet, never the other's name.
 */

export type PublicReportKind = 'industry' | 'institutional';

export const publicReportKind = (pathname: string): PublicReportKind =>
  pathname.startsWith('/reports/institutional') ? 'institutional' : 'industry';

export const PUBLIC_REPORT_COPY: Record<PublicReportKind, { notPublished: string; when: string }> =
  {
    industry: {
      notPublished: 'No Industry report has been published yet.',
      when: 'It is published once the study closes and its national results are approved.',
    },
    institutional: {
      notPublished: 'The Institutional Perspectives report has not been published yet.',
      when: 'It is published with the Industry report, once the study closes and its national results are approved.',
    },
  };

/** No report of this kind has been published (no edition, or not yet for the one asked). */
export function PublicReportMissing({ kind }: { kind: PublicReportKind }): JSX.Element {
  const copy = PUBLIC_REPORT_COPY[kind];
  return (
    <main className="shell">
      <p className="eyebrow">CIS × Dragnet</p>
      <h1>{copy.notPublished}</h1>
      <p className="lede">
        {copy.when} <a href="/survey">Back to the study</a>
      </p>
    </main>
  );
}
