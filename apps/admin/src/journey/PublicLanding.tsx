import { useEffect, useState } from 'react';

/**
 * UX-PUB-001 public landing. Built in full, INCLUDING the results section, which
 * is shown or hidden by a governed content flag (public.results_section_visible)
 * — a Year-1 content decision, not a code change. The firm call-to-action links
 * directly to the firm portal (`/firm`), a separate top-level surface (see
 * apps/admin/src/main.tsx) — not routed through this app's own screen state.
 */
export function PublicLanding({
  editionLabel,
  resultsSectionVisible,
  onTakeRetail,
  onTakeInstitutional,
  onHelpAbout,
  onPreviousEditions,
}: {
  editionLabel: string | null;
  resultsSectionVisible: boolean;
  onTakeRetail: () => void;
  onTakeInstitutional: () => void;
  onHelpAbout: () => void;
  onPreviousEditions: () => void;
}): JSX.Element {
  // Published Industry reports — shown whenever there is one, whatever the
  // results-section flag says: a published report is already public.
  const [published, setPublished] = useState<Array<{ editionId: string; editionLabel: string }>>(
    [],
  );
  useEffect(() => {
    void fetch('/api/public/industry-reports')
      .then((r) => (r.ok ? (r.json() as Promise<{ reports: typeof published }>) : { reports: [] }))
      .then(({ reports }) => setPublished(reports))
      .catch(() => undefined);
  }, []);

  return (
    <div className="journey public-landing">
      <p className="eyebrow">CIS × Dragnet · {editionLabel ?? 'Current edition'}</p>
      <h1 tabIndex={-1}>The Nigerian Capital Market Brokerage Benchmark</h1>
      <p className="lede">
        An independent read on how brokers serve their clients — built from the people who actually
        use them.
      </p>

      <section className="landing-cta">
        <h2>Take part</h2>
        <div className="actions">
          <button type="button" className="btn" onClick={onTakeRetail}>
            I invest through a broker
          </button>
          <button type="button" className="btn-2" onClick={onTakeInstitutional}>
            I represent an institution
          </button>
        </div>
      </section>

      <section className="landing-firm">
        <h2>Are you a brokerage firm?</h2>
        <p className="lede">Firms take part through their own coordinator.</p>
        <a className="textlink" href="/firm">
          Firm participation →
        </a>
      </section>

      {published.length > 0 && (
        <section className="landing-results">
          <h2>The Industry report</h2>
          <p className="lede">
            The profession’s benchmark of how firms operate and how investors experience them.
          </p>
          <div className="actions">
            {published.map((r) => (
              <span key={r.editionId} style={{ display: 'contents' }}>
                <a className="btn-2" href={`/reports/industry?edition=${r.editionId}`}>
                  Read the {r.editionLabel} report
                </a>
                <a className="textlink" href={`/reports/institutional?edition=${r.editionId}`}>
                  Institutional Perspectives →
                </a>
              </span>
            ))}
          </div>
        </section>
      )}

      {resultsSectionVisible && (
        <section className="landing-results">
          <h2>Results</h2>
          <p className="lede">
            Published results for {editionLabel ?? 'the current edition'} will appear here once the
            study closes and the numbers clear the sample-sufficiency floor.
          </p>
        </section>
      )}

      <nav className="landing-footer" aria-label="More">
        <button type="button" className="textlink" onClick={onPreviousEditions}>
          Previous editions
        </button>
        <span className="sep" aria-hidden="true">
          ·
        </span>
        <button type="button" className="textlink" onClick={onHelpAbout}>
          Help, privacy and about
        </button>
      </nav>
    </div>
  );
}
