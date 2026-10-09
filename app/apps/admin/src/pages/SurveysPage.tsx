import { useCallback, useEffect, useState } from 'react';
import type { AdminClient } from '../api/client';
import { ApiError, type AuthUser, type InstrumentsResponse } from '../api/types';
import { Pill } from '../components/Pill';
import { CriticalActionRequest, CriticalActionReview } from '../components/MakerChecker';

const FREEZE_COPY = {
  eyebrow: 'Needs a second person',
  title: 'Freeze the instruments',
  does: 'No question, option or order changes after this.',
  undo: 'Collection cannot open until the instruments are frozen, and a frozen instrument cannot be edited — a question changed mid-collection would mean two different surveys answered under one name.',
};

type View = 'main' | 'request' | 'review';

export function SurveysPage({
  client,
  editionId,
  viewer,
}: {
  client: AdminClient;
  editionId: string;
  viewer: AuthUser;
}): JSX.Element {
  const [data, setData] = useState<InstrumentsResponse | null>(null);
  const [view, setView] = useState<View>('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await client.getInstruments(editionId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the instruments');
    }
  }, [client, editionId]);

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

  if (!data) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  if (view === 'request') {
    return (
      <main>
        <CriticalActionRequest
          eyebrow={FREEZE_COPY.eyebrow}
          title={FREEZE_COPY.title}
          doesText={FREEZE_COPY.does}
          undoText={FREEZE_COPY.undo}
          busy={busy}
          onCancel={() => setView('main')}
          onSubmit={(reason) => run(() => client.requestFreeze(editionId, reason))}
        />
        {error && <div className="err">{error}</div>}
      </main>
    );
  }

  if (view === 'review' && data.pendingFreeze) {
    return (
      <main>
        <CriticalActionReview
          eyebrow="Someone has asked for this"
          title={FREEZE_COPY.title}
          doesText={FREEZE_COPY.does}
          undoText="Irreversible for this edition."
          pending={data.pendingFreeze}
          viewer={viewer}
          busy={busy}
          onBack={() => setView('main')}
          onDecide={(approved) =>
            run(() => client.decideFreeze(editionId, data.pendingFreeze!.id, approved))
          }
        />
        {error && <div className="err">{error}</div>}
      </main>
    );
  }

  const { frozen, instruments, drgOps, pendingFreeze } = data;

  return (
    <main>
      <p className="eyebrow">{frozen ? 'Frozen' : 'Not yet frozen'}</p>
      <h1 tabIndex={-1}>Surveys</h1>
      <p className="lede">{instrumentSummary(instruments)}</p>

      {frozen && (
        <div className="warnbox">
          <b>The instruments are frozen for this edition.</b>
          <p style={{ margin: '6px 0 0' }}>
            Nothing here can be changed. A question altered mid-collection would mean two different
            surveys answered under one name.
          </p>
        </div>
      )}

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Instrument</th>
              <th scope="col">Questions</th>
              <th scope="col">Feeds</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {instruments.map((inst) => (
              <tr key={inst.code} className={inst.scored ? undefined : 'soft'}>
                <td>
                  <strong>
                    {inst.code} · {inst.respondent ?? inst.name}
                  </strong>
                  {!inst.scored && (
                    <>
                      {' '}
                      <span className="tag soft">Contextual</span>
                    </>
                  )}
                </td>
                <td>{inst.questionCount ?? '—'}</td>
                <td>{inst.feeds ?? '—'}</td>
                <td>
                  <span className={`tag ${inst.frozen ? 'ok' : 'soft'}`}>
                    {inst.frozen ? 'Frozen' : 'Not frozen'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Operational questions (Dragnet internal) */}
      <section className="stage">
        <div className="stagehead">
          <h2>Operational questions</h2>
          <Pill kind="info">Dragnet internal</Pill>
        </div>
        <div className="stagebody">
          <p>
            {drgOps.length === 1
              ? 'One question that is not scored sits within'
              : `${drgOps.length} questions that are not scored sit within`}{' '}
            the scored firm and investor surveys. Respondents see them as ordinary questions; they
            feed no index and appear in no public or firm output.
          </p>
          <dl className="kv">
            {drgOps.map((q) => (
              <div key={q.questionCode} style={{ display: 'contents' }}>
                <dt>{q.questionCode}</dt>
                <dd>Folded into {q.instrumentCode}</dd>
              </div>
            ))}
          </dl>
          <p className="owner">
            A respondent cannot tell these apart from the signed questions, which is the point — a
            labelled vendor question is answered differently.
          </p>
        </div>
      </section>

      {/* Freeze */}
      <section className={`stage${frozen ? '' : ' now'}`}>
        <div className="stagehead">
          <h2>{frozen ? 'The instruments are frozen' : 'Freezing the instruments'}</h2>
          <Pill kind={frozen ? 'ok' : 'neutral'}>{frozen ? 'Frozen' : 'Open'}</Pill>
        </div>
        <div className="stagebody">
          {frozen ? (
            <p>The instruments are frozen for this edition. Collection may open.</p>
          ) : pendingFreeze ? (
            <>
              <p>
                Collection cannot open until the instruments are frozen. Freezing is irreversible
                for this edition and needs a second person.
              </p>
              <div className="warnbox">
                <b>Awaiting a second person</b>
                <p style={{ margin: '6px 0 0' }}>
                  Requested by {pendingFreeze.requestedBy.displayName} ·{' '}
                  {new Date(pendingFreeze.requestedAt).toLocaleString()}
                </p>
                <div className="actions">
                  <button type="button" className="btn" onClick={() => setView('review')}>
                    Review the request
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <p>
                Collection cannot open until the instruments are frozen. Freezing is irreversible
                for this edition and needs a second person.
              </p>
              <div className="actions">
                <button type="button" className="btn" onClick={() => setView('request')}>
                  Freeze the instruments
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {error && <div className="err">{error}</div>}
    </main>
  );
}

const NUMBER_WORDS = [
  'No',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
];

function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** The lede counts what the edition actually holds — the register gained a
 *  tenth instrument (I-DEP, institutional Family D) after the approved copy
 *  was written as "Nine", so a fixed number drifted out of true. */
export function instrumentSummary(instruments: { scored: boolean }[]): string {
  const total = instruments.length;
  const scored = instruments.filter((i) => i.scored).length;
  const contextual = total - scored;
  const head = `${countWord(total)} instrument${total === 1 ? '' : 's'}.`;
  if (contextual === 0) return `${head} All are scored.`;
  const ctx =
    contextual === 1
      ? 'one is contextual and never enters an index'
      : `${countWord(contextual).toLowerCase()} are contextual and never enter an index`;
  return `${head} ${countWord(scored)} ${scored === 1 ? 'is' : 'are'} scored; ${ctx}.`;
}
