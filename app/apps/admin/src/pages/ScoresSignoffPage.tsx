import { useCallback, useEffect, useState } from 'react';
import { MethodologyApproval } from './MethodologyApproval';
import type { AdminClient } from '../api/client';
import {
  ApiError,
  type AuthUser,
  type CalculationRun,
  type IndexScoreView,
  type ScoringSignoff,
} from '../api/types';
import { isViewer, operatorName } from '../shared/operatorName';
import { plural } from '../shared/plural';

/**
 * UX-ADM-004 — Setup: Results, Scores (sign-off). The maker-checker gate on
 * which scoring run becomes official, live-wired to the real evaluator
 * (`@cis/domain` scoring-signoff-service, via `apps/api/src/routes/scoring.ts`):
 *   - Scoring is REFUSED while collection is open — enforced by the trigger
 *     endpoint; a refusal surfaces here as the real domain error message.
 *   - Every run is kept, including superseded ones, with who/when.
 *   - A later run supersedes a signed one only WHEN THE NEW ONE IS SIGNED OFF;
 *     nothing already released is recalled.
 *   - Each index shows its real score, effective population, and floor-clear
 *     status; a sub-floor index is FLAGGED, not hidden.
 *   - Sign-off needs a STRUCTURED account of what was checked; a maker can
 *     never approve their own request.
 *
 *   - A reviewer may also reject a request, with a reason — a different
 *     person than the requester, same as approval — after which the run is
 *     free for a fresh sign-off request.
 */

const CHECKLIST = [
  {
    key: 'populationCountsReviewed',
    label: 'How many firms or respondents each index is based on',
  },
  { key: 'floorStatusReviewed', label: 'Which indices are above or below their floor' },
  { key: 'dataQualityFlagsReviewed', label: 'The known data-quality issues' },
] as const;

type View = 'main' | 'request' | 'review';

export function ScoresSignoffPage({
  client,
  editionId,
  viewer,
}: {
  client: AdminClient;
  editionId: string;
  viewer: AuthUser;
}): JSX.Element {
  const [runs, setRuns] = useState<CalculationRun[] | null>(null);
  const [signoffs, setSignoffs] = useState<ScoringSignoff[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [scores, setScores] = useState<IndexScoreView[] | null>(null);
  const [view, setView] = useState<View>('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await client.getScoringRuns(editionId);
      setRuns(data.runs);
      setSignoffs(data.signoffs);
      setNames(data.operatorNames ?? {});
      const current = data.runs[0];
      if (current) {
        const sv = await client.getScoreView(editionId, current.id);
        setScores(sv.scores);
      } else {
        setScores(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load scoring');
    }
  }, [client, editionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const doRun = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
        setView('main');
        setChecked({});
        setRejecting(false);
        setRejectReason('');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (runs === null) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  const currentRun = runs[0] ?? null;
  // A rejected sign-off is not "live" — same as superseded — so the run is
  // free for a fresh request once one is rejected.
  const liveSignoff = currentRun
    ? (signoffs.find((s) => s.calculationRunId === currentRun.id && s.state === 'requested') ??
      signoffs.find((s) => s.calculationRunId === currentRun.id && s.state === 'signed_off') ??
      null)
    : null;
  const lastRejected =
    !liveSignoff && currentRun
      ? (signoffs.find((s) => s.calculationRunId === currentRun.id && s.state === 'rejected') ??
        null)
      : null;
  const allChecked = CHECKLIST.every((c) => checked[c.key]);
  const flagged = (scores ?? []).filter((s) => s.subFloor);
  const isOwnRequest =
    liveSignoff?.state === 'requested' && isViewer(liveSignoff.requestedBy, viewer);
  const isReviewable =
    liveSignoff?.state === 'requested' && !isViewer(liveSignoff.requestedBy, viewer);

  return (
    <main>
      <p className="eyebrow">Results · Scoring</p>
      <h1 tabIndex={-1}>Scoring</h1>
      <p className="lede">
        Five indices, computed from the six scored instruments. A run is a snapshot: it can be
        repeated, and the one that is signed off is the one every national and firm report is
        generated from.
      </p>

      {error && <div className="err">{error}</div>}

      <MethodologyApproval client={client} onChange={() => void load()} />

      {!currentRun ? (
        <div className="warnbox">
          <b>No scoring run exists yet for this edition.</b>
          <p style={{ margin: '6px 0 0' }}>
            A run scores the frozen dataset — it is refused while collection is still open.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => doRun(() => client.triggerScoringRun(editionId))}
            >
              Run scoring
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="note">
            <h3>The weighting is still being validated</h3>
            <p>
              Which questions make up each index is fixed by the Reporting Specification. How they
              are weighted within each index is Dragnet&apos;s methodology and is{' '}
              <b>pending validation</b> by the methodology partner, so it can still be updated
              before the results are final.
            </p>
          </div>

          <div className="tablewrap">
            <table className="ftbl">
              <thead>
                <tr>
                  <th>Index</th>
                  <th>Population</th>
                  <th>Score</th>
                  <th>Floor</th>
                </tr>
              </thead>
              <tbody>
                {(scores ?? []).map((i) => (
                  <tr key={i.metricCode}>
                    <td>
                      <b>{i.metricCode}</b>
                    </td>
                    <td>
                      {i.populationLabel}
                      {i.effectivePopulation !== null && ` — ${i.effectivePopulation}`}
                    </td>
                    <td>
                      {i.score === null ? (
                        currentRun?.methodologyStatus === 'APPROVED' ? (
                          <span className="tag soft">Not calculable</span>
                        ) : (
                          <span className="tag wait">Pending validation</span>
                        )
                      ) : (
                        <>
                          {i.score} <span className="muted">/ 100</span>
                        </>
                      )}
                    </td>
                    <td>
                      {i.clearsFloor === null ? (
                        <span className="tag soft">Not applicable</span>
                      ) : (
                        <span className={`tag ${i.subFloor ? 'risk' : 'ok'}`}>
                          {i.subFloor ? 'Below floor' : 'Above floor'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {flagged.length > 0 && (
            <div className="note">
              <p>
                <b>
                  {plural(flagged.length, 'index', 'indices')}{' '}
                  {flagged.length === 1 ? 'was' : 'were'} computed on a population below its floor.
                </b>{' '}
                The score is still shown here, marked as below the floor. What is ultimately
                reportable is decided when the national report is prepared, not here.
              </p>
            </div>
          )}

          <section className="stage">
            <div className="stagehead">
              <h2>Runs</h2>
              <span className="pill">{plural(runs.length, 'run')} kept</span>
            </div>
            <div className="stagebody">
              <p>
                Every run is kept. A run that was signed off and later superseded stays visible,
                with who signed it and when.
              </p>
              <div className="tablewrap">
                <table className="ftbl">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>When</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => {
                      const s = signoffs.find((x) => x.calculationRunId === r.id);
                      const label = !s
                        ? 'Run complete'
                        : s.state === 'signed_off'
                          ? 'Signed off'
                          : s.state === 'superseded'
                            ? 'Superseded'
                            : s.state === 'rejected'
                              ? 'Rejected'
                              : 'Awaiting sign-off';
                      return (
                        <tr key={r.id}>
                          <td>{r.id.slice(0, 8)}</td>
                          <td>{new Date(r.createdAt).toLocaleString()}</td>
                          <td>
                            <span
                              className={`tag ${
                                label === 'Signed off'
                                  ? 'ok'
                                  : label === 'Superseded'
                                    ? 'soft'
                                    : label === 'Rejected'
                                      ? 'risk'
                                      : 'wait'
                              }`}
                            >
                              {label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* ── No live sign-off: offer to request one ── */}
          {!liveSignoff && view !== 'request' && (
            <section className="stage now">
              <div className="stagehead">
                <h2>Sign off this scoring run</h2>
                <span className="pill started">Needs a second person</span>
              </div>
              <div className="stagebody">
                {lastRejected && (
                  <div className="warnbox" style={{ marginBottom: 12 }}>
                    <b>The last request was rejected.</b>
                    <p style={{ margin: '6px 0 0' }}>
                      By {operatorName(names, lastRejected.rejectedBy)} on{' '}
                      {lastRejected.rejectedAt
                        ? new Date(lastRejected.rejectedAt).toLocaleString()
                        : '—'}
                      : {lastRejected.rejectionReason}
                    </p>
                  </div>
                )}
                <p>
                  The signed run is the one the report uses. A later run can supersede it, but
                  nothing already released is recalled.
                </p>
                <div className="actions">
                  <button type="button" className="btn" onClick={() => setView('request')}>
                    Request approval
                  </button>
                </div>
              </div>
            </section>
          )}

          {view === 'request' && !liveSignoff && (
            <section className="stage now">
              <div className="stagehead">
                <h2>What you checked</h2>
              </div>
              <div className="stagebody">
                <p className="muted" style={{ marginTop: 0 }}>
                  Kept with the run permanently. The person approving reads this. Tick what you
                  actually checked.
                </p>
                {CHECKLIST.map((c) => (
                  <label key={c.key} style={{ display: 'block', margin: '6px 0' }}>
                    <input
                      type="checkbox"
                      checked={!!checked[c.key]}
                      onChange={(e) =>
                        setChecked((prev) => ({ ...prev, [c.key]: e.target.checked }))
                      }
                    />{' '}
                    {c.label}
                  </label>
                ))}
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={!allChecked || busy}
                    onClick={() =>
                      doRun(() =>
                        client.requestSignoff(editionId, currentRun.id, {
                          populationCountsReviewed: true,
                          floorStatusReviewed: true,
                          dataQualityFlagsReviewed: true,
                        }),
                      )
                    }
                  >
                    Request approval
                  </button>
                  <button type="button" className="btn-2" onClick={() => setView('main')}>
                    Cancel
                  </button>
                </div>
                <p className="muted">
                  This does not happen when you request it. A second person has to approve it, and
                  it cannot be you.
                </p>
              </div>
            </section>
          )}

          {isOwnRequest && (
            <section className="stage now">
              <div className="stagehead">
                <h2>Your own request</h2>
                <span className="pill wait">Awaiting a second person</span>
              </div>
              <div className="stagebody">
                <p>
                  You requested this sign-off, on{' '}
                  {new Date(liveSignoff!.requestedAt).toLocaleString()}. Someone else has to approve
                  it.
                </p>
              </div>
            </section>
          )}

          {isReviewable && view !== 'review' && (
            <section className="stage now">
              <div className="stagehead">
                <h2>Someone has asked for this</h2>
                <span className="pill started">Review</span>
              </div>
              <div className="stagebody">
                <p>
                  Requested by {operatorName(names, liveSignoff!.requestedBy)} on{' '}
                  {new Date(liveSignoff!.requestedAt).toLocaleString()}.
                </p>
                <div className="note">
                  <h3>What they checked</h3>
                  <ul>
                    {CHECKLIST.map((c) => (
                      <li key={c.key}>{c.label}</li>
                    ))}
                  </ul>
                </div>
                {!rejecting ? (
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => doRun(() => client.approveSignoff(liveSignoff!.id))}
                    >
                      Approve and sign off
                    </button>
                    <button
                      type="button"
                      className="btn-2"
                      disabled={busy}
                      onClick={() => setRejecting(true)}
                    >
                      Reject
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="field">
                      <label htmlFor="rejectReason">Why</label>
                      <p className="hint">
                        Kept with the run permanently. Required, so the person who asked knows what
                        to change.
                      </p>
                      <input
                        id="rejectReason"
                        type="text"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                      />
                    </div>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy || !rejectReason.trim()}
                        onClick={() =>
                          doRun(() => client.rejectSignoff(liveSignoff!.id, rejectReason.trim()))
                        }
                      >
                        Confirm rejection
                      </button>
                      <button
                        type="button"
                        className="btn-2"
                        disabled={busy}
                        onClick={() => {
                          setRejecting(false);
                          setRejectReason('');
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <p className="muted">
                  Whoever asks for a sign-off cannot also approve or reject it.
                </p>
              </div>
            </section>
          )}

          {liveSignoff?.state === 'signed_off' && (
            <section className="stage now">
              <div className="stagehead">
                <h2>Signed off</h2>
                <span className="pill ok">Authoritative</span>
              </div>
              <div className="stagebody">
                <p>
                  This run is the one every national and firm report is generated from, approved by{' '}
                  {operatorName(names, liveSignoff.approvedBy)} on{' '}
                  {liveSignoff.approvedAt ? new Date(liveSignoff.approvedAt).toLocaleString() : '—'}
                  .
                </p>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
