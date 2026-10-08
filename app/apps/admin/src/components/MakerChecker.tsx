import { useState } from 'react';
import type { AuthUser, PendingAction } from '../api/types';

const MIN_REASON = 4;

/**
 * Maker step: request a critical action. The submit control stays disabled
 * until a reason of at least four characters is given — mirrored server-side.
 */
export function CriticalActionRequest({
  eyebrow,
  title,
  doesText,
  undoText,
  onSubmit,
  onCancel,
  busy,
}: {
  eyebrow: string;
  title: string;
  doesText: string;
  undoText: string;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
  busy: boolean;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_REASON;
  const valid = trimmed.length >= MIN_REASON;

  return (
    <div>
      <button type="button" className="back" onClick={onCancel}>
        ← Cancel
      </button>
      <p className="eyebrow">{eyebrow}</p>
      <h1 tabIndex={-1}>{title}</h1>

      <div className="warnbox">
        <b>{doesText}</b>
        <p style={{ margin: '6px 0 0' }}>{undoText}</p>
      </div>

      <p className="lede">
        This does not happen when you request it. A second person has to approve it, and it cannot
        be you.
      </p>

      <div className="field">
        <label htmlFor="reqReason">Why now</label>
        <p className="hint">Kept with the edition permanently. The person approving reads this.</p>
        <input
          id="reqReason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {tooShort && <div className="err">Say why. The person approving needs a reason to read.</div>}

      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={!valid || busy}
          onClick={() => onSubmit(trimmed)}
        >
          Request approval
        </button>
        <button type="button" className="btn-2" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Checker step: review a pending request. When the request is the viewer's own,
 * the decision controls are ABSENT (not disabled) — there is nothing the viewer
 * could do to make them available, and a disabled control only invites the
 * attempt.
 */
export function CriticalActionReview({
  eyebrow,
  title,
  doesText,
  undoText,
  pending,
  viewer,
  onDecide,
  onBack,
  busy,
}: {
  eyebrow: string;
  title: string;
  doesText: string;
  undoText: string;
  pending: PendingAction;
  viewer: AuthUser;
  onDecide: (approved: boolean) => void;
  onBack: () => void;
  busy: boolean;
}): JSX.Element {
  const isOwnRequest = viewer.id === pending.requestedBy.id;
  const requestedByOrg = pending.requestedBy.org ? ` · ${pending.requestedBy.org}` : '';
  const viewerOrg = viewer.org ? ` · ${viewer.org}` : '';

  return (
    <div>
      <button type="button" className="back" onClick={onBack}>
        ← Back
      </button>
      <p className="eyebrow">{eyebrow}</p>
      <h1 tabIndex={-1}>{title}</h1>

      <div className="warnbox">
        <b>{doesText}</b>
        <p style={{ margin: '6px 0 0' }}>{undoText}</p>
      </div>

      <dl className="kv">
        <dt>Requested by</dt>
        <dd>
          {pending.requestedBy.displayName}
          {requestedByOrg}
        </dd>
        <dt>When</dt>
        <dd>{new Date(pending.requestedAt).toLocaleString()}</dd>
        <dt>Reason given</dt>
        <dd>{pending.reason}</dd>
        <dt>You are</dt>
        <dd>
          {viewer.displayName}
          {viewerOrg}
        </dd>
      </dl>

      {isOwnRequest ? (
        <div className="err" style={{ marginTop: 14 }}>
          This is your own request. Someone else has to approve it.
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={() => onDecide(true)}>
            Approve and carry it out
          </button>
          <button type="button" className="btn-2" disabled={busy} onClick={() => onDecide(false)}>
            Reject
          </button>
        </div>
      )}

      <p className="owner">
        A maker can never approve their own request. When the request is your own the decision is
        not offered — the control is absent, not disabled. The approver may be from either
        organisation; the only constraint is that it is a different person.
      </p>
    </div>
  );
}
