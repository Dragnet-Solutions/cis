import { useEffect, useState } from 'react';
import { PublicLanding } from './PublicLanding';
import { RetailEntry } from './RetailEntry';
import { FirmSeatEntry } from './FirmSeatEntry';
import { RunJourney } from './RunJourney';
import { Completion } from './Completion';
import { HelpPrivacyAbout } from './HelpPrivacyAbout';
import { PreviousEditions } from './PreviousEditions';
import { journeyApi, type ParticipatingFirm } from './journeyClient';
import { ApiError } from '../api/types';
import { ErrorState, type ErrorStateKind } from '../shared/ErrorState';

type Screen =
  | { name: 'landing' }
  | { name: 'retail-entry'; code: InvestorInstrument; recruitingFirmId: string | null }
  | { name: 'inst-choice' }
  | { name: 'firm-seat-entry'; linkToken: string }
  | {
      name: 'running';
      respondentId: string;
      firms: ParticipatingFirm[];
      code: string;
      retail: boolean;
      firmSeatLinkToken: string | null;
      outreachToken: string | null;
    }
  | { name: 'complete'; respondentId: string; code: string; retail: boolean }
  | { name: 'already-submitted' }
  | { name: 'error'; kind: ErrorStateKind }
  | { name: 'help-about' }
  | { name: 'previous-editions' };

const RETAIL_INSTRUMENT = 'S4';

/** The three investor instruments — all multi-firm, all consent-gated at
 *  submit for S5a/S5b, so all take the consent + firm-pick entry. */
type InvestorInstrument = 'S4' | 'S5a' | 'S5b';

// A firm's outreach link names the client segment it was sent to.
const SEGMENT_INSTRUMENT: Record<
  'individual' | 'local_institutional' | 'foreign_institutional',
  InvestorInstrument
> = {
  individual: 'S4',
  local_institutional: 'S5a',
  foreign_institutional: 'S5b',
};

/**
 * The respondent-facing application. Entirely separate from the operator admin
 * portal — a respondent never sees admin. Every entry surface funnels into the
 * ONE shared journey shell (via RunJourney); resume-by-link is handled the same
 * way, not as a separate path.
 *
 * "I represent an institution" is for institutional INVESTORS (S5a / S5b). The
 * regulator and market-infrastructure reviews (I-SEC, I-NGX, I-CSCS, I-DEP)
 * have no public entry: they open only from the named contact's issued link
 * (?resume=), and the server refuses to start one any other way.
 */
export function RespondentApp(): JSX.Element {
  const [editionId, setEditionId] = useState<string | null>(null);
  const [editionLabel, setEditionLabel] = useState<string | null>(null);
  const [editionStatus, setEditionStatus] = useState<
    'draft' | 'open' | 'locked' | 'archived' | null
  >(null);
  const [resultsVisible, setResultsVisible] = useState(false);
  const [screen, setScreen] = useState<Screen>({ name: 'landing' });
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // A firm's outreach link: ?ref=<token>. Carried alongside the entry
  // screens it pre-selects (never a gate — an unknown/stale token just falls
  // through to the ordinary landing page, same as arriving with no link at
  // all), and threaded into the 'running' screen so the real start/finish
  // events can be recorded against it.
  const [outreachToken, setOutreachToken] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ctx = await journeyApi.context();
        if (cancelled) return;
        setEditionId(ctx.editionId);
        setEditionLabel(ctx.editionLabel);
        setEditionStatus(ctx.editionStatus);
        setResultsVisible(ctx.resultsSectionVisible);

        // A firm seat's own entry link: ?firmSeat=<token> — independent of
        // the "current open edition" this app otherwise assumes, since the
        // seat carries its own edition.
        const firmSeatToken = new URLSearchParams(window.location.search).get('firmSeat');
        // Resume-by-link: ?resume=<token>
        const token = new URLSearchParams(window.location.search).get('resume');
        // A firm's outreach link: ?ref=<token>.
        const outreachRef = new URLSearchParams(window.location.search).get('ref');
        if (firmSeatToken) {
          setScreen({ name: 'firm-seat-entry', linkToken: firmSeatToken });
        } else if (outreachRef && !ctx.collectionOpen) {
          // A firm's link followed after collection ended: the landing page
          // says collection has closed — no entry form to fill in for nothing.
          setScreen({ name: 'landing' });
        } else if (outreachRef) {
          try {
            const outreachCtx = await journeyApi.outreachContext(outreachRef);
            if (cancelled) return;
            setOutreachToken(outreachRef);
            void journeyApi.outreachEvent(outreachRef, 'opens');
            // Every segment is an investor survey rating firms, attributed to
            // the firm whose link it is. (Previously institutional segments
            // were routed to the regulator reviews, with no consent step and
            // no attribution — S5b could never be submitted.)
            setScreen({
              name: 'retail-entry',
              code: SEGMENT_INSTRUMENT[outreachCtx.segment],
              recruitingFirmId: outreachCtx.organizationId,
            });
          } catch {
            // An unknown or stale outreach link is a convenience lost, never
            // a gate — fall through to the ordinary landing page.
            if (!cancelled) setScreen({ name: 'landing' });
          }
        } else if (token) {
          try {
            const state = await journeyApi.resumeByToken(token);
            if (cancelled) return;
            if (state.kind === 'participation_closed') {
              setScreen({ name: 'error', kind: 'participation_closed' });
            } else if (state.kind === 'already_submitted') {
              setScreen({ name: 'already-submitted' });
            } else {
              const firms = ctx.editionId ? await journeyApi.participatingFirms(ctx.editionId) : [];
              if (cancelled) return;
              setScreen({
                name: 'running',
                respondentId: state.respondent.id,
                firms,
                code: state.respondent.instrumentCode,
                retail: state.respondent.instrumentCode.startsWith('S'),
                firmSeatLinkToken: null,
                outreachToken: null,
              });
            }
          } catch (err) {
            if (cancelled) return;
            if (err instanceof ApiError && err.statusCode === 404) {
              setScreen({ name: 'error', kind: 'no_unfinished_survey' });
            } else {
              setScreen({ name: 'error', kind: 'service_unavailable' });
            }
          }
        }
        setReady(true);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load');
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className="shell respondent">
        <main>
          <p className="lede">Loading…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="shell respondent">
      <main>
        {error && <div className="err">{error}</div>}
        {!editionId && <div className="err">No open edition is available right now.</div>}

        {editionId && screen.name === 'landing' && (
          <>
            <PublicLanding
              editionLabel={editionLabel}
              editionStatus={editionStatus}
              resultsSectionVisible={resultsVisible}
              onTakeRetail={() =>
                setScreen({ name: 'retail-entry', code: RETAIL_INSTRUMENT, recruitingFirmId: null })
              }
              onTakeInstitutional={() => setScreen({ name: 'inst-choice' })}
              onHelpAbout={() => setScreen({ name: 'help-about' })}
              onPreviousEditions={() => setScreen({ name: 'previous-editions' })}
            />
          </>
        )}

        {editionId && screen.name === 'retail-entry' && (
          <RetailEntry
            editionId={editionId}
            instrumentCode={screen.code}
            recruitingFirmId={screen.recruitingFirmId}
            onStarted={(respondentId, firms) => {
              if (outreachToken) void journeyApi.outreachEvent(outreachToken, 'starts');
              setScreen({
                name: 'running',
                respondentId,
                firms,
                code: screen.code,
                retail: screen.code === RETAIL_INSTRUMENT,
                firmSeatLinkToken: null,
                outreachToken,
              });
            }}
          />
        )}

        {editionId && screen.name === 'inst-choice' && (
          <div className="journey">
            <p className="eyebrow">Institutional investors</p>
            <h1 tabIndex={-1}>Where is your institution based?</h1>
            <p className="lede">
              This survey is for institutions that invest through Nigerian stockbroking firms.
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setScreen({ name: 'retail-entry', code: 'S5a', recruitingFirmId: null })
                }
              >
                A Nigerian institution
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setScreen({ name: 'retail-entry', code: 'S5b', recruitingFirmId: null })
                }
              >
                An institution based abroad
              </button>
            </div>
            <p className="lede" style={{ fontSize: 13 }}>
              Regulators and market infrastructure institutions take part through the personal link
              sent to their named contact.
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn-2"
                onClick={() => setScreen({ name: 'landing' })}
              >
                Back
              </button>
            </div>
          </div>
        )}

        {editionId && screen.name === 'firm-seat-entry' && (
          <FirmSeatEntry
            linkToken={screen.linkToken}
            onStarted={(respondentId) =>
              setScreen({
                name: 'running',
                respondentId,
                firms: [],
                code: 'firm-seat',
                retail: false,
                firmSeatLinkToken: screen.linkToken,
                outreachToken: null,
              })
            }
          />
        )}

        {screen.name === 'running' && (
          <RunJourney
            respondentId={screen.respondentId}
            firms={screen.firms}
            onSubmitted={() => {
              if (screen.firmSeatLinkToken) {
                void journeyApi.firmSeatComplete(screen.firmSeatLinkToken);
              }
              if (screen.outreachToken) {
                void journeyApi.outreachEvent(screen.outreachToken, 'finishes');
              }
              setScreen({
                name: 'complete',
                respondentId: screen.respondentId,
                code: screen.code,
                retail: screen.retail,
              });
            }}
          />
        )}

        {editionId && screen.name === 'complete' && (
          <Completion
            respondentId={screen.respondentId}
            editionId={editionId}
            instrumentCode={screen.code}
            canRefer={screen.retail}
            onReferralStarted={(next) =>
              setScreen({
                name: 'running',
                respondentId: next,
                firms: [],
                code: screen.code,
                retail: true,
                firmSeatLinkToken: null,
                outreachToken: null,
              })
            }
          />
        )}

        {screen.name === 'help-about' && (
          <HelpPrivacyAbout onBack={() => setScreen({ name: 'landing' })} />
        )}

        {screen.name === 'previous-editions' && (
          <PreviousEditions
            currentEditionId={editionId}
            onBack={() => setScreen({ name: 'landing' })}
          />
        )}

        {screen.name === 'error' && (
          <ErrorState kind={screen.kind} onBack={() => setScreen({ name: 'landing' })} />
        )}

        {screen.name === 'already-submitted' && (
          <div className="card">
            <h2>You have already finished this one.</h2>
            <p>Your response is in — nothing further is needed.</p>
            <button type="button" className="btn" onClick={() => setScreen({ name: 'landing' })}>
              Back to safe starting point
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
