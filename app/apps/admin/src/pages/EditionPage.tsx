import { useCallback, useEffect, useState } from 'react';
import type { AdminClient } from '../api/client';
import {
  ApiError,
  type AuthUser,
  type EditionDetail,
  type SampleFloorCategory,
} from '../api/types';
import { Pill, type PillKind } from '../components/Pill';
import { CriticalActionRequest, CriticalActionReview } from '../components/MakerChecker';

const LOCK_COPY = {
  eyebrow: 'Needs a second person',
  does: 'Collection ends and the dataset is fixed for scoring.',
  undo: 'Surveys in progress are lost, and reopening does not recover them — those respondents have gone.',
};

const FLOOR_LABELS: Record<SampleFloorCategory, string> = {
  firm: 'Participating firms',
  retail: 'Retail investors',
  local_institution: 'Local institutions',
  foreign_institution: 'Foreign institutions',
};

const FLOOR_ORDER: SampleFloorCategory[] = [
  'firm',
  'retail',
  'local_institution',
  'foreign_institution',
];

type View = 'main' | 'request' | 'review';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** A calendar day as YYYY-MM-DD in the viewer's own timezone. */
function localDayKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The calendar day an edition date was set for (the date the operator picked). */
function setDayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Whether a set date is today or already behind us. */
export function dateStanding(iso: string, today: Date = new Date()): 'past' | 'today' | 'future' {
  const set = setDayKey(iso);
  const now = localDayKey(today);
  return set < now ? 'past' : set === now ? 'today' : 'future';
}

/** The banner shown when the launch date is reached but the instruments are not frozen. */
export function launchDateBanner(plannedOpenAt: string | null, today: Date = new Date()): string {
  const arrived = plannedOpenAt !== null && dateStanding(plannedOpenAt, today) === 'today';
  return `The planned launch date has ${arrived ? 'arrived' : 'passed'}, but the survey instruments are not frozen.`;
}

/** How the last day for returns reads once the results are locked: "Passed" only
 *  when that day is actually behind us. */
export function lockedClosingLabel(
  surveyCloseAt: string | null,
  today: Date = new Date(),
): { pill: string; dateLabel: string } {
  if (!surveyCloseAt) return { pill: 'Closed (results locked)', dateLabel: 'Closed' };
  switch (dateStanding(surveyCloseAt, today)) {
    case 'past':
      return { pill: 'Passed', dateLabel: 'Closed' };
    case 'today':
      return { pill: 'Closed (results locked)', dateLabel: 'Last day for returns' };
    case 'future':
      return { pill: 'Closed early (results locked)', dateLabel: 'Had been set for' };
  }
}

export function EditionPage({
  client,
  editionId,
  viewer,
  onLoaded,
}: {
  client: AdminClient;
  editionId: string;
  viewer: AuthUser;
  /** Called with every fresh load, so the shell can re-gate its nav when a
   *  lock/open/close changes the edition's phase. */
  onLoaded?: (detail: EditionDetail) => void;
}): JSX.Element {
  const [edition, setEdition] = useState<EditionDetail | null>(null);
  const [view, setView] = useState<View>('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftFloors, setDraftFloors] = useState<Record<string, number>>({});
  const [draftClose, setDraftClose] = useState<string>('');
  const [draftOpen, setDraftOpen] = useState<string>('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const detail = await client.getEdition(editionId);
      setEdition(detail);
      onLoaded?.(detail);
      setDraftFloors(Object.fromEntries(detail.floors.map((f) => [f.category, f.floorValue])));
      setDraftClose(detail.surveyCloseAt ? detail.surveyCloseAt.slice(0, 10) : '');
      setDraftOpen(detail.plannedOpenAt ? detail.plannedOpenAt.slice(0, 10) : '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the edition');
    }
  }, [client, editionId, onLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
        setView('main');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!edition) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  const isDraft = edition.status === 'draft';
  const isOpen = edition.status === 'open';
  const isLocked = edition.status === 'locked';
  const eyebrow = isDraft ? 'Nothing sent yet' : isOpen ? 'Collecting' : 'Results locked';

  if (view === 'request') {
    return (
      <main>
        <CriticalActionRequest
          eyebrow={LOCK_COPY.eyebrow}
          title={`Lock the ${edition.label} results`}
          doesText={LOCK_COPY.does}
          undoText={LOCK_COPY.undo}
          busy={busy}
          onCancel={() => setView('main')}
          onSubmit={(reason) => run(() => client.requestLock(editionId, reason))}
        />
        {error && <div className="err">{error}</div>}
      </main>
    );
  }

  if (view === 'review' && edition.pendingLock) {
    return (
      <main>
        <CriticalActionReview
          eyebrow="Someone has asked for this"
          title={`Lock the ${edition.label} results`}
          doesText={LOCK_COPY.does}
          undoText={LOCK_COPY.undo}
          pending={edition.pendingLock}
          viewer={viewer}
          busy={busy}
          onBack={() => setView('main')}
          onDecide={(approved) =>
            run(() => client.decideLock(editionId, edition.pendingLock!.id, approved))
          }
        />
        {error && <div className="err">{error}</div>}
      </main>
    );
  }

  const lockedClosing = lockedClosingLabel(edition.surveyCloseAt);
  const closingPill: [PillKind, string] = isLocked
    ? ['muted', lockedClosing.pill]
    : ['neutral', 'Can be changed'];
  const floorsPill: [PillKind, string] = isDraft ? ['neutral', 'Can be changed'] : ['ok', 'Fixed'];

  return (
    <main>
      <p className="eyebrow">{eyebrow}</p>
      <h1 tabIndex={-1}>{edition.label} edition</h1>
      <p className="lede">State of Stockbroking Operations and Investor Experience in Nigeria.</p>

      {edition.pendingLock && (
        <div className="warnbox">
          <b>Lock the {edition.label} results — awaiting a second person</b>
          <p style={{ margin: '6px 0 0' }}>
            Requested by {edition.pendingLock.requestedBy.displayName} ·{' '}
            {new Date(edition.pendingLock.requestedAt).toLocaleString()}
          </p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setView('review')}>
              Review the request
            </button>
          </div>
        </div>
      )}

      {edition.openingProblem === 'launch_date_passed_not_frozen' && (
        <div className="warnbox">
          <b>{launchDateBanner(edition.plannedOpenAt)}</b>
          <p style={{ margin: '6px 0 0' }}>
            The edition cannot open until the instrument set is frozen, on Surveys under Setup.
          </p>
        </div>
      )}

      {/* Planned launch */}
      {isDraft && (
        <section className="stage now">
          <div className="stagehead">
            <h2>Planned launch</h2>
            <Pill kind="neutral">Can be changed</Pill>
          </div>
          <div className="stagebody">
            <p>
              Once the instrument set is frozen and this date arrives, the edition opens on its own
              — nothing to click here on the day.
            </p>
            <div className="field">
              <label htmlFor="openingDate">Planned launch date</label>
              <input
                id="openingDate"
                type="date"
                value={draftOpen}
                onChange={(e) => setDraftOpen(e.target.value)}
              />
              <div className="actions">
                <button
                  type="button"
                  className="btn-2"
                  disabled={busy || draftOpen === (edition.plannedOpenAt?.slice(0, 10) ?? '')}
                  onClick={() => run(() => client.setOpeningDate(editionId, draftOpen || null))}
                >
                  Save date
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Closing date */}
      <section className={`stage${isLocked ? '' : ' now'}`}>
        <div className="stagehead">
          <h2>Last day for returns</h2>
          <Pill kind={closingPill[0]}>{closingPill[1]}</Pill>
        </div>
        <div className="stagebody">
          <p>
            {isLocked
              ? `Collection ended when the results were locked. Nothing returned after that is in the ${edition.label} edition.`
              : `Anything not returned by this date is not in the ${edition.label} edition. It can be moved while collection is running.`}
          </p>
          {isLocked ? (
            <dl className="kv">
              <dt>{lockedClosing.dateLabel}</dt>
              <dd>{formatDate(edition.surveyCloseAt)}</dd>
            </dl>
          ) : (
            <div className="field">
              <label htmlFor="closingDate">Last day for returns</label>
              <input
                id="closingDate"
                type="date"
                value={draftClose}
                onChange={(e) => setDraftClose(e.target.value)}
              />
              <div className="actions">
                <button
                  type="button"
                  className="btn-2"
                  disabled={
                    busy || !draftClose || draftClose === edition.surveyCloseAt?.slice(0, 10)
                  }
                  onClick={() => run(() => client.setClosingDate(editionId, draftClose))}
                >
                  Save date
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Sample floors */}
      <section className={`stage${isDraft ? ' now' : ''}`}>
        <div className="stagehead">
          <h2>How much data is enough</h2>
          <Pill kind={floorsPill[0]}>{floorsPill[1]}</Pill>
        </div>
        <div className="stagebody">
          <p>
            {isDraft
              ? 'Below these a segment cannot be reported without exposing individuals. They decide what the edition can say, so they are set before collection rather than after the numbers arrive.'
              : 'Fixed when the edition opened. Changing a floor once collection is under way would be choosing what is reportable while knowing what the data says.'}
          </p>
          <div className="floors">
            {FLOOR_ORDER.map((cat) => {
              const current = edition.floors.find((f) => f.category === cat);
              return (
                <div className="frow" key={cat}>
                  <label htmlFor={`f-${cat}`}>{FLOOR_LABELS[cat]}</label>
                  {isDraft ? (
                    <input
                      id={`f-${cat}`}
                      type="number"
                      min={1}
                      value={draftFloors[cat] ?? ''}
                      onChange={(e) =>
                        setDraftFloors((prev) => ({
                          ...prev,
                          [cat]: parseInt(e.target.value, 10) || 0,
                        }))
                      }
                    />
                  ) : (
                    <span className="fixed">{current?.floorValue ?? '—'}</span>
                  )}
                </div>
              );
            })}
          </div>
          {isDraft && (
            <div className="actions">
              <button
                type="button"
                className="btn-2"
                disabled={busy}
                onClick={() =>
                  run(() =>
                    client.setFloors(
                      editionId,
                      FLOOR_ORDER.map((cat) => ({
                        category: cat,
                        floorValue: draftFloors[cat] ?? 0,
                      })),
                    ),
                  )
                }
              >
                Save floors
              </button>
            </div>
          )}
        </div>
      </section>

      {/* State */}
      <section className={`stage${isLocked ? '' : ' now'}`}>
        <div className="stagehead">
          <h2>
            {isDraft
              ? 'Nothing has been sent yet'
              : isOpen
                ? 'Locking the results'
                : 'Results are locked'}
          </h2>
          <Pill kind={isDraft ? 'neutral' : isOpen ? 'ok' : 'muted'}>
            {isDraft ? 'Not started' : isOpen ? 'Collecting' : 'Locked'}
          </Pill>
        </div>
        <div className="stagebody">
          {isDraft && (
            <>
              <p>
                The edition opens on its own once the instrument set is frozen and the planned
                launch date above arrives — nothing to click here on the day.
              </p>
              <div className="note">
                <h3>Before the planned launch date</h3>
                <p>
                  The survey instruments must be frozen, on Surveys under Setup. Floors should be
                  set here first — they fix once collection begins.
                </p>
              </div>
            </>
          )}
          {isOpen && (
            <>
              <p>Collection is running. Locking ends it and fixes the dataset for scoring.</p>
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  disabled={!!edition.pendingLock}
                  onClick={() => setView('request')}
                >
                  Lock the results
                </button>
              </div>
            </>
          )}
          {isLocked && (
            <p>
              Collection has ended and the dataset is fixed. Scoring and reporting are under
              Results.
            </p>
          )}
        </div>
      </section>

      {error && <div className="err">{error}</div>}
    </main>
  );
}
