import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createClient } from './api/client';
import { ApiError, type EditionSummary } from './api/types';
import { ErrorState } from './shared/ErrorState';
import { BuildVersion } from './shared/BuildVersion';
import { editionPhase, type EditionPhase } from './editionPhase';
import { useSession } from './auth/useSession';
import { LoginPage } from './pages/LoginPage';
import { EditionPage } from './pages/EditionPage';
import { SurveysPage } from './pages/SurveysPage';
import { RendererPage } from './pages/RendererPage';
import { FirmTeamPage } from './pages/FirmTeamPage';
import { NationalReportPage } from './pages/NationalReportPage';
import { FirmReportsPage } from './pages/FirmReportsPage';
import { ScoresSignoffPage } from './pages/ScoresSignoffPage';
import { PeopleAccessPage } from './pages/PeopleAccessPage';
import { InvitationsPage } from './pages/InvitationsPage';
import { MissionBoardPage } from './pages/MissionBoardPage';
import { RegulatorsPage } from './pages/RegulatorsPage';
import { ResponsesPage } from './pages/ResponsesPage';
import { UnfinishedPage } from './pages/UnfinishedPage';
import { WordingPage } from './pages/WordingPage';
import { DragnetPage } from './pages/DragnetPage';
import { MailPage } from './pages/MailPage';
import { AuditPage } from './pages/AuditPage';
import {
  tabDisabledReason,
  pickCurrentEdition,
  surveysRestricted,
  editionOptionLabel,
  tabFromLocation,
  tabUrl,
  type Tab,
} from './editionNav';
import { STUDY_SHORT_NAME } from '@cis/survey';
import { BrandLockup } from './components/BrandLockup';

/** A link into operations may name its page (`/?tab=national`), e.g. from an
 *  approval email, and a reload keeps the page it was on. */
function initialTab(): Tab {
  return tabFromLocation(window.location.pathname, window.location.search);
}

const currentAddress = (): string => `${window.location.pathname}${window.location.search}`;

/** One nav-bar tab: disabled (not hidden) when not relevant in the current
 *  edition phase, per UX-OPS-001's phase-awareness rule. */
function NavTab({
  tabKey,
  tab,
  phase,
  setTab,
  children,
}: {
  tabKey: Tab;
  tab: Tab;
  phase: EditionPhase;
  setTab: (t: Tab) => void;
  children: ReactNode;
}): JSX.Element {
  const reason = tabDisabledReason(tabKey, phase);
  return (
    <button
      type="button"
      disabled={reason !== null}
      onClick={() => setTab(tabKey)}
      style={tab === tabKey ? { color: 'var(--dragnet-black)' } : undefined}
      title={reason ?? undefined}
    >
      {children}
    </button>
  );
}

export function App(): JSX.Element {
  const { session, signIn, signOut, replaceToken } = useSession();
  const [expired, setExpired] = useState(false);
  const client = useMemo(
    () =>
      createClient(session?.token ?? null, {
        onToken: replaceToken,
        onUnauthorized: () => {
          setExpired(true);
          signOut();
        },
      }),
    [session?.token, replaceToken, signOut],
  );

  const [editionId, setEditionId] = useState<string | null>(null);
  const [editions, setEditions] = useState<EditionSummary[]>([]);
  const chosenRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<EditionPhase>('before_launch');
  const [tab, setTabState] = useState<Tab>(initialTab);
  // The address bar follows the page, so a reload or a copied link opens the
  // same page again, and Back/Forward move between pages.
  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    if (currentAddress() !== tabUrl(next)) window.history.pushState(null, '', tabUrl(next));
  }, []);
  useEffect(() => {
    const here = tabUrl(initialTab());
    if (currentAddress() !== here) window.history.replaceState(null, '', here);
    const onPop = () => setTabState(initialTab());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serviceDown, setServiceDown] = useState(false);

  const applyEdition = useCallback(
    (detail: { status: string; surveyCloseAt: string | null }) =>
      setPhase(editionPhase(detail.status, detail.surveyCloseAt)),
    [],
  );

  useEffect(() => {
    if (!session) {
      setEditionId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const editions = await client.listEditions();
        if (cancelled) return;
        setEditions(editions);
        // The edition in progress (open, else locked), never just the newest:
        // a next-year draft must not take over the screen (D-15).
        // A choice made in the edition switcher survives a token refresh.
        const kept = editions.find((e) => e.id === chosenRef.current);
        const current = kept ?? pickCurrentEdition(editions);
        chosenRef.current = current ? current.id : null;
        setEditionId(current ? current.id : null);
        setLoadError(current ? null : 'No study edition has been set up yet.');
        setServiceDown(false);
        if (current) {
          const detail = await client.getEdition(current.id);
          if (cancelled) return;
          applyEdition(detail);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.statusCode === 401) {
          signOut();
          return;
        }
        // A genuine service failure (5xx, network) gets the shared error state;
        // a recognized 4xx keeps its specific message (e.g. an empty database).
        if (!(err instanceof ApiError) || err.statusCode >= 500) {
          setServiceDown(true);
        } else {
          setLoadError(err.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, client, signOut, applyEdition]);

  /** Switch the whole console to another edition (the header switcher). */
  const chooseEdition = useCallback((id: string) => {
    chosenRef.current = id;
    setEditionId(id);
  }, []);

  /** Re-read the edition list, e.g. after creating the next edition, and
   *  optionally switch to one of them. */
  const refreshEditions = useCallback(
    async (selectId?: string) => {
      const list = await client.listEditions();
      setEditions(list);
      if (selectId) chooseEdition(selectId);
    },
    [client, chooseEdition],
  );

  // The phase is not fixed for a session: a lock approved by someone else, or
  // the close date passing, moves it. Re-check on every tab change so the nav
  // re-gates without a manual page reload.
  useEffect(() => {
    if (!editionId) return;
    let cancelled = false;
    client
      .getEdition(editionId)
      .then((detail) => {
        if (!cancelled) applyEdition(detail);
      })
      .catch(() => {
        // The page itself surfaces load failures; the nav keeps its last phase.
      });
    return () => {
      cancelled = true;
    };
  }, [tab, editionId, client, applyEdition]);

  if (!session) {
    return (
      <div className="login-page">
        <LoginPage
          onSignIn={(next) => {
            setExpired(false);
            signIn(next);
          }}
          notice={expired ? 'Your session has ended. Please sign in again.' : null}
        />
      </div>
    );
  }

  // The Market institutions tab follows its right, as Dragnet's does (BUG-01).
  const hasRegulatorsRight = session.user.hasRegulatorsRight !== false;

  return (
    <div className="shell">
      <header className="top">
        <div className="lockup">
          <BrandLockup size="sm" />
          <span className="lockup-text">
            {STUDY_SHORT_NAME}
            <small>Study operations</small>
          </span>
        </div>
        {editions.length > 1 && editionId && (
          <label className="edition-switch">
            <span>Edition</span>
            <select value={editionId} onChange={(e) => chooseEdition(e.target.value)}>
              {editions.map((e) => (
                <option key={e.id} value={e.id}>
                  {editionOptionLabel(e)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="whoami">
          {session.user.displayName}
          {session.user.org ? ` · ${session.user.org}` : ''}
          {'  '}
          <button type="button" className="textlink" style={{ marginLeft: 10 }} onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="crumbs" aria-label="Where you are">
        <span>Study operations</span>
        <span aria-hidden="true">›</span>
        <NavTab tabKey="board" tab={tab} phase={phase} setTab={setTab}>
          Mission board
        </NavTab>
        <span aria-hidden="true">·</span>
        <span>Monitoring</span>
        <span aria-hidden="true">›</span>
        <NavTab tabKey="responses" tab={tab} phase={phase} setTab={setTab}>
          Responses
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="unfinished" tab={tab} phase={phase} setTab={setTab}>
          Unfinished
        </NavTab>
        <span aria-hidden="true">·</span>
        <span>Setup</span>
        <span aria-hidden="true">›</span>
        <NavTab tabKey="edition" tab={tab} phase={phase} setTab={setTab}>
          Edition
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="surveys" tab={tab} phase={phase} setTab={setTab}>
          Surveys
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="renderer" tab={tab} phase={phase} setTab={setTab}>
          Renderer
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="firmteam" tab={tab} phase={phase} setTab={setTab}>
          Firm team
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="people" tab={tab} phase={phase} setTab={setTab}>
          People
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="invitations" tab={tab} phase={phase} setTab={setTab}>
          Invitations
        </NavTab>
        {hasRegulatorsRight && (
          <>
            <span aria-hidden="true">·</span>
            <NavTab tabKey="regulators" tab={tab} phase={phase} setTab={setTab}>
              Market institutions
            </NavTab>
          </>
        )}
        <span aria-hidden="true">·</span>
        <NavTab tabKey="scoring" tab={tab} phase={phase} setTab={setTab}>
          Scoring
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="national" tab={tab} phase={phase} setTab={setTab}>
          National report
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="firmreports" tab={tab} phase={phase} setTab={setTab}>
          Firm reports
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="wording" tab={tab} phase={phase} setTab={setTab}>
          Wording
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="mail" tab={tab} phase={phase} setTab={setTab}>
          Mail
        </NavTab>
        <span aria-hidden="true">·</span>
        <NavTab tabKey="audit" tab={tab} phase={phase} setTab={setTab}>
          Audit
        </NavTab>
        {session.user.hasDragnetRight && (
          <>
            <span aria-hidden="true">·</span>
            <NavTab tabKey="dragnet" tab={tab} phase={phase} setTab={setTab}>
              Dragnet analysis
            </NavTab>
          </>
        )}
      </nav>

      {!editionId ? (
        <main>
          {serviceDown ? (
            <ErrorState kind="service_unavailable" />
          ) : loadError ? (
            <div className="err">{loadError}</div>
          ) : (
            <p>Loading…</p>
          )}
        </main>
      ) : tab === 'board' ? (
        <MissionBoardPage
          client={client}
          editionId={editionId}
          hasDragnetRight={!!session.user.hasDragnetRight}
          hasRegulatorsRight={hasRegulatorsRight}
          onNavigate={setTab}
        />
      ) : tab === 'responses' ? (
        <ResponsesPage client={client} editionId={editionId} />
      ) : tab === 'unfinished' ? (
        <UnfinishedPage client={client} editionId={editionId} />
      ) : tab === 'edition' ? (
        <EditionPage
          client={client}
          editionId={editionId}
          viewer={session.user}
          onLoaded={applyEdition}
          onEditionCreated={(id) => void refreshEditions(id)}
        />
      ) : tab === 'surveys' ? (
        <SurveysPage
          client={client}
          editionId={editionId}
          viewer={session.user}
          restricted={surveysRestricted(phase)}
        />
      ) : tab === 'renderer' ? (
        <RendererPage client={client} editionId={editionId} />
      ) : tab === 'firmteam' ? (
        <FirmTeamPage client={client} editionId={editionId} />
      ) : tab === 'people' ? (
        <PeopleAccessPage client={client} viewer={session.user} />
      ) : tab === 'invitations' ? (
        <InvitationsPage client={client} editionId={editionId} />
      ) : tab === 'regulators' && hasRegulatorsRight ? (
        <RegulatorsPage client={client} editionId={editionId} />
      ) : tab === 'scoring' ? (
        <ScoresSignoffPage client={client} editionId={editionId} viewer={session.user} />
      ) : tab === 'national' ? (
        <NationalReportPage client={client} editionId={editionId} viewer={session.user} />
      ) : tab === 'mail' ? (
        <MailPage client={client} />
      ) : tab === 'wording' ? (
        <WordingPage client={client} />
      ) : tab === 'audit' ? (
        <AuditPage client={client} editions={editions} />
      ) : tab === 'dragnet' && editionId && session.user.hasDragnetRight ? (
        <DragnetPage client={client} editionId={editionId} />
      ) : (
        <FirmReportsPage client={client} editionId={editionId} viewer={session.user} />
      )}

      <BuildVersion />
    </div>
  );
}
