import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdminClient } from '../api/client';
import { ApiError, type ReminderStepConfig, type UnfinishedResponse } from '../api/types';
import { plural } from '../shared/plural';

/**
 * UX-OPS-004 — Unfinished (reminder timing & frequency), live-wired to the
 * real evaluator (`@cis/domain` reminder-timing-service, via
 * `apps/api/src/routes/monitoring.ts`). This surface owns WHEN a reminder is
 * sent and HOW OFTEN; UX-RET-007 owns what it says. The schedule and cap are
 * governed config — editing them here calls the real `PUT /reminders/schedule`
 * and `PUT /reminders/cap` routes, not local-only state.
 */

const CAP_LIMIT = 10;

function stepLabel(step: number, total: number): string {
  if (step === 1) return 'First reminder';
  if (step === total) return 'Final reminder';
  return `Reminder ${step}`;
}

export function UnfinishedPage({
  client,
  editionId,
}: {
  client: AdminClient;
  editionId: string;
}): JSX.Element {
  const [tab, setTab] = useState<'who' | 'sched'>('who');
  const [data, setData] = useState<UnfinishedResponse | null>(null);
  const [draftSchedule, setDraftSchedule] = useState<ReminderStepConfig[]>([]);
  const [draftCap, setDraftCap] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await client.getUnfinished(editionId);
      setData(res);
      setDraftSchedule(res.schedule.steps);
      setDraftCap(res.cap);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load reminder data');
    }
  }, [client, editionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const peakN = useMemo(
    () => (data ? Math.max(0, ...data.dropoff.map((s) => s.count)) : 0),
    [data],
  );
  const totalStops = useMemo(
    () => (data ? data.dropoff.reduce((a, s) => a + s.count, 0) : 0),
    [data],
  );
  const peak = data?.dropoff.find((s) => s.peak) ?? null;
  const peakShare = peak && totalStops > 0 ? Math.round((peak.count / totalStops) * 100) : 0;

  const setStepValue = (step: number, value: number): void => {
    setDraftSchedule((prev) =>
      prev.map((s) =>
        s.step === step
          ? s.kind === 'relative'
            ? { ...s, days: value }
            : { ...s, beforeCloseDays: value }
          : s,
      ),
    );
  };
  const toggleStep = (step: number): void => {
    setDraftSchedule((prev) =>
      prev.map((s) => (s.step === step ? { ...s, enabled: !s.enabled } : s)),
    );
  };

  async function saveSchedule(): Promise<void> {
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      await client.setReminderSchedule({ steps: draftSchedule });
      setSavedMsg('Schedule saved.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the schedule');
    } finally {
      setBusy(false);
    }
  }

  async function saveCap(): Promise<void> {
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      await client.setReminderCap(draftCap);
      setSavedMsg('Cap saved.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the cap');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  const onCount = draftSchedule.filter((s) => s.enabled).length;
  const scheduleChanged = JSON.stringify(draftSchedule) !== JSON.stringify(data.schedule.steps);
  const capChanged = draftCap !== data.cap;

  return (
    <main>
      <h1 tabIndex={-1}>Unfinished</h1>
      <p className="lede">
        {plural(data.stats.unfinished, 'person', 'people')} started and did not submit.{' '}
        {data.stats.unfinished === 0
          ? 'Nobody needs reminding.'
          : `${data.stats.reachable.toLocaleString()} of them gave a contact detail and can be reminded.`}
      </p>

      {error && <div className="err">{error}</div>}

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'who'}
          onClick={() => setTab('who')}
        >
          Who is unfinished
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sched'}
          onClick={() => setTab('sched')}
        >
          Reminder schedule
        </button>
      </div>

      {tab === 'who' ? (
        <div>
          <div className="statgrid">
            <div className="stat attention">
              <b>{data.stats.unfinished}</b>
              <span>Started, not submitted</span>
            </div>
            <div className="stat">
              <b>{data.stats.reachable}</b>
              <span>Can be reminded</span>
              <i>gave a contact detail</i>
            </div>
            <div className="stat attention">
              <b>{data.stats.unreachable}</b>
              <span>Cannot be reached</span>
              <i>declined contact details</i>
            </div>
          </div>

          <h2 style={{ marginTop: 22 }}>Where they stopped</h2>
          <p className="lede">
            Every unfinished response, by the last question answered. A cluster is a question doing
            damage.
          </p>
          <div className="drop">
            {data.dropoff.length === 0 && <p className="muted">No drop-off data recorded yet.</p>}
            {data.dropoff.map((s) => (
              <div
                className={`drow${s.peak ? ' peak' : ''}`}
                key={s.questionId}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto minmax(80px, 30%)',
                  gap: 12,
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: '1px solid var(--line, #d9d9d9)',
                }}
              >
                <div>
                  <b>{s.label}</b>
                  {s.surveyName && (
                    <span style={{ display: 'block', color: 'var(--fg-3, #6a6a6a)', fontSize: 13 }}>
                      {s.surveyName}
                    </span>
                  )}
                </div>
                <div className="n">{plural(s.count, 'person', 'people')}</div>
                <div
                  className="bar"
                  style={{ height: 8, background: 'var(--bg-2, #f4f4f4)', borderRadius: 999 }}
                >
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      borderRadius: 999,
                      background: s.peak ? 'var(--brand-red, #CC0000)' : 'var(--fg-2, #3d3d3d)',
                      width: `${peakN > 0 ? (s.count / peakN) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          {peak && (
            <div className="warnbox">
              <b>{peakShare}% of everyone who stopped, stopped at the same question.</b> A reminder
              brings some of them back to the same question; the question itself is an instrument
              matter, and instrument changes belong to the next edition.
            </div>
          )}

          <p className="owner">
            An answer already given is kept. A person who returns picks up where they stopped —
            nothing is retaken.
          </p>
        </div>
      ) : (
        <div>
          <p className="lede">
            When a reminder goes out, counted from the moment someone stopped. This is the only
            place these figures are set.
          </p>
          <div className="sched">
            {draftSchedule.map((s) => (
              <div className={`srow${s.enabled ? '' : ' off'}`} key={s.step}>
                <span className="num">{s.step}</span>
                <div>
                  <b>{stepLabel(s.step, draftSchedule.length)}</b>
                  <span className="sub">
                    {s.kind === 'relative'
                      ? 'Days after they stopped.'
                      : 'Days before the last day for returns.'}
                  </span>
                </div>
                <div className="ctl">
                  <input
                    type="number"
                    min={1}
                    disabled={!s.enabled}
                    value={s.kind === 'relative' ? (s.days ?? 1) : (s.beforeCloseDays ?? 1)}
                    onChange={(e) => setStepValue(s.step, parseInt(e.target.value, 10) || 1)}
                  />
                  <span className="sub">
                    {s.kind === 'relative' ? 'days after stopping' : 'days before close'}
                  </span>
                  <button
                    type="button"
                    className="toggle"
                    aria-pressed={s.enabled}
                    onClick={() => toggleStep(s.step)}
                  >
                    {s.enabled ? 'On' : 'Off'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <p className="capline">
            <b>No more than</b>{' '}
            <input
              type="number"
              min={0}
              max={CAP_LIMIT}
              style={{ width: 50 }}
              value={draftCap}
              onChange={(e) => setDraftCap(parseInt(e.target.value, 10) || 0)}
            />{' '}
            <b>reminders to any one person.</b>{' '}
            {onCount === 0
              ? 'Every reminder is currently off. Nobody will be reminded.'
              : `${plural(onCount, 'reminder')} ${onCount === 1 ? 'is' : 'are'} currently on.`}
          </p>

          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy || !scheduleChanged}
              onClick={() => void saveSchedule()}
            >
              Save schedule
            </button>
            <button
              type="button"
              className="btn-2"
              disabled={busy || !capChanged}
              onClick={() => void saveCap()}
            >
              Save cap
            </button>
          </div>
          {savedMsg && <p className="qstate ok">{savedMsg}</p>}

          <div className="note">
            <h3>What a reminder cannot do</h3>
            <p>
              It goes only to people who gave a contact detail when they started. Someone who
              declined cannot be reminded, and there is no other way to reach them.
            </p>
          </div>

          <p className="owner">
            The reminder wording is approved separately. This screen sets only when it is sent and
            how often.
          </p>
        </div>
      )}
    </main>
  );
}
