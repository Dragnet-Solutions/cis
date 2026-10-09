import type { IndustryReportContent } from '../api/types';
import type { ReportSource } from './source';
import { useReport } from './useReport';
import { InstitutionCard } from './institutional';
import {
  Bar,
  Brand,
  Cover,
  GapPill,
  NarrativeControls,
  NarrativeStatus,
  PendingPanel,
  Prose,
  SectionHead,
  Toolbar,
  Withheld,
  gapOf,
  show,
} from './parts';

/**
 * The public Industry report, laid out to the approved sample
 * (CIS_Dragnet_Sample_Industry_Report_v3_2026) and filled from the edition's
 * own responses (`GET /editions/:id/reports/industry`).
 *
 * Narrative copy that makes no numeric claim (foreword, how to read, closing)
 * is the sample's own; every figure is the data's. Index scores — and the
 * tiers built on them — wait on an approved methodology and say so. A section
 * the national report suppressed stays suppressed here, with its reason.
 */

const SECTION_ORDER = [
  'PUB_01_HEADLINE_INDICES',
  'PUB_02_SEGMENT_IEI_ICI',
  'PUB_03_OPERATIONAL_FRICTIONS',
  'PUB_04_INVESTOR_FRUSTRATIONS',
  'PUB_05_MATURITY_HEATMAP',
  'PUB_06_CONFIDENCE_AND_PARTICIPATION',
  'PUB_07_LOCAL_VS_FOREIGN',
  'PUB_08_CROSS_INDUSTRY_BENCHMARK',
  'PUB_09_SERVICE_EXCELLENCE_GAP',
  'PUB_10_INSTITUTIONAL_PERSPECTIVES',
];

const INDICES = [
  'Operational maturity',
  'Digital maturity',
  'Investor experience',
  'Investor confidence',
  'Service excellence',
];

export function IndustryReport({
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
  const { c, error, busy, aiError, regenerate, publish, download } = useReport(source, {
    printMode,
    onReady,
  });
  const operator = source.audience === 'operator';

  if (!c) {
    return (
      <main>
        <Toolbar onBack={onBack} title="Industry report" />
        {error ? <div className="err">{error}</div> : <p>Building the report…</p>}
      </main>
    );
  }

  const section = (id: string) => c.sections?.find((s) => s.id === id) ?? null;
  const no = (id: string) => String(SECTION_ORDER.indexOf(id) + 1).padStart(2, '0');

  /** A section's body — or its suppressed / caveated state from the national report. */
  const gated = (id: string, body: JSX.Element): JSX.Element => {
    const s = section(id);
    if (s?.disposition === 'suppressed') {
      return (
        <div className="rpt-pending">
          <b>Not reported this edition</b>
          {s.reason ?? 'This section did not clear its sufficiency floor.'}
        </div>
      );
    }
    return (
      <>
        {body}
        <Prose narrative={c.narrative} section={id} />
        {s?.disposition === 'caveated' && (
          <p className="rpt-note">
            Reported with a thin-sample caveat:{' '}
            {(s.reason ?? 'the achieved sample is small').replace(/\.+$/, '')}. Shown, not dropped,
            with the achieved sample stated.
          </p>
        )}
      </>
    );
  };

  const fr = c.frustrations;
  const fx = c.frictions;
  const pi = c.participationImpact;
  const self = c.selfVsInvestors;
  const selfGap = gapOf(self.firmSelfBelief, self.investorExperience);
  const lvf = c.localVsForeign;

  // "What the numbers say" — one line per figure the data can actually support.
  const bullets: string[] = [];
  if (fx?.items[0]) {
    bullets.push(
      `${fx.items[0].pct}% of firms cite ${fx.items[0].label.toLowerCase()} among the processes consuming the most staff time.`,
    );
  }
  if (fr?.items[0]) {
    bullets.push(
      `The investor frustration cited most often is ${fr.items[0].label.toLowerCase()} (${fr.items[0].pct}% of retail investors).`,
    );
  }
  if (pi?.items[0]) {
    bullets.push(
      `${pi.items[0].pct}% of retail investors have ${pi.items[0].label.toLowerCase()} because of a service frustration.`,
    );
  }
  const bank = c.comparators?.rows.find((r) => /bank/i.test(r.comparator));
  if (bank) {
    bullets.push(
      `Against their primary bank, ${bank.worse}% of retail investors rate their stockbroker worse and ${bank.better}% better.`,
    );
  }
  if (selfGap !== null) {
    bullets.push(
      selfGap > 0
        ? `Firms rate their own delivery ${selfGap} points higher than their investors report experiencing it.`
        : `Investors rate their experience ${-selfGap} points higher than firms rate their own delivery.`,
    );
  }

  const draftNote = !c.sections
    ? 'Working draft — the national report has not been generated, so section states are not yet decided.'
    : c.edition.status !== 'locked'
      ? 'Working draft — collection is still open, so these figures will move.'
      : null;

  return (
    <main style={{ padding: 0 }}>
      {!printMode && (
        <Toolbar onBack={onBack} title={`Industry report ${c.edition.label}`}>
          {publish && !c.publishedAt && (
            <button
              type="button"
              className="btn-2 small"
              disabled={busy !== null || !c.narrative}
              onClick={() => void publish()}
            >
              {busy === 'publishing' ? 'Publishing…' : 'Publish now'}
            </button>
          )}
          <NarrativeControls
            narrative={c.narrative}
            busy={busy}
            onGenerate={regenerate && !c.publishedAt ? () => void regenerate() : undefined}
            onDownload={() => void download(`CIS-Dragnet-Industry-Report-${c.edition.label}.pdf`)}
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
            {c.publishedAt ? (
              <>
                Published to the public on {new Date(c.publishedAt).toLocaleString()} — this is
                final. Anyone can read it at{' '}
                <a
                  href={`/reports/industry?edition=${c.edition.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  /reports/industry
                </a>
                .
              </>
            ) : (
              <>
                Not yet public. It is published automatically when the national report is approved;
                if that has happened and it is still not public, use “Publish now”.
              </>
            )}
          </div>
        )}
        {operator && draftNote && <div className="rpt-draft-banner">{draftNote}</div>}
        <Cover
          watermark={c.edition.label.slice(-2)}
          right={<span className="rpt-kind">Flagship industry benchmark</span>}
          eyebrow={`A CIS-Dragnet study · ${c.edition.label} edition`}
          title="State of Stockbroking Operations & Investor Experience in Nigeria"
          sub="The profession’s evidence-based benchmark of how firms operate and how investors experience them."
          meta={[
            [c.edition.label, 'edition'],
            ['Both sides', 'firms and investors, measured together'],
            ['Five indices', 'one clearer picture'],
          ]}
        />

        <section>
          <SectionHead eyebrow="Foreword" title="A shared instrument for a stronger profession" />
          <p className="rpt-lead">
            For the first time, the Nigerian stockbroking profession has a common, evidence-based
            reading of how it operates and how the people it serves actually experience it. This
            study does not describe the industry from the outside. It measures it from within,
            drawing firm and investor evidence together into a single picture that no firm, and no
            regulator, has previously been able to see whole.
          </p>
          <div className="rpt-box">
            <p className="rpt-eyebrow">How to read this report</p>
            <p>
              This is the public industry report. It presents profession-level findings only. Every
              participating firm additionally receives its own private results, set against the
              anonymised industry benchmark shown here. No firm is named, no firm is ranked, and no
              firm sees another firm’s data anywhere in this study.
            </p>
          </div>
        </section>

        <section>
          <SectionHead eyebrow="Contents" title="What this report covers" />
          <div className="rpt-contents">
            {SECTION_ORDER.map((id, i) => {
              const s = section(id);
              return (
                <div key={id}>
                  <span className="no">{String(i + 1).padStart(2, '0')}</span>
                  <span>{s?.name ?? id}</span>
                  {s?.disposition === 'suppressed' && <span className="off">not reported</span>}
                </div>
              );
            })}
          </div>
          <table>
            <thead>
              <tr>
                <th>Who took part</th>
                <th>Study target</th>
                <th>Achieved</th>
              </tr>
            </thead>
            <tbody>
              {c.participation.map((p) => (
                <tr key={p.segment}>
                  <td>{p.label}</td>
                  <td>{p.target.toLocaleString()}</td>
                  <td className={p.meets ? 'good' : 'short'}>{p.achieved.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <SectionHead eyebrow="Executive summary" title="What the numbers say" />
          <Prose narrative={c.narrative} section="EXEC" lead />
          {bullets.length ? (
            <ul className="rpt-bullets">
              {bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : (
            !c.narrative?.sentences.some((x) => x.section === 'EXEC' && x.finding === null) && (
              <p>
                Too few responses have been received for a summary to say anything reliable yet.
              </p>
            )
          )}
        </section>

        <section>
          <SectionHead
            eyebrow={`Section ${no('PUB_01_HEADLINE_INDICES')} · The headline`}
            title="The five index scores"
            standfirst="Every measure in this study resolves into five indices, each scored from 0 to 100, computed only from firm and investor responses."
          />
          {gated(
            'PUB_01_HEADLINE_INDICES',
            <>
              <div className="rpt-cards">
                {INDICES.map((k) => (
                  <div key={k}>
                    <div className="k">{k}</div>
                    <div className="v">Pending</div>
                    <div className="s">Methodology sign-off</div>
                  </div>
                ))}
              </div>
              <PendingPanel pending={c.indices} />
            </>,
          )}
        </section>

        <section>
          <SectionHead
            eyebrow={`Section ${no('PUB_02_SEGMENT_IEI_ICI')} · By whom`}
            title="Experience and confidence, by investor segment"
            standfirst="Investor Experience and Investor Confidence, computed separately for retail investors, local institutions and foreign institutions."
          />
          {gated('PUB_02_SEGMENT_IEI_ICI', <PendingPanel pending={c.indices} />)}
        </section>

        <section>
          <SectionHead
            eyebrow={`Section ${no('PUB_03_OPERATIONAL_FRICTIONS')} · The friction`}
            title="The most common operational frictions"
            standfirst="The processes firms report consuming the most staff time and effort, ranked by how many firms cite each."
          />
          {gated(
            'PUB_03_OPERATIONAL_FRICTIONS',
            fx ? (
              <>
                <div className="rpt-bars">
                  {fx.items.map((i) => (
                    <Bar key={i.label} label={i.label} value={i.pct} suffix="%" tone="gold" />
                  ))}
                </div>
                {fx.items[0] && (
                  <div className="rpt-callout">
                    <span className="big">{fx.items[0].pct}%</span>
                    <p>
                      of firms cited <b>{fx.items[0].label.toLowerCase()}</b> as one of the
                      processes consuming the most staff time — the single most-cited operational
                      friction in the profession.
                    </p>
                  </div>
                )}
                <p className="rpt-note">
                  Base: {fx.base} firms (operations lead, S3-Q1). Each firm could cite up to three
                  processes.
                </p>
              </>
            ) : (
              <Withheld what="firms" />
            ),
          )}
        </section>

        <section>
          <SectionHead
            eyebrow={`Section ${no('PUB_04_INVESTOR_FRUSTRATIONS')} · The frustration`}
            title="The most common investor frustrations"
            standfirst="What investors themselves cite most often as the friction in their relationship with stockbroking firms, ranked by frequency."
          />
          {gated(
            'PUB_04_INVESTOR_FRUSTRATIONS',
            fr ? (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Investor frustration</th>
                      <th>Cited by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fr.items.map((i, k) => (
                      <tr key={i.label}>
                        <td>{k + 1}</td>
                        <td>{i.label}</td>
                        <td>{i.pct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="rpt-note">
                  Base: {fr.base} retail investors (S4-Q9, top three frustrations about each firm
                  they rated). An investor citing the same frustration for several firms counts
                  once.
                </p>
              </>
            ) : (
              <Withheld what="retail investors" />
            ),
          )}
        </section>

        <section>
          <SectionHead
            eyebrow={`Section ${no('PUB_05_MATURITY_HEATMAP')} · The distribution`}
            title="Operational and digital maturity, by tier"
            standfirst="Firms grouped into thirds by operational-maturity score, showing how operational and digital maturity distribute across the profession."
          />
          {gated(
            'PUB_05_MATURITY_HEATMAP',
            <PendingPanel
              pending={c.indices}
              title="Pending methodology sign-off — tiers are built on the maturity indices"
            />,
          )}
        </section>

        <section>
          <SectionHead
            eyebrow={`Section ${no('PUB_06_CONFIDENCE_AND_PARTICIPATION')} · The consequence`}
            title="Confidence and the participation impact"
            standfirst="The share of investors whose market behaviour actually changed because of service quality — and what institutions say would most raise their confidence."
          />
          {gated(
            'PUB_06_CONFIDENCE_AND_PARTICIPATION',
            <>
              <div className="rpt-split">
                <div>
                  <h3>The participation impact</h3>
                  {pi ? (
                    <div className="rpt-bars">
                      {pi.items.map((i) => (
                        <Bar key={i.label} label={i.label} value={i.pct} suffix="%" tone="rust" />
                      ))}
                    </div>
                  ) : (
                    <Withheld what="retail investors" />
                  )}
                </div>
                <div>
                  <h3>What would raise institutional confidence</h3>
                  {c.confidenceLevers ? (
                    <div className="rpt-bars">
                      {c.confidenceLevers.items.map((i) => (
                        <Bar key={i.label} label={i.label} value={i.pct} suffix="%" tone="green" />
                      ))}
                    </div>
                  ) : (
                    <Withheld what="local institutions" />
                  )}
                </div>
              </div>
              {pi?.items[0] && (
                <div className="rpt-callout">
                  <span className="big">{pi.items[0].pct}%</span>
                  <p>
                    of retail investors reported having <b>{pi.items[0].label.toLowerCase()}</b>{' '}
                    because of a service frustration with their firm. Confidence is not an
                    abstraction: it converts directly into participation the market keeps or loses.
                  </p>
                </div>
              )}
              <p className="rpt-note">
                Participation impact: {pi ? `${pi.base} retail investors` : 'withheld'} (S4-Q5–Q7,
                yes for any firm they rated). Institutional levers:{' '}
                {c.confidenceLevers ? `${c.confidenceLevers.base} local institutions` : 'withheld'}{' '}
                (S5a-Q9).
              </p>
            </>,
          )}
        </section>

        <section>
          <SectionHead
            eyebrow={`Section ${no('PUB_07_LOCAL_VS_FOREIGN')} · The comparison`}
            title="Local versus foreign institutional experience"
            standfirst="A side-by-side reading of local and foreign institutional investors on matched measures, on a 0–100 scale."
          />
          {gated(
            'PUB_07_LOCAL_VS_FOREIGN',
            <>
              <table>
                <thead>
                  <tr>
                    <th>Matched measure</th>
                    <th>Local institutional</th>
                    <th>Foreign institutional</th>
                    <th>Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {lvf.rows.map((r) => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td>{show(r.local)}</td>
                      <td>{show(r.foreign)}</td>
                      <td>
                        <GapPill gap={gapOf(r.foreign, r.local)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="rpt-note">
                {lvf.localN} local and {lvf.foreignN} foreign institutional{' '}
                {lvf.localN + lvf.foreignN === 1 ? 'respondent' : 'respondents'}. Gap is foreign
                minus local. Local: S5a-Q1 responsiveness and reporting, S5a-Q5; foreign: S5b-Q2–Q4.
                A rating from fewer than ten respondents is withheld; each institution counts once,
                however many firms it rated.
              </p>
            </>,
          )}
        </section>

        <section>
          <SectionHead
            eyebrow={`Section ${no('PUB_08_CROSS_INDUSTRY_BENCHMARK')} · The context`}
            title="How stockbroking compares with banks and fintechs"
            standfirst="Retail investors rating their stockbroking firm against their primary bank and against fintech and digital investment apps."
          />
          {gated(
            'PUB_08_CROSS_INDUSTRY_BENCHMARK',
            c.comparators ? (
              <>
                <div className="rpt-bars">
                  {c.comparators.rows.map((r) => (
                    <div className="rpt-bar" key={r.comparator}>
                      <span className="lab">vs {r.comparator.toLowerCase()}</span>
                      <span className="rpt-stack">
                        <span className="better" style={{ width: `${r.better}%` }}>
                          {r.better >= 8 ? `${r.better}%` : ''}
                        </span>
                        <span className="same" style={{ width: `${r.same}%` }}>
                          {r.same >= 8 ? `${r.same}%` : ''}
                        </span>
                        <span className="worse" style={{ width: `${r.worse}%` }}>
                          {r.worse >= 8 ? `${r.worse}%` : ''}
                        </span>
                      </span>
                      <span className="num">
                        <small>n={r.n}</small>
                      </span>
                    </div>
                  ))}
                </div>
                <div className="rpt-legend">
                  <span>
                    <i style={{ background: 'var(--rpt-green)' }} />
                    Stockbroker rated better
                  </span>
                  <span>
                    <i style={{ background: '#a9a294' }} />
                    About the same
                  </span>
                  <span>
                    <i style={{ background: 'var(--rpt-rust)' }} />
                    Stockbroker rated worse
                  </span>
                </div>
                <p className="rpt-note">
                  Base: {c.comparators.base} retail investors (S4-Q8). “Unable to compare” is
                  excluded from each comparison.
                </p>
              </>
            ) : (
              <Withheld what="retail investors" />
            ),
          )}
        </section>

        <section>
          <SectionHead
            eyebrow={`Section ${no('PUB_09_SERVICE_EXCELLENCE_GAP')} · The mirror`}
            title="The Service Excellence gap"
            standfirst="The distance between what firms believe they deliver and what investors report experiencing — calculated rather than asked."
          />
          {gated(
            'PUB_09_SERVICE_EXCELLENCE_GAP',
            <>
              <div className="rpt-bars">
                <Bar label="Firms’ own view" value={self.firmSelfBelief.value} tone="rust" />
                <Bar label="Investors’ experience" value={self.investorExperience.value} />
              </div>
              {selfGap !== null && (
                <div className="rpt-callout">
                  <span className="big">{Math.abs(selfGap)}</span>
                  <p>
                    points separate what firms believe they deliver from what investors report
                    receiving.{' '}
                    <b>
                      {selfGap > 0
                        ? 'The profession rates itself higher than its investors do.'
                        : 'Investors rate the profession higher than it rates itself.'}
                    </b>
                  </p>
                </div>
              )}
              <p className="rpt-note">
                Firms’ view: how confident leadership is that the firm consistently meets investor
                expectations (S1-Q11, {self.firmSelfBelief.n} firms). Investors’ experience: every
                ease, responsiveness and transparency rating, each investor counted once (
                {self.investorExperience.n} investors). Both sides are shown only from ten
                respondents up. The instrument does not ask firms to rate themselves dimension by
                dimension, so the gap is reported overall.
              </p>
            </>,
          )}
        </section>

        <section>
          <SectionHead
            eyebrow={`Section ${no('PUB_10_INSTITUTIONAL_PERSPECTIVES')} · The oversight view`}
            title="Institutional perspectives on market operations"
            standfirst="A qualitative reading from the market’s infrastructure and oversight institutions, reported alongside the indices and never inside them."
          />
          {gated(
            'PUB_10_INSTITUTIONAL_PERSPECTIVES',
            c.institutional.length ? (
              <>
                {c.institutional.map((r) => (
                  <InstitutionCard key={r.key} reading={r} narrative={c.narrative} />
                ))}
                <p className="rpt-note">
                  {c.institutionalParticipation.contributed} of{' '}
                  {c.institutionalParticipation.invited} invited institutions contributed. The full
                  reading, with what the institutions share, is published as the companion report
                  Institutional Perspectives on Market Operations.
                </p>
              </>
            ) : (
              <div className="rpt-pending">
                <b>No institutional responses yet</b>
                No institutional role has submitted its review yet.
              </div>
            ),
          )}
        </section>

        <div className="rpt-closing">
          <p className="rpt-eyebrow">In closing</p>
          <h2>From a reading to a trajectory</h2>
          <p>
            This edition establishes the baseline. None of its findings is a verdict. Each is a
            starting point the profession can now measure itself against, edition after edition.
          </p>
          <p>
            The question this study answers is no longer “how do we think the industry is doing?” It
            is “what does the evidence tell us, and where should we improve?” That is the difference
            a benchmark makes.
          </p>
          <Prose narrative={c.narrative} section="CLOSING" />
          <div className="rpt-foot">
            <Brand />
            <div>
              State of Stockbroking Operations and Investor Experience in Nigeria: A{' '}
              {c.edition.label} CIS-Dragnet Study
            </div>
          </div>
          <p className="rpt-method">
            How these figures are made: every figure is computed from submitted responses. Ratings
            asked on 1–10 are shown on 0–100 using the study’s own scale conversion. A share or
            average from fewer than ten responses is withheld rather than shown. Index scores are
            reported only once their methodology is approved. Generated{' '}
            {new Date(c.generatedAt).toLocaleString()}.
          </p>
        </div>
      </div>
    </main>
  );
}
