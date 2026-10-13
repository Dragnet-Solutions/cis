import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createClient } from './api/client';
import { ApiError } from './api/types';
import { ErrorState } from './shared/ErrorState';
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

type Tab =
  | 'board'
  | 'responses'
  | 'unfinished'
  | 'edition'
  | 'surveys'
  | 'renderer'
  | 'firmteam'
  | 'people'
  | 'invitations'
  | 'regulators'
  | 'scoring'
  | 'national'
  | 'firmreports'
  | 'wording'
  | 'dragnet';

/**
 * Which nav tabs are relevant in which edition phase (UX-OPS-001: "sections
 * not yet relevant... are shown disabled, not hidden"). A tab not listed for
 * the current phase is rendered disabled, never hidden — the shape of the
 * whole programme stays visible from day one.
 */
const TAB_PHASES: Record<Tab, EditionPhase[]> = {
  board: ['before_launch', 'collection_open', 'closing_week', 'closed'],
  edition: ['before_launch', 'collection_open', 'closing_week', 'closed'],
  surveys: ['before_launch'],
  renderer: ['before_launch', 'collection_open'],
  firmteam: ['before_launch', 'collection_open', 'closing_week'],
  people: ['before_launch', 'collection_open', 'closing_week', 'closed'],
  invitations: ['before_launch', 'collection_open', 'closing_week'],
  regulators: ['before_launch', 'collection_open', 'closing_week'],
  responses: ['collection_open', 'closing_week'],
  unfinished: ['collection_open', 'closing_week'],
  scoring: ['closed'],
  national: ['closed'],
  firmreports: ['closed'],
  wording: ['before_launch', 'collection_open', 'closing_week', 'closed'],
  dragnet: ['before_launch', 'collection_open', 'closing_week', 'closed'],
};

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
  const relevant = TAB_PHASES[tabKey].includes(phase);
  return (
    <button
      type="button"
      disabled={!relevant}
      onClick={() => setTab(tabKey)}
      style={tab === tabKey ? { color: 'var(--dragnet-black)' } : undefined}
      title={relevant ? undefined : 'Not relevant in this edition phase'}
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
  const [phase, setPhase] = useState<EditionPhase>('before_launch');
  const [tab, setTab] = useState<Tab>('edition');
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
        const current = editions.find((e) => e.label === '2026') ?? editions[0];
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

  return (
    <div className="shell">
      <header className="top">
        <div className="lockup">
          CIS × Dragnet Benchmark
          <small>Study operations</small>
        </div>
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
        <span aria-hidden="true">·</span>
        <NavTab tabKey="regulators" tab={tab} phase={phase} setTab={setTab}>
          Regulators
        </NavTab>
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
        />
      ) : tab === 'surveys' ? (
        <SurveysPage client={client} editionId={editionId} viewer={session.user} />
      ) : tab === 'renderer' ? (
        <RendererPage client={client} />
      ) : tab === 'firmteam' ? (
        <FirmTeamPage client={client} editionId={editionId} />
      ) : tab === 'people' ? (
        <PeopleAccessPage client={client} viewer={session.user} />
      ) : tab === 'invitations' ? (
        <InvitationsPage client={client} editionId={editionId} />
      ) : tab === 'regulators' ? (
        <RegulatorsPage client={client} editionId={editionId} />
      ) : tab === 'scoring' ? (
        <ScoresSignoffPage client={client} editionId={editionId} viewer={session.user} />
      ) : tab === 'national' ? (
        <NationalReportPage client={client} editionId={editionId} viewer={session.user} />
      ) : tab === 'wording' ? (
        <WordingPage client={client} />
      ) : tab === 'dragnet' && editionId && session.user.hasDragnetRight ? (
        <DragnetPage client={client} editionId={editionId} />
      ) : (
        <FirmReportsPage client={client} editionId={editionId} viewer={session.user} />
      )}
    </div>
  );
}
