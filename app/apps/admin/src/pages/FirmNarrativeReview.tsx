import { useCallback, useEffect, useState } from 'react';
import type { AdminClient } from '../api/client';
import { ApiError, type FirmNarrativeReviewView } from '../api/types';

/**
 * The firm report's fact-check decisions (BUG-20 / BUG-03) — the step the
 * national report already has. Each sentence of the written analysis the
 * checker held back is a finding: agree it stays out, or disagree with a
 * reason, which puts it back. Every finding is decided before the report can
 * be released.
 */
export function FirmNarrativeReview({
  client,
  editionId,
  firmId,
}: {
  client: AdminClient;
  editionId: string;
  firmId: string;
}): JSX.Element | null {
  const [review, setReview] = useState<FirmNarrativeReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      // Drafted first if it is due, so the findings shown are the current draft's.
      await client.ensureFirmNarrative(editionId, firmId).catch(() => undefined);
      setReview((await client.getFirmNarrativeReview(editionId, firmId)).review);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the fact-check');
    }
  }, [client, editionId, firmId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (
    narrativeIndex: number,
    disposition: 'SUPPRESS_CLAIM' | 'REJECT_WITH_REASON',
  ) => {
    if (!review?.narrativeId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await client.decideFirmNarrativeFinding(editionId, firmId, {
        narrativeId: review.narrativeId,
        narrativeIndex,
        disposition,
        ...(disposition === 'REJECT_WITH_REASON' ? { reason: reason.trim() } : {}),
      });
      setReview(res.review);
      setRejecting(null);
      setReason('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The decision was not recorded');
    } finally {
      setBusy(false);
    }
  };

  if (!review) return error ? <div className="err">{error}</div> : null;
  if (!review.narrativeId) return null;

  return (
    <section className={`stage ${review.undecided > 0 ? 'now' : ''}`} style={{ margin: '16px' }}>
      <div className="stagehead">
        <h2>Fact-check of the written analysis</h2>
        <span className={`pill ${review.undecided > 0 ? 'wait' : 'ok'}`}>
          {review.findings.length === 0
            ? 'Nothing held back'
            : review.undecided > 0
              ? `${review.undecided} to decide`
              : 'All decided'}
        </span>
      </div>
      <div className="stagebody">
        {error && <div className="err">{error}</div>}
        <p className="muted">
          Every sentence was checked against the figures it cites.{' '}
          {review.findings.length === 0
            ? 'None was held back.'
            : `${review.findings.length} held back by the checker${review.undecided > 0 ? ' — each needs a decision before this report can be released.' : '.'}`}
        </p>
        {review.findings.map((f) => (
          <div key={f.narrativeIndex} className="warnbox" style={{ margin: '0 0 8px' }}>
            <p style={{ margin: 0 }}>{f.text}</p>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              <b>Held back — {f.finding.kind.toLowerCase()}.</b> {f.finding.why}
            </p>
            {f.decision ? (
              <p style={{ margin: '6px 0 0' }}>
                {f.decision.disposition === 'REJECT_WITH_REASON'
                  ? `Put back in by ${f.decision.decidedBy}: “${f.decision.reason}”`
                  : `Left out — agreed by ${f.decision.decidedBy}.`}
              </p>
            ) : review.released ? null : rejecting === f.narrativeIndex ? (
              <div style={{ marginTop: 8 }}>
                <div className="field">
                  <label htmlFor={`fwhy-${f.narrativeIndex}`}>Why the checker is wrong here</label>
                  <textarea
                    id={`fwhy-${f.narrativeIndex}`}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy || reason.trim().length < 10}
                    onClick={() => void decide(f.narrativeIndex, 'REJECT_WITH_REASON')}
                  >
                    Put it back in
                  </button>
                  <button type="button" className="btn-2 small" onClick={() => setRejecting(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="actions" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn-2 small"
                  disabled={busy}
                  onClick={() => void decide(f.narrativeIndex, 'SUPPRESS_CLAIM')}
                >
                  Agree — leave it out
                </button>
                <button
                  type="button"
                  className="btn-2 small"
                  disabled={busy}
                  onClick={() => {
                    setRejecting(f.narrativeIndex);
                    setReason('');
                  }}
                >
                  Disagree…
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
