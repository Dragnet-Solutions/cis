import type { FirmReportContent } from '../api/types';
import type { ReportSource } from './source';
import { useReport } from './useReport';
import {
  Bar,
  Brand,
  Cover,
  NarrativeControls,
  NarrativeStatus,
  IndexCards,
  Prose,
  SectionHead,
  Toolbar,
  gapOf,
  show,
  signed,
} from './parts';

/**
 * A firm's private report, laid out to the approved sample
 * (CIS_Dragnet_Sample_Firm_Report_v3_2026) and filled from that firm's own
 * responses and its own investors' ratings, set against the anonymised
 * industry aggregate (`GET /editions/:id/firms/:firmId/report`).
 *
 * The agenda is read from the firm's own gaps only; a difference within the
 * comparison margin makes no claim. The retail cut follows the 10 / 30 gate.
 */

const QUESTIONS = [
  'Where do we stand against the industry on the five indices?',
  'Which parts of how we operate are comparatively strong or weak?',
  'Is our digital capability keeping pace with the market?',
  'What do our active investors actually experience with us?',
  'Is service quality shifting investor confidence or behaviour?',
  'Where does our own view differ most from our investors’?',
  'Which improvement priorities deserve attention first?',
];

export function FirmReport({
  source,
  onBack,
  printMode = false,
  onReady,
}: {
  source: ReportSource<FirmReportContent>;
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
        <Toolbar onBack={onBack} title="Firm report" />
        {error ? <div className="err">{error}</div> : <p>Building the report…</p>}
      </main>
    );
  }

  const sv = c.selfVsInvestors;
  const firmGap = gapOf(sv.firmSelfBelief, sv.investorExperience);
  const industryGap = gapOf(sv.industrySelfBelief, sv.industryInvestorExperience);
  const cut = c.retailCut;
  const rated = c.dimensions
    .filter((d) => d.firm.value !== null && d.industry.value !== null)
    .map((d) => ({ ...d, gap: (d.firm.value as number) - (d.industry.value as number) }))
    .sort((a, b) => b.gap - a.gap);
  const best = rated[0];
  const worst = rated[rated.length - 1];

  return (
    <main style={{ padding: 0 }}>
      {!printMode && (
        <Toolbar onBack={onBack} title={`Firm report — ${c.firm.name}`}>
          <NarrativeControls
            narrative={c.narrative}
            busy={busy}
            onGenerate={regenerate && !c.publishedAt ? () => void regenerate() : undefined}
            onDownload={() =>
              void download(
                `CIS-Dragnet-Firm-Report-${c.firm.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${c.edition.label}.pdf`,
              )
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
        {operator && !c.publishedAt && (
          <div className="rpt-draft-banner">
            Not yet released to the firm — this is the operator’s preview.{' '}
            {c.report.approvalState === 'approved' ? 'Approved.' : 'Not yet approved.'}
          </div>
        )}
        {operator && !printMode && c.publishedAt && (
          <div className="rpt-draft-banner">
            Released to the firm on {new Date(c.publishedAt).toLocaleString()} — this is exactly
            what they received, and it is final.
          </div>
        )}
        <Cover
          watermark="PRIVATE"
          right={<span className="rpt-private-pill">PRIVATE &amp; CONFIDENTIAL</span>}
          eyebrow="Private member report · prepared for one firm"
          title={
            <>
              Your Firm Benchmark
              <br />
              &amp; Results
            </>
          }
          prepared={c.firm.name}
          sub="How your firm performs, how your own investors experience you, and where you stand against the anonymised industry benchmark."
          meta={[
            [c.edition.label, 'edition'],
            ['Your data', 'your own responses and your own investors'],
            ['Context', 'anonymised industry benchmark'],
          ]}
        />

        <section>
          <SectionHead
            eyebrow="About this report"
            title="What this report is, and what it is not"
          />
          <p>
            This is your firm’s private report from the CIS-Dragnet Benchmark Study. Everything in
            it is about your firm: your own results, how your own active investors experience you,
            and where you sit against the anonymised industry benchmark. It is never shared with
            other firms or with any third party; within the study, only the CIS and Dragnet staff
            who check each report before it is released can open it.
          </p>
          <div className="rpt-box">
            <p className="rpt-eyebrow">Three rules that protect you, and everyone</p>
            <p>
              You never see another named firm’s data. There is no league table, and you are never
              ranked against a named competitor. Every comparison in this report is against the
              anonymised industry aggregate only, the same protection every participating firm
              receives.
            </p>
          </div>
          <h3>Seven questions this report answers</h3>
          <div className="rpt-questions">
            {QUESTIONS.map((q, i) => (
              <div key={q}>
                <b>{i + 1}</b>
                <span>{q}</span>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionHead
            eyebrow="Firm section 01"
            title="Your five index scores, in industry context"
            standfirst="Your own Operational Maturity, Digital Maturity, Investor Experience, Investor Confidence and Service Excellence, each shown against the anonymised industry benchmark."
          />
          <IndexCards
            indices={c.indices}
            scores={c.indices.state === 'reported' ? c.indices.firm : null}
            compare={c.indices.state === 'reported' ? c.indices.industry : undefined}
          />
          <Prose narrative={c.narrative} section="SUMMARY" lead />
        </section>

        <section>
          <SectionHead
            eyebrow="Firm section 02"
            title="How your own investors experience you"
            standfirst="Drawn only from investors who rated your firm, on a 0–100 scale, against the anonymised industry benchmark."
          />
          <div className="rpt-bars marked">
            {c.dimensions.map((d) => (
              <Bar
                key={d.key}
                label={d.label}
                value={d.firm.value}
                marker={d.industry.value}
                markerLabel={d.industry.value === null ? undefined : `Industry ${d.industry.value}`}
                compareText={d.industry.value === null ? undefined : String(d.industry.value)}
              />
            ))}
          </div>
          {best && worst && best !== worst && (
            <p>
              Your investors rate you{' '}
              {best.gap > 0 && worst.gap < 0 ? (
                <>
                  <b>furthest above the industry on {best.label.toLowerCase()}</b> (
                  {signed(best.gap)}) and <b>furthest below it on {worst.label.toLowerCase()}</b> (
                  {signed(worst.gap)}).
                </>
              ) : worst.gap >= 0 ? (
                <>
                  at or above the industry on every dimension measured —{' '}
                  <b>furthest above on {best.label.toLowerCase()}</b> ({signed(best.gap)}), and
                  closest to it on {worst.label.toLowerCase()} ({signed(worst.gap)}).
                </>
              ) : (
                <>
                  at or below the industry on every dimension measured —{' '}
                  <b>furthest below on {worst.label.toLowerCase()}</b> ({signed(worst.gap)}), and
                  closest to it on {best.label.toLowerCase()} ({signed(best.gap)}).
                </>
              )}
            </p>
          )}
          <Prose narrative={c.narrative} section="F2" />
          <p className="rpt-note">
            Bar = your score. Marker = anonymised industry benchmark. Ratings from every investor
            category that rated you, pooled:{' '}
            {c.dimensions
              .map((d) => `${d.label.toLowerCase()} — ${d.sources} (n=${d.firm.n})`)
              .join('; ')}
            . A rating from fewer than ten investors is withheld.
          </p>
        </section>

        <section>
          <SectionHead
            eyebrow="Firm section 03"
            title="Your Service Excellence gap"
            standfirst="The distance between what your leadership believes you deliver and what your own investors report receiving, set against the industry gap."
          />
          <table>
            <thead>
              <tr>
                <th>Measure</th>
                <th>Your firm believes</th>
                <th>Your investors report</th>
                <th>Your gap</th>
                <th>Industry gap</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Meeting investor expectations</td>
                <td>{show(sv.firmSelfBelief)}</td>
                <td>{show(sv.investorExperience)}</td>
                <td>{signed(firmGap)}</td>
                <td>{signed(industryGap)}</td>
              </tr>
            </tbody>
          </table>
          {firmGap !== null && (
            <div className="rpt-callout">
              <span className="big">{Math.abs(firmGap)}</span>
              <p>
                points separate how your leadership sees your service from how your investors
                experience it
                {firmGap > 0
                  ? ' — your own view runs ahead of your clients’.'
                  : firmGap < 0
                    ? ' — your clients rate you higher than you rate yourself.'
                    : '.'}
                {industryGap !== null && (
                  <>
                    {' '}
                    Across the industry the gap is <b>{Math.abs(industryGap)}</b>
                    {industryGap > 0
                      ? ', firms rating themselves above their investors'
                      : industryGap < 0
                        ? ', investors rating firms above firms’ own view'
                        : ''}
                    {Math.abs(firmGap) < Math.abs(industryGap)
                      ? '; yours is narrower, a position of strength.'
                      : Math.abs(firmGap) > Math.abs(industryGap)
                        ? '; yours is wider, and that is where attention converts most directly into a better score.'
                        : ', the same as yours.'}
                  </>
                )}
              </p>
            </div>
          )}
          <Prose narrative={c.narrative} section="F3" />
          <p className="rpt-note">
            Your firm believes: your leadership’s confidence that the firm consistently meets
            investor expectations (S1-Q11). It is one person’s answer — the managing director’s seat
            — so it is never shown as a figure: a single answer is not a reading, and seat answers
            stay confidential to the person who gave them. Your investors report: every ease,
            responsiveness and transparency rating of your firm, with each investor counted once; it
            is shown from ten investors up. The industry gap pools every firm and is shown from ten
            firms up.
          </p>
        </section>

        <section>
          <SectionHead
            eyebrow="Firm section 04 · Conditional"
            title="Your retail investor cut"
            standfirst="A dedicated view of how your retail investors specifically experience you, unlocked when your retail responses clear the sufficiency threshold."
          />
          <div className={`rpt-box ${cut.state === 'unlocked' ? 'green' : 'grey'}`}>
            <p className="rpt-eyebrow">
              {cut.state === 'unlocked'
                ? `Unlocked · ${cut.n} retail responses`
                : cut.state === 'directional'
                  ? `Directional only · ${cut.n} retail responses`
                  : `Not shown · ${cut.n} retail responses`}
            </p>
            <p>
              {cut.state === 'unlocked'
                ? 'Your firm cleared the provisional threshold of 30 retail responses, so this dedicated retail cut is credible and shown in full below. It is additional to your combined report, never a substitute for it.'
                : cut.state === 'directional'
                  ? 'Your firm has between 10 and 29 retail responses, so this cut is directional only: read it as an indication, not a measurement.'
                  : 'Your firm has fewer than 10 retail responses, so nothing is shown at this level. Your combined view above still includes every investor who rated you.'}
            </p>
          </div>
          {cut.dimensions.length > 0 && (
            <div className="rpt-bars marked">
              {cut.dimensions.map((d) => (
                <Bar
                  key={d.label}
                  label={d.label}
                  value={d.firm.value}
                  marker={d.industry.value}
                  markerLabel={
                    d.industry.value === null ? undefined : `Industry ${d.industry.value}`
                  }
                  compareText={d.industry.value === null ? undefined : String(d.industry.value)}
                />
              ))}
            </div>
          )}
          <Prose narrative={c.narrative} section="F4" />
          <div className="rpt-box grey">
            <p className="rpt-eyebrow">How the retail cut is gated</p>
            <p>
              Below 10 retail responses, nothing is shown at this level. Between 10 and 29, the cut
              is directional only. At 30 and above it unlocks as a credible view. This gating
              reflects your firm’s own data, never your membership, and it protects you from reading
              signal into too few responses.
            </p>
          </div>
        </section>

        <section>
          <SectionHead
            eyebrow="Your priorities"
            title="Your 90-day management agenda"
            standfirst="Drawn entirely from your own results above, ordered by how directly each addresses your widest gaps."
          />
          <Prose narrative={c.narrative} section="AGENDA" />
          {c.agenda.length === 0 && (
            <div className="rpt-pending">
              <b>No priorities can be set from this edition’s data</b>
              Too few of your investors rated you for any difference from the industry to be
              measured, so no priority is drawn — none is guessed.
            </div>
          )}
          <div className="rpt-agenda">
            {c.agenda.map((a, i) => (
              <div key={a.title}>
                <span className="n">{i + 1}</span>
                <div className="body">
                  <b>{a.title}</b>
                  <p>{a.detail}</p>
                </div>
                <span className={`pri ${a.priority}`}>{a.priority.toUpperCase()}</span>
              </div>
            ))}
          </div>
          <p>
            None of these priorities comes from an external opinion. Each is read directly from the
            distance between your own numbers and the anonymised benchmark, and only where that
            distance is at least {c.margin} points, the smallest difference the data can support.
          </p>
        </section>

        <section>
          <SectionHead
            eyebrow="The boundary"
            title="What this report deliberately does not contain"
            standfirst="Stated plainly, because the boundary is what makes broad participation safe, and it holds for every firm equally."
          />
          <table>
            <thead>
              <tr>
                <th>Not included</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Any other named firm’s data</td>
                <td>
                  You are compared only to the anonymised industry aggregate. No firm sees another
                  firm’s figures, anywhere.
                </td>
              </tr>
              <tr>
                <td>League tables or rankings</td>
                <td>
                  The study never ranks firms against each other. Ranking would deter participation
                  and distort the benchmark.
                </td>
              </tr>
              <tr>
                <td>A firm-level institutional cut</td>
                <td>
                  The national institutional population is too small for any single firm to reach a
                  credible sample. Institutional insight exists only at industry level, in the
                  public report.
                </td>
              </tr>
              <tr>
                <td>The premium diagnostic</td>
                <td>
                  The deeper diagnostic that explains why your numbers sit where they do is
                  preserved for a later edition. This edition delivers your results and their
                  context.
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <div className="rpt-closing">
          <div className="rpt-foot" style={{ marginTop: 0 }}>
            <Brand />
            <div>
              State of Stockbroking Operations and Investor Experience in Nigeria: A{' '}
              {c.edition.label} CIS-Dragnet Study
            </div>
            <div>The CIS-Dragnet Benchmark Study · Private Member Report</div>
          </div>
          <p className="rpt-method">
            This report is private to {c.firm.name}: it is never shared with other firms or any
            third party, and within the study only the staff who check it before release can open
            it. Every figure is computed from submitted responses; ratings asked on 1–10 are shown
            on 0–100 using the study’s own scale conversion; a rating from fewer than ten responses
            is withheld. Index scores are reported only once their methodology is approved.
            Generated {new Date(c.generatedAt).toLocaleString()}.
          </p>
        </div>
      </div>
    </main>
  );
}
