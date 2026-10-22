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

const ADD_COPY = {
  eyebrow: 'Needs a second person',
  title: 'Freeze the new instruments for this edition',
  does: 'Adds only the instruments not yet frozen for this edition. Those already frozen are not touched.',
  undo: 'Irreversible for this edition. Until it is approved, no survey link can be issued for these instruments in this edition.',
};

type View = 'main' | 'request' | 'review';

export function SurveysPage({
  client,
  editionId,
  viewer,
  restricted = false,
}: {
  client: AdminClient;
  editionId: string;
  viewer: AuthUser;
  /** Collection is running (D-01): show only the questionnaires not yet
   *  frozen for this edition, and the freeze request for them. */
  restricted?: boolean;
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

  // After the first freeze, the only thing left to freeze is instruments
  // registered since (e.g. I-LCFE joining an open edition).
  const copy = data.frozen || restricted ? ADD_COPY : FREEZE_COPY;

  if (view === 'request') {
    return (
      <main>
        <CriticalActionRequest
          eyebrow={copy.eyebrow}
          title={copy.title}
          doesText={copy.does}
          undoText={copy.undo}
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
          title={copy.title}
          doesText={copy.does}
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
  const pendingNew = frozen ? (data.pendingInstruments ?? []) : [];

  if (restricted) {
    return (
      <RestrictedSurveys
        pending={instruments.filter((i) => !i.frozen)}
        pendingFreeze={pendingFreeze}
        onRequest={() => setView('request')}
        onReview={() => setView('review')}
        error={error}
      />
    );
  }

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
          {frozen && pendingNew.length > 0 ? (
            <>
              <div className="warnbox">
                <b>
                  {pendingNew.length} new instrument{pendingNew.length === 1 ? '' : 's'} not yet
                  frozen for this edition
                </b>
                <p style={{ margin: '6px 0 0' }}>
                  {pendingNew.join(', ')}. The instruments already frozen stay exactly as they are,
                  and collection continues. No survey link can be issued for the new ones in this
                  edition until they are frozen, which needs a second person.
                </p>
              </div>
              {pendingFreeze ? (
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
              ) : (
                <div className="actions">
                  <button type="button" className="btn" onClick={() => setView('request')}>
                    Freeze the new instruments
                  </button>
                </div>
              )}
            </>
          ) : frozen ? (
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

/**
 * Surveys while the edition is collecting (D-01). Everything already frozen is
 * out of reach; the only action is freezing questionnaires that joined the
 * register after the edition was frozen — one maker-checker request covers all
 * of them — so their survey links can be issued.
 */
function RestrictedSurveys({
  pending,
  pendingFreeze,
  onRequest,
  onReview,
  error,
}: {
  pending: InstrumentsResponse['instruments'];
  pendingFreeze: InstrumentsResponse['pendingFreeze'];
  onRequest: () => void;
  onReview: () => void;
  error: string | null;
}): JSX.Element {
  return (
    <main>
      <p className="eyebrow">Collecting</p>
      <h1 tabIndex={-1}>Surveys</h1>
      <p className="lede">
        While collection is running, the questionnaires already frozen cannot be changed. Only a
        questionnaire added since the edition was frozen can be frozen here, so its survey link can
        be issued.
      </p>

      {pending.length === 0 ? (
        <section className="stage">
          <div className="stagehead">
            <h2>All questionnaires are frozen for this edition</h2>
            <Pill kind="ok">Frozen</Pill>
          </div>
          <div className="stagebody">
            <p>Every survey link can be issued. There is nothing to do here.</p>
          </div>
        </section>
      ) : (
        <section className="stage now">
          <div className="stagehead">
            <h2>
              {pending.length} questionnaire{pending.length === 1 ? '' : 's'} not yet frozen for
              this edition
            </h2>
            <Pill kind="neutral">Not frozen</Pill>
          </div>
          <div className="stagebody">
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Questionnaire</th>
                    <th scope="col">Questions</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((inst) => (
                    <tr key={inst.code}>
                      <td>
                        <strong>
                          {inst.code} · {inst.respondent ?? inst.name}
                        </strong>
                      </td>
                      <td>{inst.questionCount ?? '—'}</td>
                      <td>
                        <span className="tag soft">Not frozen</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              No survey link can be issued for {pending.length === 1 ? 'it' : 'these'} until{' '}
              {pending.length === 1 ? 'it is' : 'they are'} frozen. One request covers all of them,
              and a second person approves it. Freezing is irreversible for this edition.
            </p>
            {pendingFreeze ? (
              <div className="warnbox">
                <b>Awaiting a second person</b>
                <p style={{ margin: '6px 0 0' }}>
                  Requested by {pendingFreeze.requestedBy.displayName} ·{' '}
                  {new Date(pendingFreeze.requestedAt).toLocaleString()}
                </p>
                <div className="actions">
                  <button type="button" className="btn" onClick={onReview}>
                    Review the request
                  </button>
                </div>
              </div>
            ) : (
              <div className="actions">
                <button type="button" className="btn" onClick={onRequest}>
                  Request freeze
                </button>
              </div>
            )}
          </div>
        </section>
      )}

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
