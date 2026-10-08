import { useEffect, useState } from 'react';
import { journeyApi } from './journeyClient';
import { ApiError } from '../api/types';
import { ErrorState, type ErrorStateKind } from '../shared/ErrorState';

type Loaded = {
  editionId: string;
  organizationId: string;
  seatCode: 'S1' | 'S2' | 'S3';
  roleLabel: string;
  state: 'empty' | 'invited' | 'started' | 'complete';
  editionStatus: 'draft' | 'open' | 'locked' | 'archived';
};

/**
 * The real entry point for an assigned S1/S2/S3 firm survey seat (UX-FRM-007
 * / Task D, Part 6). A firm seat is not a special case at the journey layer
 * — the same `startJourney` every other entry point uses — so this mirrors
 * InstitutionalEntry.tsx's shape (a single named context, no consent gate:
 * `requiresConsent` covers only S5a/S5b, not S1/S2/S3) rather than
 * RetailEntry's. Unlike an institutional entry, the seat link itself is a
 * credential for exactly one seat, so a seat holder who closed the browser
 * mid-survey picks up where they stopped from this same link.
 *
 * The link itself is the credential (a fresh, unguessable token minted on
 * every seat assignment and retired on every reassignment) — the same trust
 * model as every other entry point, not an account.
 */
export function FirmSeatEntry({
  linkToken,
  onStarted,
}: {
  linkToken: string;
  onStarted: (respondentId: string) => void;
}): JSX.Element {
  const [context, setContext] = useState<Loaded | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorStateKind | null>(null);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ctx = await journeyApi.firmSeatContext(linkToken);
        if (cancelled) return;
        if (ctx.editionStatus !== 'open' && ctx.state !== 'complete') {
          setErrorKind('participation_closed');
        } else if (ctx.state === 'empty') {
          // A link only ever gets handed out once the seat is assigned
          // ('invited' onward) — an empty seat's token was never meaningful,
          // or the seat has since been cleared. Same treatment as a token
          // that resolves to nothing at all.
          setErrorKind('expired_link');
        } else if (ctx.state === 'complete') {
          setAlreadySubmitted(true);
        } else {
          setContext(ctx);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.statusCode === 404) {
          setErrorKind('expired_link');
        } else {
          setErrorKind('service_unavailable');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [linkToken]);

  async function begin(): Promise<void> {
    setStartError(null);
    setBusy(true);
    try {
      const { respondentId } = await journeyApi.firmSeatStart(linkToken);
      onStarted(respondentId);
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : 'Could not start the survey');
      setBusy(false);
    }
  }

  if (errorKind) {
    return <ErrorState kind={errorKind} />;
  }

  if (alreadySubmitted) {
    return (
      <div className="card">
        <h2>You have already finished this one.</h2>
        <p>Your response is in — nothing further is needed.</p>
      </div>
    );
  }

  if (!context) {
    return (
      <div className="journey">
        <p className="lede">Loading…</p>
      </div>
    );
  }

  return (
    <div className="journey">
      <p className="eyebrow">Your firm survey</p>
      <h1 tabIndex={-1}>{context.roleLabel}</h1>
      <p className="lede">
        Your coordinator assigned this survey to you. Nobody at your firm, including your
        coordinator, can see your answers — only that it is complete.
      </p>
      {startError && <div className="err">{startError}</div>}
      <div className="actions">
        <button type="button" className="btn" onClick={() => void begin()} disabled={busy}>
          {busy
            ? 'Starting…'
            : context.state === 'started'
              ? 'Continue the survey'
              : 'Start the survey'}
        </button>
      </div>
    </div>
  );
}
