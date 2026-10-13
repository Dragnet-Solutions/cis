import { useCallback, useEffect, useState } from 'react';
import type { AdminClient } from '../api/client';
import { ApiError, type DependencyDisplayState, type ResponsesMonitor } from '../api/types';
import { outputName, segmentName } from '../shared/outputNames';
import { plural } from '../shared/plural';

/**
 * UX-OPS-003 — Responses monitoring, live-wired to the real evaluator
 * (`@cis/domain` responses-monitoring-service, via
 * `apps/api/src/routes/monitoring.ts`). This surface REPORTS; the mission
 * board is where actions live, so each segment state links to its board card
 * rather than offering its own action. The complete-firm risk shown here
 * reads the SAME computation as the board's conditions 7/8
 * (`getResponsesMonitor` reuses `buildBoardContext`), and the
 * participating-firms card carries complete-firm status as its own
 * structured lines. The firm report is two dependency rows: the guaranteed
 * combined report, and the per-firm category cuts (designed suppression —
 * "Some suppressed", never "At risk").
 */

const DEP_LABEL: Record<DependencyDisplayState, string> = {
  guaranteed: 'Guaranteed',
  some_suppressed: 'Some suppressed',
  at_risk: 'At risk',
  on_track: 'On track',
};
const DEP_PILL: Record<DependencyDisplayState, string> = {
  guaranteed: 'confirmed',
  some_suppressed: 'progress',
  at_risk: 'declined',
  on_track: 'ready',
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ResponsesPage({
  client,
  editionId,
}: {
  client: AdminClient;
  editionId: string;
}): JSX.Element {
  const [monitor, setMonitor] = useState<ResponsesMonitor | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMonitor(await client.getResponsesMonitor(editionId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load responses monitoring');
    }
  }, [client, editionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!monitor) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  return (
    <main>
      <h1 tabIndex={-1}>Responses</h1>
      <p className="lede">
        Where each segment is, and where this pace lands it. The grey bar is where the segment is;
        the red marker is where the forecast lands. This page only reports; what to do about it is
        on the mission board.
      </p>

      {error && <div className="err">{error}</div>}

      <div style={{ display: 'grid', gap: 12, margin: '16px 0' }}>
        {monitor.cards.map((c) => {
          const miss = c.state === 'will_miss';
          return (
            <div
              key={c.segment}
              style={{
                border: '1px solid var(--polish-line-strong, #C8C8C8)',
                borderRadius: 10,
                padding: '14px 16px',
                background: '#fff',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 12,
                }}
              >
                <div>
                  <b style={{ fontSize: 26 }}>{c.current.toLocaleString()}</b>{' '}
                  <span style={{ color: 'var(--fg-3, #6a6a6a)' }}>
                    of {c.target.toLocaleString()}
                  </span>
                </div>
                <span
                  className={`pill ${miss ? 'declined' : c.state === 'closed' ? 'muted' : 'ready'}`}
                >
                  {c.state === 'closed' ? 'Closed' : miss ? 'Will miss' : 'On track'}
                </span>
              </div>
              <h3 style={{ margin: '4px 0 10px' }}>{c.label}</h3>

              {/* grey bar with red forecast marker */}
              <div
                style={{
                  position: 'relative',
                  height: 12,
                  background: 'var(--bg-2, #f4f4f4)',
                  borderRadius: 999,
                  overflow: 'visible',
                  margin: '0 0 10px',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${c.greyBarPct}%`,
                    background: 'var(--fg-2, #3d3d3d)',
                    borderRadius: 999,
                  }}
                />
                {c.redMarkerPct !== null && (
                  <span
                    title="Forecast at close"
                    style={{
                      position: 'absolute',
                      top: -3,
                      left: `${c.redMarkerPct}%`,
                      width: 3,
                      height: 18,
                      background: 'var(--brand-red, #CC0000)',
                      transform: 'translateX(-1px)',
                    }}
                  />
                )}
              </div>

              <p style={{ margin: '0 0 4px', fontWeight: 700 }}>
                {c.forecast === null
                  ? // Null also on day one of collection, before there is any pace.
                    c.daysRemaining > 0
                    ? 'No forecast yet — not enough history to estimate a pace'
                    : 'No forecast — collection is closed'
                  : `Forecast ${c.forecast.toLocaleString()}${c.shortfall > 0 ? ` — short by ${c.shortfall.toLocaleString()}` : ' — clears'}`}
              </p>
              <p style={{ margin: '0 0 8px', color: 'var(--fg-3, #6a6a6a)', fontSize: 14 }}>
                {c.velocity !== null ? `${c.velocity.toFixed(1)} a day now` : 'No pace yet'}
                {c.requiredVelocity !== null &&
                  ` · ${c.requiredVelocity.toFixed(1)} a day needed`}{' '}
                · {plural(c.daysRemaining, 'day')} left
              </p>

              {/* B3: complete-firm status as its OWN structured lines, not prose */}
              {c.completeFirm && (
                <div
                  style={{
                    marginTop: 8,
                    borderTop: '1px solid var(--line, #d9d9d9)',
                    paddingTop: 8,
                  }}
                >
                  {c.completeFirm.map((cl) => (
                    <div
                      key={cl.metric}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        fontSize: 14,
                        padding: '2px 0',
                      }}
                    >
                      <span>
                        <b>{cl.metric}-complete</b> firms ({cl.requiredInstruments.join('+')})
                      </span>
                      <span>
                        {cl.current} now
                        {cl.forecast !== null && ` · forecast ${cl.forecast}`}{' '}
                        <span className={`pill ${cl.state === 'will_miss' ? 'declined' : 'ready'}`}>
                          {cl.state === 'will_miss' ? 'Will miss' : 'On track'}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <p style={{ margin: '8px 0 0', fontSize: 13 }}>
                <a href={`#board-${c.boardConditionId}`} className="textlink">
                  See the mission-board card →
                </a>
              </p>
            </div>
          );
        })}
      </div>

      <h2 style={{ marginTop: 24 }}>Report dependencies</h2>
      <p className="lede">
        Which promised outputs are threatened, flagged now while there is time to fix them — not
        discovered missing at publication.
      </p>
      <div className="tablewrap" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--line, #d9d9d9)' }}>
              <th style={{ padding: '8px 10px' }}>Output</th>
              <th style={{ padding: '8px 10px' }}>Depends on</th>
              <th style={{ padding: '8px 10px' }}>Needs instruments</th>
              <th style={{ padding: '8px 10px' }}>State</th>
            </tr>
          </thead>
          <tbody>
            {monitor.dependencies.map((d) => (
              <tr key={d.outputId} style={{ borderBottom: '1px solid var(--line, #d9d9d9)' }}>
                <td style={{ padding: '8px 10px' }}>
                  <b>{outputName(d.outputId)}</b>
                  <span style={{ display: 'block', color: 'var(--fg-3, #6a6a6a)', fontSize: 13 }}>
                    {d.note}
                  </span>
                </td>
                <td style={{ padding: '8px 10px' }}>
                  {d.regulators
                    ? `The regulators (${d.regulators.confirmed} of ${d.regulators.required} responded)`
                    : capitalise(d.dependsOn.map((s) => segmentName(s)).join(', '))}
                </td>
                <td style={{ padding: '8px 10px' }}>
                  {d.requiredInstruments ? d.requiredInstruments.join('+') : '—'}
                </td>
                <td style={{ padding: '8px 10px' }}>
                  <span className={`pill ${DEP_PILL[d.displayState]}`}>
                    {DEP_LABEL[d.displayState]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
