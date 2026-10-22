import { useEffect, useState } from 'react';
import { IndustryReport } from './IndustryReport';
import { InstitutionalReport } from './InstitutionalReport';
import { PublicReportMissing, publicReportKind } from './publicCopy';
import { publicIndustrySource, publicInstitutionalSource } from './source';

/**
 * The published Industry report, open to anyone: `/reports/industry`, and its
 * companion `/reports/institutional` (Institutional Perspectives), with
 * `?edition=…` for a particular edition (default: the latest published). Read
 * and download only — exactly what CIS published, frozen as published.
 */
export function PublicReport(): JSX.Element {
  const requested = new URLSearchParams(window.location.search).get('edition');
  const [editionId, setEditionId] = useState<string | null>(requested);
  const [missing, setMissing] = useState(false);
  const kind = publicReportKind(window.location.pathname);

  useEffect(() => {
    if (requested) return;
    void fetch('/api/public/industry-reports')
      .then((r) => r.json() as Promise<{ reports: Array<{ editionId: string }> }>)
      .then(({ reports }) => {
        if (reports[0]) setEditionId(reports[0].editionId);
        else setMissing(true);
      })
      .catch(() => setMissing(true));
  }, [requested]);

  if (missing) return <PublicReportMissing kind={kind} />;
  if (!editionId) return <p style={{ padding: 24 }}>Loading…</p>;
  const back = () => window.location.assign('/survey');
  return kind === 'institutional' ? (
    <InstitutionalReport source={publicInstitutionalSource(editionId)} onBack={back} />
  ) : (
    <IndustryReport source={publicIndustrySource(editionId)} onBack={back} />
  );
}
