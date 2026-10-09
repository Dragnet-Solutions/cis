import { useEffect, useState } from 'react';
import { journeyApi, type ConsentContent, type ParticipatingFirm } from './journeyClient';
import { ApiError } from '../api/types';

type Channel = 'email' | 'text' | 'both' | 'none';

/**
 * UX-RET-001 retail entry: consent + contact + recovery choice on one surface,
 * following the PAT-011 pattern — notice → "How your information is handled"
 * expansion → consent checkbox → contact field. Consent GATES the primary
 * action and is required even when no contact detail is given (answers are
 * personal data regardless). The consent wording is governed content fetched
 * from the API, never hardcoded here.
 *
 * The firm picker is fed by the real edition-scoped active participating firms.
 * The respondent's answers are then driven by the one shared journey shell.
 */
export function RetailEntry({
  editionId,
  instrumentCode,
  recruitingFirmId,
  onStarted,
}: {
  editionId: string;
  instrumentCode: string;
  recruitingFirmId: string | null;
  onStarted: (respondentId: string, firms: ParticipatingFirm[]) => void;
}): JSX.Element {
  const [consent, setConsent] = useState<ConsentContent | null>(null);
  // null until the list has loaded — an empty list means there really are none.
  const [firms, setFirms] = useState<ParticipatingFirm[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [channel, setChannel] = useState<Channel>('none');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // Institutional investors (S5a/S5b) are counted by distinct institution, so
  // the institution's name is needed — for grouping only, never published.
  const isInstitutional = instrumentCode === 'S5a' || instrumentCode === 'S5b';
  const [institutionName, setInstitutionName] = useState('');
  // Arriving through a firm's own link pre-selects that firm (still removable).
  const [picked, setPicked] = useState<string[]>(recruitingFirmId ? [recruitingFirmId] : []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const failed = (err: unknown): void => {
      if (cancelled) return;
      setLoadFailed(true);
      setError(err instanceof ApiError ? err.message : 'Could not load the page');
    };
    // Loaded independently, so neither waits on the other.
    journeyApi.consentContent().then((cc) => {
      if (!cancelled) setConsent(cc.consent);
    }, failed);
    journeyApi.participatingFirms(editionId).then((fs) => {
      if (cancelled) return;
      setFirms(fs);
      // Drop a pre-selection that is not a participating firm this edition.
      setPicked((prev) => prev.filter((id) => fs.some((f) => f.id === id)));
    }, failed);
    return () => {
      cancelled = true;
    };
  }, [editionId]);

  function togglePick(id: string): void {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function begin(): Promise<void> {
    setError(null);
    if (!accepted) {
      setError('Please read and accept how your information is handled to continue.');
      return;
    }
    if (isInstitutional && !institutionName.trim()) {
      setError('Please enter your institution’s name.');
      return;
    }
    if (picked.length === 0) {
      setError('Choose at least one firm to tell us about.');
      return;
    }
    setBusy(true);
    try {
      const { respondentId } = await journeyApi.start({
        editionId,
        instrumentCode,
        recruitingFirmId,
        institutionName: isInstitutional ? institutionName.trim() : null,
      });
      await journeyApi.contact(respondentId, {
        consentAccepted: accepted,
        channel,
        email: channel === 'email' || channel === 'both' ? email : null,
        phone: channel === 'text' || channel === 'both' ? phone : null,
      });
      await journeyApi.ratedFirms(respondentId, picked);
      onStarted(respondentId, firms ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the survey');
      setBusy(false);
    }
  }

  return (
    <div className="journey">
      <p className="eyebrow">Your say on the brokers you use</p>
      <h1 tabIndex={-1}>Before you begin</h1>

      {/* PAT-011: notice first */}
      {consent ? (
        <>
          <p className="lede">{consent.notice}</p>
          <button
            type="button"
            className="textlink"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {consent.expansionTitle}
          </button>
          {expanded && <p className="consent-expansion">{consent.expansion}</p>}

          {/* then the consent checkbox — this gates the primary action */}
          <label className="ctl-choice consent-check">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>{consent.checkboxLabel}</span>
          </label>

          {/* then the (optional) contact field */}
          <fieldset className="contact-fields">
            <legend>How should we reach you? (optional)</legend>
            <div className="actions">
              {(['none', 'email', 'text', 'both'] as Channel[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  className={c === channel ? 'btn' : 'btn-2'}
                  onClick={() => setChannel(c)}
                >
                  {c === 'none' ? 'No contact' : c === 'both' ? 'Email + text' : c}
                </button>
              ))}
            </div>
            {(channel === 'email' || channel === 'both') && (
              <div className="field">
                <label htmlFor="retail-entry-email">Email</label>
                <input
                  id="retail-entry-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                />
              </div>
            )}
            {(channel === 'text' || channel === 'both') && (
              <div className="field">
                <label htmlFor="retail-entry-phone">Mobile number</label>
                <input
                  id="retail-entry-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  type="tel"
                />
              </div>
            )}
            <p className="lede" style={{ fontSize: 13 }}>
              With no contact detail you can still finish on this device — we’ll keep your place
              here.
            </p>
          </fieldset>
        </>
      ) : (
        <p className="lede">Loading…</p>
      )}

      {isInstitutional && (
        <div className="field">
          <label htmlFor="retail-entry-institution">Your institution’s name</label>
          <input
            id="retail-entry-institution"
            value={institutionName}
            onChange={(e) => setInstitutionName(e.target.value)}
          />
          <p className="hint">
            Used only to group responses from the same institution — it is never published, and your
            answers are not linked to any colleague’s.
          </p>
        </div>
      )}

      {/* firm picker from real active participating firms */}
      <fieldset className="firm-picker">
        <legend>Which firms would you like to tell us about?</legend>
        {firms === null ? (
          <p className="lede">
            {loadFailed ? 'The list of firms could not be loaded.' : 'Loading…'}
          </p>
        ) : firms.length === 0 ? (
          <p className="lede">No participating firms are available for this edition yet.</p>
        ) : (
          firms.map((f) => (
            <label key={f.id} className={`ctl-choice${picked.includes(f.id) ? ' on' : ''}`}>
              <input
                type="checkbox"
                checked={picked.includes(f.id)}
                onChange={() => togglePick(f.id)}
              />
              <span>{f.displayName}</span>
            </label>
          ))
        )}
      </fieldset>

      {error && <div className="err">{error}</div>}

      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={() => void begin()}
          disabled={!accepted || busy}
        >
          {busy ? 'Starting…' : 'Start the survey'}
        </button>
      </div>
    </div>
  );
}
