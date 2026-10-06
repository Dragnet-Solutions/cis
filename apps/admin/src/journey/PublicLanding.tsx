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
