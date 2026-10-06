import { useState } from 'react';
import { journeyApi } from './journeyClient';
import { ApiError } from '../api/types';

/**
 * Post-submission screen. UX-RET-008: the report-delivery preference can be
 * changed here WITHOUT touching the (now immutable) responses. The referral CTA
 * starts a completely independent journey that never inherits this respondent's
 * recruiting/source firm, and never discloses whether an invitee took part.
 */
/** The privacy reassurance matching who answered — each mirrors the promise
 *  made on that respondent's own entry screen. A firm's staff member or an
 *  institution did not "rate" firms, so the investor wording does not fit them. */
function privacyLine(instrumentCode: string): string {
  if (instrumentCode === 'firm-seat' || /^S[123]$/.test(instrumentCode)) {
    return 'Nobody at your firm, including your coordinator, can see your answers — only that it is complete.';
  }
  if (instrumentCode.startsWith('I-')) {
    return 'Your institution’s name is never published, and your answers are not linked to any colleague’s.';
  }
  return 'They are never shown to the firms you rated.';
}

export function Completion({
  respondentId,
  editionId,
  instrumentCode,
  canRefer,
  onReferralStarted,
}: {
  respondentId: string;
  editionId: string;
  instrumentCode: string;
  canRefer: boolean;
  onReferralStarted: (newRespondentId: string) => void;
}): JSX.Element {
  const [delivery, setDelivery] = useState('email');
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [referBusy, setReferBusy] = useState(false);

  async function saveDelivery(): Promise<void> {
    setError(null);
    setSavedMsg(null);
    try {
      await journeyApi.reportDelivery(respondentId, { reportDelivery: delivery });
      setSavedMsg('Your report-delivery preference has been updated.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update your preference');
    }
  }

  async function refer(): Promise<void> {
    setReferBusy(true);
    setError(null);
    try {
      const { respondentId: next } = await journeyApi.referral(respondentId, {
        editionId,
        instrumentCode,
      });
      onReferralStarted(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a referral');
      setReferBusy(false);
    }
  }

  return (
    <div className="journey">
      <p className="eyebrow">All done</p>
      <h1 tabIndex={-1}>Thank you — your responses are in</h1>
      <p className="lede">
        Your answers are now final and cannot be changed. {privacyLine(instrumentCode)}
      </p>

      <fieldset className="contact-fields">
        <legend>How would you like the final report?</legend>
        <div className="actions">
          {['email', 'text', 'none'].map((d) => (
            <button
              key={d}
              type="button"
              className={d === delivery ? 'btn' : 'btn-2'}
              onClick={() => setDelivery(d)}
            >
              {d === 'none' ? 'No report' : d}
            </button>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="btn-2" onClick={() => void saveDelivery()}>
            Update preference
          </button>
        </div>
        {savedMsg && <p className="qstate ok">{savedMsg}</p>}
      </fieldset>

      {canRefer && (
        <div className="refer-block">
          <h2>Know someone else who invests?</h2>
          <p className="lede">
            You can invite them to take part. Their survey is entirely their own — we never tell you
            whether they took part.
          </p>
          <button type="button" className="btn" onClick={() => void refer()} disabled={referBusy}>
            {referBusy ? 'Starting…' : 'Refer someone'}
          </button>
        </div>
      )}

      {error && <div className="err">{error}</div>}
    </div>
  );
}
