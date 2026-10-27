import { useCallback, useEffect, useState } from 'react';
import type { AdminClient } from '../api/client';
import { ApiError, type MethodologyApprovalView } from '../api/types';

/**
 * "Record the methodology approval" — the Runbook §5.2 step, for this edition.
 * CIS approves the scoring methodology offline (BUG-02), so scoring does not
 * wait on this: it records, for the edition, that the approval was given. Two
 * people: one asks with a reason, a different one confirms. The record keeps
 * who, when, why and which version.
 */
export function MethodologyApproval({
  client,
  editionId,
  onChange,
}: {
  client: AdminClient;
  editionId: string;
  onChange?: () => void;
}): JSX.Element | null {
  const [state, setState] = useState<MethodologyApprovalView | null>(null);
  const [reason, setReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await client.getScoringMethodology(editionId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the methodology');
    }
  }, [client, editionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      setReason('');
      setRejecting(false);
      setRejectReason('');
      onChange?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  if (!state) return error ? <div className="err">{error}</div> : null;
  const m = `${state.methodology.id} v${state.methodology.version}`;
  const name = (id: string) => state.operatorNames[id] ?? 'another operator';
  const ownPending = state.pending?.requestedBy === state.viewerId;

  return (
    <section className="stage">
      <div className="stagehead">
        <h2>Methodology approval for this edition</h2>
        <span className={`pill ${state.approved ? 'ok' : state.pending ? 'wait' : 'started'}`}>
          {state.approved
            ? 'Recorded'
            : state.pending
              ? 'Awaiting a second person'
              : 'Not recorded'}
        </span>
      </div>
      <div className="stagebody">
        {error && <div className="err">{error}</div>}
        {state.approved ? (
          <p>
            <b>{m}</b> was approved by {name(state.approved.approvedBy)} on{' '}
            {new Date(state.approved.approvedAt).toLocaleString()}, at the request of{' '}
            {name(state.approved.requestedBy)} (“{state.approved.reason}”), for this edition.
          </p>
        ) : state.pending ? (
          <>
            <p>
              {ownPending ? 'You' : name(state.pending.requestedBy)} asked on{' '}
              {new Date(state.pending.requestedAt).toLocaleString()} for <b>{m}</b> to be approved:
              “{state.pending.reason}”.
            </p>
            {ownPending ? (
              <p className="muted">This is your own request. Someone else has to approve it.</p>
            ) : rejecting ? (
              <>
                <div className="field">
                  <label htmlFor="mRejectReason">Why it is not approved</label>
                  <input
                    id="mRejectReason"
                    type="text"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn-2"
                    disabled={busy || rejectReason.trim().length < 4}
                    onClick={() =>
                      run(() =>
                        client.decideMethodologyApproval(
                          state.pending!.actionId,
                          false,
                          rejectReason.trim(),
                        ),
                      )
                    }
                  >
                    Reject the request
                  </button>
                  <button type="button" className="btn-2" onClick={() => setRejecting(false)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    run(() => client.decideMethodologyApproval(state.pending!.actionId, true))
                  }
                >
                  Approve {m}
                </button>
                <button type="button" className="btn-2" onClick={() => setRejecting(true)}>
                  Reject…
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <p>
              Index scores are computed with <b>{m}</b>. CIS approves the methodology outside the
              platform, so scoring does not wait on this; record here, for this edition, that it was
              approved. Two people: you ask, with a reason, and someone else confirms.
            </p>
            <div className="field">
              <label htmlFor="mReason">Who approved it, and when</label>
              <p className="hint">
                For example, who externally approved the method and when. Kept permanently.
              </p>
              <input
                id="mReason"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={busy || reason.trim().length < 4}
                onClick={() =>
                  run(() => client.requestMethodologyApproval(editionId, reason.trim()))
                }
              >
                Record the approval
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
