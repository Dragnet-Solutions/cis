import { useCallback, useEffect, useState } from 'react';
import type { AdminClient } from '../api/client';
import { ApiError, type MissionCard, type MissionSeverity } from '../api/types';
import type { EditionPhase } from '../editionPhase';

/**
 * UX-OPS-001 — Study Operations Home & Mission Board. One board, one audience:
 * what needs a person today, ranked by consequence. Live-wired to the real
 * evaluator (`getMissionBoard`, @cis/domain's `evaluateBoard`) — every card,
 * evidence line, consequence and recommended action shown here is a real,
 * currently-computed value, never an illustrative example.
 *
 * Load-bearing behaviours (enforced in @cis/domain, mirrored here in display
 * only):
 *   - Forecast-based, never raw-count: a card exists because trajectory threatens
 *     an agreed outcome AND a concrete bulk action is available.
 *   - One root cause, one card: dependent outputs fold into a card's Consequence.
 *   - No dismissal control — a card auto-clears when its condition stops holding.
 *   - Remediation is always a bulk cohort handed to UX-OPS-002.
 *   - Rail is phase-aware: not-yet-relevant sections are disabled, not hidden.
 */

/** The shell tab each rail shortcut opens — every value is a real nav tab. */
export type RailTarget =
  'invitations' | 'regulators' | 'responses' | 'scoring' | 'dragnet' | 'edition';

interface RailSection {
  key: string;
  label: string;
  target: RailTarget;
  built: boolean;
  phases: EditionPhase[];
}

// Written fresh for this screen — not the brief's own severity-classification
// vocabulary, and not a paraphrase of it. Same six ranks, same order (1 most
// consequential), independently worded for the person reading a card.
export const SEVERITY_LABEL: Record<MissionSeverity, string> = {
  1: 'Puts the whole study at risk',
  2: 'A sample target will be missed',
  3: 'A planned report is at risk',
  4: 'Many firms are stuck in the funnel',
  5: 'A required voice may go missing',
  6: 'Needs a routine follow-up',
};

export const RAIL: RailSection[] = [
  {
    key: 'invitations',
    label: 'Invitations',
    target: 'invitations',
    built: true,
    phases: ['before_launch', 'collection_open', 'closing_week'],
  },
  {
    key: 'regulators',
    label: 'Regulators',
    target: 'regulators',
    built: true,
    phases: ['before_launch', 'collection_open', 'closing_week'],
  },
  {
    key: 'monitoring',
    label: 'Monitoring',
    target: 'responses',
    built: true,
    phases: ['collection_open', 'closing_week'],
  },
  { key: 'results', label: 'Results', target: 'scoring', built: true, phases: ['closed'] },
  {
    key: 'dragnet',
    label: 'Dragnet analysis',
    target: 'dragnet',
    built: true,
    phases: ['closed'],
  },
  {
    key: 'setup',
    label: 'Setup',
    target: 'edition',
    built: true,
    phases: ['before_launch', 'collection_open', 'closing_week', 'closed'],
  },
];

export function MissionBoardPage({
  client,
  editionId,
  onNavigate,
}: {
  client: AdminClient;
  editionId: string;
  onNavigate: (target: RailTarget) => void;
}): JSX.Element {
  const [cards, setCards] = useState<MissionCard[] | null>(null);
  const [phase, setPhase] = useState<EditionPhase>('before_launch');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const board = await client.getMissionBoard(editionId);
      setCards(board.cards);
      setPhase(board.phase);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the mission board');
    }
  }, [client, editionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!cards) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  const ranked = [...cards].sort((a, b) => a.severity - b.severity);

  return (
    <main>
      <p className="eyebrow">Study operations · current edition</p>
      <h1 tabIndex={-1}>What needs a person today</h1>
      <p className="lede">
        Ranked by consequence. A card is here because the current trajectory threatens an agreed
        outcome and there is a concrete action available — never because a number is merely low.
        There is no dismiss control: a card leaves the moment its condition stops being true.
      </p>

      {error && <div className="err">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 220px', gap: 18 }}>
        <div>
          {ranked.length === 0 ? (
            <div className="note">
              <p>Nothing needs a person right now.</p>
            </div>
          ) : (
            ranked.map((c) => (
              <section
                key={c.conditionId}
                className={`stage ${c.severity <= 2 ? 'now' : ''}`}
                style={{ marginBottom: 14 }}
              >
                <div className="stagehead">
                  <h2 style={{ margin: 0 }}>{c.whatIsAtRisk}</h2>
                  <span
                    className={`pill ${c.severity <= 2 ? 'stop' : c.severity <= 4 ? 'wait' : 'todo'}`}
                  >
                    Rank {c.severity} · {SEVERITY_LABEL[c.severity]}
                  </span>
                </div>
                <div className="stagebody">
                  <p style={{ marginTop: 0 }}>
                    <b>Evidence.</b> {c.evidence.join(' · ')}
                  </p>
                  <div className="note">
                    <b>Consequence</b>
                    <ul style={{ margin: '6px 0 0' }}>
                      {c.consequence.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                  {c.why && (
                    <p>
                      <b>Why.</b> {c.why}
                    </p>
                  )}
                  {c.recommendedAction && (
                    <p>
                      <b>Recommended action.</b> {c.recommendedAction.label}
                    </p>
                  )}
                  {c.expectedImpact ? (
                    <p>
                      <b>Expected impact.</b> {c.expectedImpact}
                    </p>
                  ) : (
                    <p className="tag soft">
                      Expected impact not shown yet — not enough history to estimate it.
                    </p>
                  )}
                </div>
              </section>
            ))
          )}
        </div>

        <nav aria-label="Operations" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {RAIL.map((s) => {
            const relevant = s.phases.includes(phase);
            return (
              <button
                key={s.key}
                type="button"
                className="btn-2"
                disabled={!relevant}
                onClick={() => onNavigate(s.target)}
                title={
                  !s.built
                    ? 'Not available yet'
                    : !relevant
                      ? 'Not relevant in this edition phase'
                      : undefined
                }
                style={{ textAlign: 'left', opacity: relevant ? 1 : 0.5 }}
              >
                {s.label}
              </button>
            );
          })}
        </nav>
      </div>
    </main>
  );
}
