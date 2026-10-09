import type { IndustryReportContent } from '../api/types';
import { InstitutionCard } from './institutional';
import {
  Brand,
  Cover,
  NarrativeControls,
  NarrativeStatus,
  Prose,
  SectionHead,
  Toolbar,
} from './parts';
import type { ReportSource } from './source';
import { useReport } from './useReport';

/**
 * Institutional Perspectives on Market Operations — section 10 of the public
 * Industry report, as a standalone companion, laid out to the approved sample
 * (CIS_Dragnet_Sample_Institutional_Perspectives_2026). The external reading of
 * the profession from the institutions that supervise, transact with and settle
 * for it: attributed, qualitative, and never scored.
 *
 * It is drawn from the Industry report's own content and narrative, so it is
 * published, and frozen, together with that report. Each card is the
 * institution's answers; the characterisation under it is our paraphrase
 * (checked like every sentence, and never in quotation marks). What the
 * institutions share is computed from their answers, not assumed.
 */

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const inWords = (n: number) => WORDS[n] ?? String(n);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function InstitutionalReport({
  source,
  onBack,
  printMode = false,
  onReady,
}: {
  source: ReportSource<IndustryReportContent>;
  onBack?: () => void;
  /** The PDF render: the document alone, no controls. */
  printMode?: boolean;
  /** Called once the report has rendered (the PDF renderer waits for it). */
  onReady?: () => void;
}): JSX.Element {
  const { c, error, busy, aiError, regenerate, download } = useReport(source, {
    printMode,
    onReady,
  });
  const operator = source.audience === 'operator';

  if (!c) {
    return (
      <main>
        <Toolbar onBack={onBack} title="Institutional Perspectives" />
        {error ? <div className="err">{error}</div> : <p>Building the report…</p>}
      </main>
    );
  }

  const suppressed = c.sections?.find(
    (s) => s.id === 'PUB_10_INSTITUTIONAL_PERSPECTIVES' && s.disposition === 'suppressed',
  );
  const readings = c.institutional;
  const institutions = [...new Map(readings.map((r) => [r.role, r])).values()];
  const p = c.institutionalParticipation;
  const shared = c.institutionalThemes.themes.filter((t) => t.codes.length > 1);

  return (
    <main style={{ padding: 0 }}>
      {!printMode && (
        <Toolbar onBack={onBack} title={`Institutional Perspectives ${c.edition.label}`}>
          <NarrativeControls
            narrative={c.narrative}
            busy={busy}
            onGenerate={regenerate && !c.publishedAt ? () => void regenerate() : undefined}
            onDownload={() =>
              void download(`CIS-Dragnet-Institutional-Perspectives-${c.edition.label}.pdf`)
            }
          />
        </Toolbar>
      )}
      <div className="rpt">
        {!printMode && (
          <NarrativeStatus
            narrative={c.narrative}
            error={aiError}
            drafting={busy === 'generating'}
            operator={operator}
          />
        )}
        {operator && !printMode && (
          <div className="rpt-draft-banner">
            {c.publishedAt
              ? `Published with the Industry report on ${new Date(c.publishedAt).toLocaleString()} — final.`
              : 'Not yet public — it is published with the Industry report when the national report is approved.'}
          </div>
        )}
        <Cover
          watermark="10"
          right={<span className="rpt-kind">Companion to the Industry report</span>}
          eyebrow={`A CIS-Dragnet study · ${c.edition.label} edition`}
          title={
            <>
              Institutional Perspectives
              <br />
              on Market Operations
            </>
          }
          sub="The external reading of the stockbroking profession, from the institutions that supervise, transact with, and settle for it."
          meta={[
            ['Section 10', 'of the public Industry report, shown as a standalone companion'],
            [
              'Context',
              'reported alongside the five indices — never scored, never blended into a score',
            ],
          ]}
        />

        {suppressed ? (
          <section>
            <div className="rpt-pending">
              <b>This section is withheld this edition</b>
              {suppressed.reason ?? 'It was withheld in the national report.'}
            </div>
          </section>
        ) : (
          <>
            <section>
              <SectionHead
                eyebrow="What this section is"
                title="An institutional reading, held outside the scoring"
              />
              <p className="rpt-lead rpt-dropcap">
                The indices measure the profession from the inside, through the firms and the
                investors they serve. This section adds a different vantage: how the institutions
                that supervise, transact with, and settle for stockbroking firms experience their
                operations. It is qualitative, attributed, and reported alongside the indices. No
                institutional answer enters an index score, which is what keeps the indices clean
                and comparable year on year.
              </p>
              <p>
                Each institution completes a short instrument built to its own mandate, because a
                regulator, an exchange, a clearing house and a depository see different things. One
                considered position is sought from each, in each of its roles, so every observation
                rests on the institution’s direct operational contact with firms.
              </p>
            </section>

            <section>
              <SectionHead eyebrow="Who contributed" title="The participating institutions" />
              {institutions.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Institution</th>
                      <th>Its vantage on stockbroking operations</th>
                    </tr>
                  </thead>
                  <tbody>
                    {institutions.map((r) => (
                      <tr key={r.role}>
                        <td>
                          <b>{r.code}</b>
                        </td>
                        <td>
                          {r.role} —{' '}
                          {readings
                            .filter((x) => x.role === r.role)
                            .map((x) => x.vantage.toLowerCase())
                            .join('; ')}
                          .
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              <div className="rpt-box">
                <p className="rpt-eyebrow">Participation, this edition</p>
                <p>
                  {p.invited === 0
                    ? 'No institution has been invited to give a reading yet.'
                    : `${cap(inWords(p.contributed))} of ${inWords(p.invited)} invited institution${p.invited === 1 ? '' : 's'} contributed. Each reading reflects one consolidated position, completed by a nominated contact whose role brings them into direct contact with stockbroking firms.`}
                </p>
              </div>
            </section>

            <section>
              <SectionHead
                eyebrow="The institutional readings"
                title="What each institution observes"
              />
              {readings.length ? (
                readings.map((r) => (
                  <InstitutionCard key={r.key} reading={r} narrative={c.narrative} />
                ))
              ) : (
                <div className="rpt-pending">
                  <b>No institutional readings yet</b>
                  No institution has submitted its reading.
                </div>
              )}
              <div className="rpt-box">
                <p className="rpt-eyebrow">A note on the readings</p>
                <p>
                  Each institution answered only on the part of the market it knows at first hand,
                  which is why the readings differ in language and focus. The characterisation under
                  each reading is our paraphrase of that vantage, not the institution’s words.
                  Quotation marks are used only for words an institution has supplied or approved;
                  an answer selected from a list is never turned into a first-person quotation.
                </p>
              </div>
            </section>

            {readings.length > 1 && (
              <section>
                <SectionHead
                  eyebrow="What the institutional reading reveals"
                  title={`${cap(inWords(readings.length))} vantages, read together`}
                />
                <Prose narrative={c.narrative} section="PUB_10_INSTITUTIONAL_PERSPECTIVES" lead />
                {shared.length > 0 ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Operational area</th>
                        <th>Named by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shared.map((t) => (
                        <tr key={t.theme}>
                          <td>{t.theme}</td>
                          <td>{t.codes.join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>
                    No operational area is named by more than one institution: each reading stands
                    on its own this edition.
                  </p>
                )}
                <p className="rpt-note">
                  An area counts as named when it appears among an institution’s most frequently
                  cited issues or the weaknesses it says carry the greatest consequence.
                  {c.institutionalThemes.standsApart.length > 0 &&
                    ` Standing apart: ${c.institutionalThemes.standsApart.join(', ')} — none of the areas it names is named by another institution, and it is reported as its own finding rather than smoothed into a consensus.`}
                </p>
                <div className="rpt-box">
                  <p className="rpt-eyebrow">Why this sits outside the indices</p>
                  <p>
                    These are considered institutional positions, not sampled measurements. A small
                    number of institutional voices cannot be an index and should not pretend to be
                    one. Their value is in what they say, set beside what the indices measure.
                    Reporting them as attributed context is what lets them be candid, and what
                    protects the institutions that give them.
                  </p>
                </div>
              </section>
            )}
          </>
        )}

        <div className="rpt-closing">
          <p className="rpt-eyebrow">In closing</p>
          <h2>The view from outside, on the record</h2>
          <p>
            The institutions that know the profession at first hand have put their reading of it on
            a common record, attributed and alongside the measured evidence. Set against the firms’
            own view of themselves, it is the clearest test the study offers of whether the
            profession sees itself as the market sees it.
          </p>
          <div className="rpt-foot">
            <Brand />
            <div>Institutional Perspectives · A {c.edition.label} CIS-Dragnet Study</div>
          </div>
        </div>
      </div>
    </main>
  );
}
