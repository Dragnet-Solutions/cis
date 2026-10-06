import { useEffect, useMemo, useState } from 'react';
import {
  PROGRESS_PIP_COUNT,
  pipsOnFor,
  replacementCost,
  SEAT_STATE_LABEL,
  SEGMENTS,
  SEGMENT_ORDER,
  type PortalView,
  type SeatState,
  type Segment,
} from './portalModel';
import {
  portalAuth,
  firmPublic,
  portalClient,
  type SeatAssignment,
  type SeatCode,
  type Coordinator,
  type PortalMe,
  type OutreachLink,
  type FirmDirectoryEntry,
  type FirmResults,
} from './portalClient';
import { FirmReport } from '../reports/FirmReport';
import { portalFirmSource } from '../reports/source';
import { usePortalSession, type PortalSession } from './usePortalSession';
import { ApiError } from '../api/types';
import { ErrorState, type ErrorStateKind } from '../shared/ErrorState';

/**
 * Firm claim / portal / team / seats / outreach / results — UX-FRM-001 and
 * UX-FRM-007, rebuilt against the real backend (Task D). Copy carried over
 * verbatim from the earlier, already-approved-sounding prototype wherever it
 * doesn't conflict with a real capability; no artefact source file exists
 * anywhere in this repository to verify against directly (grepped
 * exhaustively — only this README-style label exists, never a document), so
 * this is the best-available faithful port, not an independently verified one.
 *
 * The claim flow has no manually-typed invitation code, because the real
 * backend has no such gate: `claimSpace` takes no code, and a second
 * claimant is simply redirected to sign in
 * (`AlreadyClaimedError`: "This firm already has a space. Sign in instead.").
 * The email-first branch (sign in vs. not recognised) is real too, backed by
 * `/portal/auth/lookup` — the firm itself is still never disclosed before a
 * PIN is accepted.
 */

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

const ROLE_TO_SEAT: Record<string, SeatCode> = {
  'Managing Director or CEO': 'S1',
  Compliance: 'S2',
  Operations: 'S3',
};

export function FirmPortal(): JSX.Element {
  const { session, signIn, signOut } = usePortalSession();
  const [claimOrgId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('claim'),
  );

  if (!session) {
    return <ClaimOrSignIn claimOrgId={claimOrgId} onSignedIn={signIn} />;
  }
  return <Portal session={session} onSignOut={signOut} />;
}

// ─── Unauthenticated: claim or sign in ─────────────────────────────────────

function ClaimOrSignIn({
  claimOrgId,
  onSignedIn,
}: {
  claimOrgId: string | null;
  onSignedIn: (session: PortalSession) => void;
}): JSX.Element {
  const [view, setView] = useState<PortalView>(claimOrgId ? 'claim' : 'email');
  const [email, setEmail] = useState('');
  const [firmName, setFirmName] = useState('');
  const [firms, setFirms] = useState<FirmDirectoryEntry[]>([]);
  const [alreadyClaimedNote, setAlreadyClaimedNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<ErrorStateKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await firmPublic.directory();
        if (cancelled) return;
        setFirms(list);
        if (claimOrgId) {
          const match = list.find((f) => f.id === claimOrgId);
          setFirmName(match?.displayName ?? '');
        }
      } catch {
        if (!cancelled) setLoadError('service_unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [claimOrgId]);

  const go = (v: PortalView) => {
    setView(v);
    window.scrollTo(0, 0);
  };

  if (loadError) return <ErrorState kind={loadError} />;

  return (
    <div className="shell firmportal">
      <header className="top">
        <div className="lockup">
          CIS × Dragnet Benchmark
          <small>Stockbroking firm portal</small>
        </div>
        <div className="steps" aria-hidden="true">
          {Array.from({ length: PROGRESS_PIP_COUNT }, (_, i) => (
            <span key={i} className={`pip${i < pipsOnFor(view) ? ' on' : ''}`} />
          ))}
        </div>
      </header>

      <main>
        {view === 'email' && (
          <EmailView
            initialNote={alreadyClaimedNote}
            onNext={(v, a) => {
              setEmail(a);
              setAlreadyClaimedNote(null);
              go(v);
            }}
          />
        )}
        {view === 'pin' && (
          <PinView email={email} onSignedIn={onSignedIn} onBack={() => go('email')} />
        )}
        {view === 'unclaimed' && (
          <UnknownView onRequest={() => go('nocode')} onBack={() => go('email')} />
        )}
        {view === 'claim' && (
          <SetupView
            firm={firmName}
            organizationId={claimOrgId}
            firms={firms}
            onClaimed={onSignedIn}
            onAlreadyClaimed={(message) => {
              setAlreadyClaimedNote(message);
              go('email');
            }}
          />
        )}
        {view === 'nocode' && (
          <RequestView
            firms={firms.map((f) => f.displayName)}
            onSent={() => go('requested')}
            onBack={() => go('email')}
          />
        )}
        {view === 'requested' && <RequestedView />}
      </main>
    </div>
  );
}

function EmailView({
  initialNote,
  onNext,
}: {
  initialNote: string | null;
  onNext: (v: PortalView, addr: string) => void;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    const a = email.trim().toLowerCase();
    if (!emailOk(a)) {
      setErr('Enter your email address.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const { branch } = await portalAuth.lookup(a);
      onNext(branch === 'signin' ? 'pin' : 'unclaimed', a);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not check that address');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="eyebrow">Stockbroking firm portal</p>
      <h1 tabIndex={-1}>Your firm’s space.</h1>
      <p className="lede">Start with your email address.</p>
      {initialNote && (
        <div className="note" role="status">
          <p>{initialNote}</p>
        </div>
      )}
      <div className="field">
        <label htmlFor="cEmail">Email address</label>
        <input
          id="cEmail"
          type="email"
          value={email}
          placeholder="name@yourfirm.com"
          onChange={(e) => {
            setEmail(e.target.value);
            setErr('');
          }}
        />
        {err && <div className="err">{err}</div>}
      </div>
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </div>
    </>
  );
}

function PinView({
  email,
  onSignedIn,
  onBack,
}: {
  email: string;
  onSignedIn: (session: PortalSession) => void;
  onBack: () => void;
}): JSX.Element {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn(): Promise<void> {
    setBusy(true);
    setErr('');
    try {
      const { token, coordinator } = await portalAuth.login(email, pin);
      onSignedIn({ token, coordinator });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not sign in');
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="textlink" onClick={onBack}>
        ← Use a different address
      </button>
      <p className="eyebrow">Sign in</p>
      <h1 tabIndex={-1}>Enter your PIN.</h1>
      {/* The firm is never named until the PIN is accepted. */}
      <p className="lede">For {email}.</p>
      <div className="field">
        <label htmlFor="siPin">PIN</label>
        <input
          id="siPin"
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
        />
        {err && <div className="err">{err}</div>}
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={pin.length < 4 || busy}
          onClick={() => void signIn()}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </>
  );
}

function UnknownView({
  onRequest,
  onBack,
}: {
  onRequest: () => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <>
      <button type="button" className="textlink" onClick={onBack}>
        ← Try another address
      </button>
      <p className="eyebrow">Not recognised</p>
      <h1 tabIndex={-1}>We have nothing for that address.</h1>
      <div className="note">
        <p>
          Invitation codes go to one named person per firm, so it may have gone to a colleague
          rather than you.
        </p>
        <p>If nobody at your firm has it, or the person it went to has left, ask for one.</p>
        <div className="actions">
          <button type="button" className="btn" onClick={onRequest}>
            Ask for an invitation code
          </button>
          <button type="button" className="btn-2" onClick={onBack}>
            Try another address
          </button>
        </div>
      </div>
    </>
  );
}

function SetupView({
  firm,
  organizationId,
  firms,
  onClaimed,
  onAlreadyClaimed,
}: {
  firm: string;
  organizationId: string | null;
  firms: FirmDirectoryEntry[];
  onClaimed: (session: PortalSession) => void;
  onAlreadyClaimed: (message: string) => void;
}): JSX.Element {
  const [chosenOrgId, setChosenOrgId] = useState<string | null>(organizationId);
  const [firmQuery, setFirmQuery] = useState(firm);
  const [privacy, setPrivacy] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [role, setRole] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [showPriv, setShowPriv] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const firmMatches = useMemo(
    () =>
      firmQuery.trim()
        ? firms.filter((f) => f.displayName.toLowerCase().includes(firmQuery.trim().toLowerCase()))
        : firms,
    [firmQuery, firms],
  );

  const mobileDigits = mobile.replace(/[^0-9]/g, '');
  const gate = !chosenOrgId
    ? 'Choose your firm from the list that appears as you type.'
    : !privacy
      ? 'Confirm you have read how your information is handled.'
      : !name.trim()
        ? 'Enter your name.'
        : !emailOk(contactEmail)
          ? 'Enter your email address.'
          : !mobileDigits
            ? 'Enter a mobile number.'
            : mobileDigits.length < 10
              ? 'That number is too short to send a text to.'
              : !role
                ? 'Choose your role.'
                : pin.length !== 6
                  ? 'Your PIN needs six digits.'
                  : pin2.length !== 6
                    ? 'Enter your PIN again.'
                    : null;

  async function claim(): Promise<void> {
    if (!chosenOrgId) return;
    setBusy(true);
    setErr(null);
    try {
      await firmPublic.claim({
        organizationId: chosenOrgId,
        contactName: name.trim(),
        contactEmail: contactEmail.trim(),
        mobile: mobileDigits,
        pin,
        role,
        privacyConsent: privacy,
        followUpConsent: followUp,
      });
      const { token, coordinator } = await portalAuth.login(contactEmail.trim(), pin);
      const seatCode = ROLE_TO_SEAT[role];
      if (seatCode) {
        try {
          await portalClient.assignSeat(token, seatCode, {
            assignedName: name.trim(),
            assignedEmail: contactEmail.trim(),
            isSelf: true,
          });
        } catch {
          // Non-fatal: the coordinator can assign seats from the portal.
        }
      }
      onClaimed({ token, coordinator });
    } catch (e) {
      if (e instanceof ApiError && /already has a space/i.test(e.message)) {
        onAlreadyClaimed(e.message);
        return;
      }
      setErr(e instanceof ApiError ? e.message : 'Could not claim this space');
      setBusy(false);
    }
  }

  return (
    <>
      <p className="eyebrow">Step 2 of 2</p>
      <h1 tabIndex={-1}>Set up your access.</h1>
      <p className="lede">
        {chosenOrgId ? (
          <>
            You are claiming this space for <b>{firm}</b>. From now on you sign in with your email
            address and this PIN.
          </>
        ) : (
          'Choose your firm to begin.'
        )}
      </p>

      <div className="field">
        <label htmlFor="setupFirm">Your firm</label>
        <input
          id="setupFirm"
          type="text"
          value={firmQuery}
          placeholder="Type or choose a firm"
          onChange={(e) => {
            setFirmQuery(e.target.value);
            const match = firms.find(
              (f) => f.displayName.toLowerCase() === e.target.value.trim().toLowerCase(),
            );
            setChosenOrgId(match?.id ?? null);
          }}
        />
        {firmQuery.trim() && !chosenOrgId && (
          <div className="results">
            {firmMatches.length ? (
              firmMatches.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="result"
                  onClick={() => {
                    setChosenOrgId(f.id);
                    setFirmQuery(f.displayName);
                  }}
                >
                  {f.displayName}
                </button>
              ))
            ) : (
              <div className="noresult">Nothing matches that spelling.</div>
            )}
          </div>
        )}
      </div>

      <p className="privline">
        Used for nothing else, and kept separate from your firm’s survey answers.{' '}
        <button type="button" className="textlink" onClick={() => setShowPriv(true)}>
          How your information is handled
        </button>
      </p>

      <label className="consent">
        <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} />
        <span>I have read and accepted how my information is handled.</span>
      </label>

      <label className="consent optional">
        <input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} />
        <span>
          We are happy for CIS and Dragnet to follow up with us about aspects of this survey.
          <em>Optional. Your firm takes part either way.</em>
        </span>
      </label>

      <div className="field">
        <label htmlFor="fullname">Your name</label>
        <input id="fullname" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="setupEmail">Your email address</label>
        <input
          id="setupEmail"
          type="email"
          value={contactEmail}
          placeholder="name@yourfirm.com"
          onChange={(e) => setContactEmail(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="mobile">Your mobile number</label>
        <p className="hint">
          Used to text you if something needs your attention and email has not reached you.
        </p>
        <input
          id="mobile"
          type="tel"
          value={mobile}
          placeholder="+234 800 000 0000"
          onChange={(e) => setMobile(e.target.value)}
        />
      </div>

      <h2>Your role at the firm</h2>
      <div className="choices" role="radiogroup" aria-label="Your role at the firm">
        {['Managing Director or CEO', 'Compliance', 'Operations', 'Survey coordinator'].map((r) => (
          <label key={r} className="choice">
            <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
            <span>
              <b>{r}</b>
            </span>
          </label>
        ))}
      </div>

      <div className="field">
        <label htmlFor="pin">Choose your PIN</label>
        <p className="hint">
          Six digits. You will use your email address and this PIN from now on.
        </p>
        <input
          id="pin"
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
        />
      </div>
      <div className="field">
        <label htmlFor="pin2">Enter it again</label>
        <input
          id="pin2"
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={pin2}
          onChange={(e) => setPin2(e.target.value.replace(/[^0-9]/g, ''))}
        />
        {pin2.length === 6 && pin !== pin2 && <div className="err">Those two do not match.</div>}
      </div>

      <div className="note">
        <p>
          You will be the firm’s lead coordinator. You can add others, and hand the lead over, from
          inside.
        </p>
      </div>

      {err && <div className="err">{err}</div>}
      {gate && <p className="gate">{gate}</p>}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={!!gate || pin !== pin2 || busy}
          onClick={() => void claim()}
        >
          {busy ? 'Opening…' : 'Open my firm’s space'}
        </button>
      </div>

      {showPriv && <PrivacyModal onClose={() => setShowPriv(false)} />}
    </>
  );
}

function RequestView({
  firms,
  onSent,
  onBack,
}: {
  firms: string[];
  onSent: () => void;
  onBack: () => void;
}): JSX.Element {
  const [firm, setFirm] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [privacy, setPrivacy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const matches = useMemo(
    () =>
      firm.trim()
        ? firms.filter((f) => f.toLowerCase().includes(firm.trim().toLowerCase()))
        : firms,
    [firm, firms],
  );

  const gate = !privacy
    ? 'Confirm you have read how your information is handled.'
    : !chosen
      ? firm.trim()
        ? 'Choose your firm from the list that appears as you type.'
        : 'Choose your firm from the register.'
      : !name.trim()
        ? 'Enter your full name.'
        : !role.trim()
          ? 'Enter your designation.'
          : !emailOk(email)
            ? 'Enter your work email address.'
            : !/^\+?[0-9][0-9\s()-]{7,}$/.test(phone.trim())
              ? 'Enter a phone number we can reach you on.'
              : null;

  async function send(): Promise<void> {
    if (!chosen) return;
    setBusy(true);
    setErr(null);
    try {
      await firmPublic.requestInvitation({
        firmName: chosen,
        name: name.trim(),
        designation: role.trim(),
        email: email.trim(),
        phone: phone.trim(),
        privacyConsent: privacy,
      });
      onSent();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not send that request');
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="textlink" onClick={onBack}>
        ← Back
      </button>
      <p className="eyebrow">Request access</p>
      <h1 tabIndex={-1}>Ask for an invitation.</h1>
      <p className="lede">
        Codes go to one named person per firm. If nobody at your firm has it, tell us who you are
        and the study team will sort it out with the Chartered Institute of Stockbrokers.
      </p>

      <div className="searchwrap">
        <div className="field">
          <label htmlFor="rFirm">Your firm</label>
          <input
            id="rFirm"
            type="text"
            value={firm}
            placeholder="Type or choose a firm"
            onChange={(e) => {
              setFirm(e.target.value);
              setChosen(
                firms.find((f) => f.toLowerCase() === e.target.value.trim().toLowerCase()) ?? null,
              );
            }}
          />
          {firm.trim() && !chosen && (
            <div className="results">
              {matches.length ? (
                matches.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="result"
                    onClick={() => {
                      setChosen(f);
                      setFirm(f);
                    }}
                  >
                    {f}
                  </button>
                ))
              ) : (
                <div className="noresult">Nothing matches that spelling.</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="field">
        <label htmlFor="rName">Your full name</label>
        <input id="rName" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="rRole">Your designation</label>
        <p className="hint">Your job title at the firm.</p>
        <input
          id="rRole"
          type="text"
          value={role}
          placeholder="For example, Head of Operations"
          onChange={(e) => setRole(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="rEmail">Your work email address</label>
        <p className="hint">
          Whatever address you use for work. It does not need to be a company domain.
        </p>
        <input
          id="rEmail"
          type="email"
          value={email}
          placeholder="name@yourfirm.com"
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="rPhone">A phone number we can reach you on</label>
        <input
          id="rPhone"
          type="tel"
          value={phone}
          placeholder="+234 800 000 0000"
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>

      <div className="note">
        <p>
          Someone will call you before anything is issued, and check with the Chartered Institute of
          Stockbrokers that you speak for the firm you have named.
        </p>
      </div>

      <label className="consent">
        <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} />
        <span>I have read and accepted how my information is handled.</span>
      </label>

      {err && <div className="err">{err}</div>}
      {gate && <p className="gate">{gate}</p>}
      <div className="actions">
        <button type="button" className="btn" disabled={!!gate || busy} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send my request'}
        </button>
      </div>
    </>
  );
}

function RequestedView(): JSX.Element {
  return (
    <>
      <div className="done">
        <span aria-hidden="true">✓</span> Request sent
      </div>
      <h1 tabIndex={-1}>We have your details.</h1>
      <div className="note">
        <p>
          The study team will check with the Chartered Institute of Stockbrokers and call you on the
          number you gave.
        </p>
        <div className="reassure">
          Nothing has been claimed and no access has been granted. Your firm’s space is untouched.
        </div>
      </div>
      <p className="owner">
        We can’t promise a timeframe — the call comes once the check is complete.
      </p>
    </>
  );
}

function PrivacyModal({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div
      className="privscrim on"
      role="dialog"
      aria-modal="true"
      aria-label="How your information is handled"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="privmodal">
        <p className="eyebrow">Privacy</p>
        <h2>How your information is handled</h2>
        <div className="provbox">
          <b>This wording is provisional.</b> The full notice is drafted by the study’s data
          protection officer and legal counsel, not written in design.
        </div>
        <h3>Kept apart from survey answers</h3>
        <p>
          Your firm’s survey answers are held separately from the people who administer the space.
          As a coordinator you can see that a survey is complete, never what was answered.
        </p>
        <h3>Following up with you</h3>
        <p>
          Follow-up is optional and your firm takes part either way. If you do not say yes, no
          follow-up is made.
        </p>
        <div className="actions">
          <button type="button" className="btn-2" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Authenticated portal ───────────────────────────────────────────────────

type PortalScreen = 'landing' | 'assign' | 'outreach' | 'whylink' | 'team' | 'results' | 'report';

function Portal({
  session,
  onSignOut,
}: {
  session: PortalSession;
  onSignOut: () => void;
}): JSX.Element {
  const [screen, setScreen] = useState<PortalScreen>('landing');
  const [me, setMe] = useState<PortalMe | null>(null);
  const [seats, setSeats] = useState<SeatAssignment[] | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorStateKind | null>(null);
  const [seatNote, setSeatNote] = useState<string | null>(null);
  // Whether CIS has released this firm's report — nothing of it shows before.
  const [released, setReleased] = useState(false);

  async function load(): Promise<void> {
    try {
      const [meResult, seatsResult] = await Promise.all([
        portalClient.me(session.token),
        portalClient.getSeats(session.token),
      ]);
      setMe(meResult);
      setSeats(seatsResult);
      const editionId = meResult.currentEdition?.id;
      setReleased(
        editionId
          ? await portalClient
              .getReport(session.token, editionId)
              .then((r) => r.released)
              .catch(() => false)
          : false,
      );
    } catch (e) {
      if (e instanceof ApiError && e.statusCode === 401) {
        setErrorKind('expired_link');
      } else {
        setErrorKind('service_unavailable');
      }
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token]);

  const go = (v: PortalScreen) => {
    setScreen(v);
    setSeatNote(null);
    window.scrollTo(0, 0);
  };

  if (errorKind === 'expired_link') {
    return (
      <ErrorState
        kind="expired_link"
        onBack={() => {
          onSignOut();
        }}
      />
    );
  }
  if (errorKind) return <ErrorState kind={errorKind} />;
  if (!me || !seats) {
    return (
      <div className="shell firmportal">
        <main>
          <p className="lede">Loading…</p>
        </main>
      </div>
    );
  }

  // A firm's own "setup vs running" is its OWN progress (all three seats
  // assigned), not the edition's status — the edition can already be open
  // for collection while a firm is still deciding who answers its surveys.
  // Only "closed" tracks the edition directly, since that's genuinely when
  // results become computable.
  const allSeatsAssigned = seats.every((s) => s.state !== 'empty');
  const phase: 'setup' | 'running' | 'closed' =
    me.currentEdition?.status === 'locked' || me.currentEdition?.status === 'archived'
      ? 'closed'
      : allSeatsAssigned
        ? 'running'
        : 'setup';

  const firmName = me.organization?.displayName ?? 'Your firm';

  return (
    <div className="shell firmportal">
      <header className="top">
        <div className="lockup">
          CIS × Dragnet Benchmark
          <small>Stockbroking firm portal</small>
        </div>
      </header>
      <main>
        {screen === 'landing' && (
          <PortalLanding
            firm={firmName}
            phase={phase}
            seats={seats}
            me={me}
            onAssign={() => go('assign')}
            onOutreach={() => go('outreach')}
            onTeam={() => go('team')}
            onResults={() => go('results')}
            released={released}
            onReport={() => go('report')}
          />
        )}
        {screen === 'assign' && (
          <AssignView
            token={session.token}
            seats={seats}
            reload={load}
            seatNote={seatNote}
            setSeatNote={setSeatNote}
            onBack={() => go('landing')}
          />
        )}
        {screen === 'outreach' && (
          <OutreachView
            token={session.token}
            onWhy={() => go('whylink')}
            onBack={() => go('landing')}
          />
        )}
        {screen === 'whylink' && <WhyLinkView onBack={() => go('outreach')} />}
        {screen === 'team' && (
          <TeamView session={session} onBack={() => go('landing')} onReload={load} me={me} />
        )}
        {screen === 'report' && me.currentEdition && (
          <div className="portal-report">
            <FirmReport
              source={portalFirmSource(session.token, me.currentEdition.id)}
              onBack={() => go('landing')}
            />
          </div>
        )}
        {screen === 'results' && (
          <ResultsView
            token={session.token}
            editionId={me.currentEdition?.id ?? null}
            organizationId={me.organization?.id ?? null}
            accessCode={me.coordinator?.accessCode ?? null}
            onBack={() => go('landing')}
          />
        )}
      </main>
    </div>
  );
}

// ─── Portal landing (three phases, derived from real edition state) ────────

function PortalLanding({
  firm,
  phase,
  seats,
  me,
  onAssign,
  onOutreach,
  onTeam,
  onResults,
  released,
  onReport,
}: {
  firm: string;
  phase: 'setup' | 'running' | 'closed';
  seats: SeatAssignment[];
  me: PortalMe;
  onAssign: () => void;
  onOutreach: () => void;
  onTeam: () => void;
  onResults: () => void;
  released: boolean;
  onReport: () => void;
}): JSX.Element {
  const assigned = seats.filter((s) => s.state !== 'empty').length;
  const complete = seats.filter((s) => s.state === 'complete').length;
  const allAssigned = assigned === seats.length;
  const mine = seats.find((s) => s.isSelf);

  return (
    <>
      <div className="portalhead">
        <div>
          <p className="eyebrow">Firm portal</p>
          <h1 tabIndex={-1}>{firm} is open.</h1>
        </div>
        <div className="who">
          <b>{me.coordinator?.isLead ? 'Lead coordinator' : 'Coordinator'}</b>
        </div>
      </div>

      {phase === 'setup' && (
        <ol className="tasks">
          <li className="task">
            <div className="tasknum">1</div>
            <div className="taskbody">
              <div className="taskhead">
                <b>Decide who answers your three surveys</b>
                <span className={`pill ${allAssigned ? 'ok' : 'todo'}`}>
                  {allAssigned
                    ? 'All three assigned'
                    : assigned === 0
                      ? 'Not started'
                      : `${assigned} of 3 assigned`}
                </span>
              </div>
              <p>
                Each is answered by a different person. Assign them and they get their own access.
              </p>
              <div className="actions">
                <button type="button" className="btn" onClick={onAssign}>
                  {allAssigned ? 'Change who answers' : 'Assign people'}
                </button>
              </div>
            </div>
          </li>
          <li className={`task${allAssigned ? '' : ' lockedtask'}`}>
            <div className="tasknum">2</div>
            <div className="taskbody">
              <div className="taskhead">
                <b>Invite your clients to take part</b>
                <span className={`pill ${allAssigned ? 'todo' : 'locked'}`}>
                  {allAssigned ? 'Not started' : 'Locked'}
                </span>
              </div>
              <p>
                {allAssigned
                  ? 'Text to send through your own systems, and a running count of how many take part.'
                  : 'Assign your three surveys first.'}
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn-2"
                  disabled={!allAssigned}
                  onClick={onOutreach}
                >
                  Invite your clients
                </button>
              </div>
            </div>
          </li>
        </ol>
      )}

      {phase === 'running' && (
        <>
          <div className="statgrid">
            <div className="stat">
              <b>
                {complete} of {seats.length}
              </b>
              <span>Firm surveys complete</span>
            </div>
          </div>
          <div className="actions">
            <button type="button" className="btn-2" onClick={onAssign}>
              See who is assigned
            </button>
            <button type="button" className="btn-2" onClick={onOutreach}>
              Invite your clients
            </button>
          </div>
        </>
      )}

      {released && (
        <div className="resultcard">
          <p className="eyebrow">Your report</p>
          <h2>Your firm report is ready.</h2>
          <p>
            How your firm compares with the industry, across every measure in the study, with your
            own investors’ view of your service. Yours alone — no other firm is named. Read it here
            or download the PDF.
          </p>
          <div className="actions">
            <button type="button" className="btn" onClick={onReport}>
              Read your report
            </button>
            <button type="button" className="btn-2" onClick={onResults}>
              Your results at a glance
            </button>
          </div>
        </div>
      )}

      {!released && phase === 'closed' && (
        <div className="resultcard">
          <p className="eyebrow">Your report</p>
          <h2>Your firm report is being prepared.</h2>
          <p>
            Collection has closed. CIS checks and approves each firm’s report, and releases it once
            the national results are approved. Your coordinators will get an email the moment yours
            is here.
          </p>
        </div>
      )}

      {allAssigned && mine && phase !== 'closed' && !released && (
        <div className="resultcard" style={{ marginTop: 16 }}>
          <p className="eyebrow">Your survey</p>
          <h2>Your {mine.roleLabel.toLowerCase()} survey is waiting.</h2>
          <p>
            About fifteen minutes. Nobody at your firm sees your answers, including your
            coordinator.
          </p>
          <div className="actions">
            <a className="btn-2" href={`/survey?firmSeat=${mine.linkToken}`}>
              Open your survey
            </a>
          </div>
        </div>
      )}

      <div className="later">
        <p className="eyebrow">Details and team</p>
        <div className="laterrow">
          <div>
            <b>Your details and your team</b>
            <span>Change your PIN, add another coordinator, hand over the lead role.</span>
          </div>
          <button type="button" className="btn-2 small" onClick={onTeam}>
            Open
          </button>
        </div>
      </div>

      <p className="owner">
        The three surveys themselves are answered through each seat’s own survey link — never inside
        this portal.
      </p>
    </>
  );
}

// ─── Assign people ──────────────────────────────────────────────────────────

function AssignView({
  token,
  seats,
  reload,
  seatNote,
  setSeatNote,
  onBack,
}: {
  token: string;
  seats: SeatAssignment[];
  reload: () => Promise<void>;
  seatNote: string | null;
  setSeatNote: (s: string | null) => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <>
      <button type="button" className="textlink" onClick={onBack}>
        ← Back
      </button>
      <p className="eyebrow">Your team</p>
      <h1 tabIndex={-1}>Who answers each survey.</h1>
      <p className="lede">
        A name and an email for each. They get their own access and answer without you.
      </p>

      {seatNote && (
        <div className="note" role="status">
          <p>{seatNote}</p>
        </div>
      )}

      <div className="assign">
        {seats.map((seat) => (
          <SeatRow
            key={seat.seatCode}
            token={token}
            seat={seat}
            reload={reload}
            setNote={setSeatNote}
          />
        ))}
      </div>

      <div className="note" style={{ marginTop: 20 }}>
        <h3>Why you cannot see their answers</h3>
        <p>
          Firm surveys are answered inside a hierarchy. Your colleagues answer more honestly if
          their coordinator is not reading over their shoulder — and if a respondent believed you
          could read them, the answers stop being worth collecting.
        </p>
        <p>You see that a survey is complete. You never see what was said.</p>
      </div>
    </>
  );
}

function SeatRow({
  token,
  seat,
  reload,
  setNote,
}: {
  token: string;
  seat: SeatAssignment;
  reload: () => Promise<void>;
  setNote: (s: string | null) => void;
}): JSX.Element {
  const [name, setName] = useState(seat.assignedName ?? '');
  const [email, setEmail] = useState(seat.assignedEmail ?? '');
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await portalClient.assignSeat(token, seat.seatCode, {
        assignedName: name.trim(),
        assignedEmail: email.trim(),
      });
      await reload();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not save that assignment');
    } finally {
      setBusy(false);
    }
  }

  async function requestChange(): Promise<void> {
    const cost = replacementCost(seat.state as SeatState, seat.assignedName);
    if (cost.requiresConfirm) {
      setWarning(cost.warning);
      return;
    }
    await doReplace();
  }

  async function doReplace(): Promise<void> {
    setWarning(null);
    setBusy(true);
    try {
      await portalClient.confirmSeatReplacement(token, seat.seatCode);
      await reload();
      setName('');
      setEmail('');
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not replace this seat');
    } finally {
      setBusy(false);
    }
  }

  const cls = `assignrow${seat.state !== 'empty' ? ' saved' : ''}${seat.isSelf ? ' self' : ''}${seat.stalledAt ? ' attn' : ''}`;

  return (
    <div className={cls}>
      <div className="arhead">
        <b>{seat.roleLabel}</b>
        <span
          className={`pill ${seat.state === 'complete' ? 'ok' : seat.state === 'started' ? 'started' : seat.state === 'invited' ? 'sent' : 'todo'}`}
        >
          {seat.isSelf && seat.state === 'invited' ? 'You' : SEAT_STATE_LABEL[seat.state]}
        </span>
      </div>

      {seat.stalledAt && (
        <p className="seatnote">
          Begun and nothing since {seat.stalledAt}. Whatever the reason, this survey is not going to
          finish on its own.
        </p>
      )}

      {seat.isSelf ? (
        <div className="selfbox">
          <p>
            <b>This one is yours.</b> You told us your role when you set up your access, so this
            survey is already assigned to you.
          </p>
          <div className="actions">
            <a className="btn-2" href={`/survey?firmSeat=${seat.linkToken}`}>
              Open your survey
            </a>
          </div>
        </div>
      ) : seat.state !== 'empty' ? (
        <div className="ardone">
          <div>
            <span className="name">{seat.assignedName}</span>
            <br />
            <span className="mail">{seat.assignedEmail}</span>
            <span className="statemsg">
              {seat.state === 'complete'
                ? 'Submitted. You cannot see what was answered.'
                : seat.state === 'started'
                  ? 'Begun, not submitted.'
                  : 'Invited. Not opened yet.'}
            </span>
          </div>
          {seat.state === 'invited' && (
            <p className="hint">
              Send them this link:{' '}
              <code>{`${window.location.origin}/survey?firmSeat=${seat.linkToken}`}</code>
            </p>
          )}
          <button
            type="button"
            className="btn-2 small"
            disabled={busy}
            onClick={() => void requestChange()}
          >
            {seat.state === 'complete' ? 'Change who answered' : 'Change'}
          </button>
        </div>
      ) : (
        <div className="arfields">
          <div>
            <label htmlFor={`${seat.seatCode}Name`}>Name</label>
            <input
              id={`${seat.seatCode}Name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${seat.seatCode}Mail`}>Email</label>
            <input
              id={`${seat.seatCode}Mail`}
              type="email"
              value={email}
              placeholder="name@yourfirm.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="arsave"
            disabled={!(name.trim() && emailOk(email)) || busy}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      )}

      {warning && (
        <div className="warnbox">
          <b>Before you replace them.</b> {warning}
          <div className="actions">
            <button type="button" className="btn" onClick={() => void doReplace()}>
              Replace anyway
            </button>
            <button type="button" className="btn-2" onClick={() => setWarning(null)}>
              Keep them
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Outreach ─────────────────────────────────────────────────────────────────

function OutreachView({
  token,
  onWhy,
  onBack,
}: {
  token: string;
  onWhy: () => void;
  onBack: () => void;
}): JSX.Element {
  const [seg, setSeg] = useState<Segment>('individual');
  const [links, setLinks] = useState<OutreachLink[]>([]);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const l = await portalClient.getOutreach(token);
        if (!cancelled) setLinks(l);
      } catch {
        // Non-fatal for this view; volumes simply show as zero and the link
        // stays blank until the next successful load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const bySegment = (s: Segment) => links.find((l) => l.segment === s);
  const copy = SEGMENTS[seg];
  // The real, working link — the coordinator's own outreach token for this
  // segment, the same one `/outreach/:token/context` resolves for a
  // respondent who follows it.
  const currentLink = bySegment(seg);
  const link = currentLink ? `${window.location.origin}/survey?ref=${currentLink.token}` : '';
  const emailText = `Subject: ${copy.subject}\n\n${copy.body.join('\n\n')}\n\n${link}`;

  function copyText(t: string) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(t)
        .then(() => setCopied('Copied'))
        .catch(() => setCopied('Copy it yourself'));
    } else setCopied('Copy it yourself');
  }

  return (
    <>
      <button type="button" className="textlink" onClick={onBack}>
        ← Back
      </button>
      <p className="eyebrow">Inviting your clients</p>
      <h1 tabIndex={-1}>Text to send your clients.</h1>
      <p className="lede">
        Your clients are not one audience. Send each group the text meant for them — the link is
        different for each, and it opens the right survey.
      </p>

      <div className="segtabs" role="tablist">
        {SEGMENT_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={s === seg}
            onClick={() => {
              setSeg(s);
              setCopied('');
            }}
          >
            {SEGMENTS[s].tab}
          </button>
        ))}
      </div>
      <div className="seghelp">
        <b>{copy.helpTitle}</b>
        <span>{copy.helpBody}</span>
      </div>

      <div className="blockcard">
        <div className="blockhead">
          <b>Email</b>
          <span className="meta">Subject and body</span>
        </div>
        <textarea className="copytext" readOnly aria-label="Email text" value={emailText} />
        <div className="blockfoot">
          <button type="button" className="copybtn" onClick={() => copyText(emailText)}>
            Copy
          </button>
          <span className="copystate">{copied}</span>
        </div>
      </div>
      <div className="blockcard">
        <div className="blockhead">
          <b>Text message</b>
          <span className="meta">Shorter</span>
        </div>
        <textarea
          className="copytext"
          readOnly
          aria-label="Text message"
          style={{ minHeight: 120 }}
          value={`${copy.sms}\n\n${link}`}
        />
      </div>

      <div className="linkperf">
        <div className="lphead">
          <h2>How your links are doing</h2>
          <span className="lpnote">
            Counts only. We never tell you who, and never what anyone said.
          </span>
        </div>
        <table className="lptable">
          <thead>
            <tr>
              <th>Link</th>
              <th>Opened</th>
              <th>Started</th>
              <th>Finished</th>
            </tr>
          </thead>
          <tbody>
            {SEGMENT_ORDER.map((s) => {
              const v = bySegment(s);
              return (
                <tr key={s}>
                  <td>
                    <b>{SEGMENTS[s].tab}</b>
                  </td>
                  <td>{v?.opens ?? 0}</td>
                  <td>{v?.starts ?? 0}</td>
                  <td>{v?.finishes ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="lpfoot">
          Only the ones who arrived through your link are counted here. A client who found the
          survey another way still counts towards the study, but not towards this.
        </p>
      </div>

      <div className="linkstrip">
        <p>
          <b>Keep the link exactly as it appears.</b> It takes your client to the right survey,
          pre-selects your firm, and lets us tell you how your outreach performed.
        </p>
        <button type="button" className="btn-2" onClick={onWhy}>
          Why the link matters
        </button>
      </div>
    </>
  );
}

function WhyLinkView({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <>
      <button type="button" className="textlink" onClick={onBack}>
        ← Back to the text
      </button>
      <p className="eyebrow">The link</p>
      <h1 tabIndex={-1}>Why the link matters.</h1>
      <div className="whymatters">
        <b>This is how your clients’ feedback reaches your report.</b>
        <p>
          A client who arrives through your link starts with your firm already on their list, so
          their view of you is captured. A client who arrives another way still takes part and may
          still rate you — the link is a convenience and a measure, not a gate.
        </p>
      </div>
      <ul className="linkpoints">
        <li>
          <b>It takes your client to the right survey</b> and pre-selects your firm — removable,
          exactly like any other.
        </li>
        <li>
          <b>It is different for each group.</b> Sending the wrong one opens the wrong survey.
        </li>
        <li>
          <b>It lets us measure your outreach</b> — opens and starts, the only measure of it.
        </li>
        <li>
          <b>It never tells us who they are.</b> The link identifies your firm and nothing else.
        </li>
      </ul>
      <div className="warnbox">
        <b>Do not shorten it, rewrite it, or put it behind a tracking redirect of your own.</b>
        Any of those breaks the record of where it came from, so your outreach will not be counted.
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>
          Back to the text
        </button>
      </div>
    </>
  );
}

// ─── Details and team (UX-FRM-007) ─────────────────────────────────────────

function TeamView({
  session,
  me,
  onReload,
  onBack,
}: {
  session: PortalSession;
  me: PortalMe;
  onReload: () => Promise<void>;
  onBack: () => void;
}): JSX.Element {
  const [team, setTeam] = useState<Coordinator[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [newPin, setNewPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadTeam(): Promise<void> {
    try {
      setTeam(await portalClient.listTeam(session.token));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not load your team');
    }
  }

  useEffect(() => {
    void loadTeam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addMember(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await portalClient.addTeamMember(session.token, { name: name.trim(), email: email.trim() });
      setName('');
      setEmail('');
      await loadTeam();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not add that coordinator');
    } finally {
      setBusy(false);
    }
  }

  async function handover(coordinatorId: string): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await portalClient.handoverLead(session.token, coordinatorId);
      await loadTeam();
      await onReload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not hand over the lead role');
    } finally {
      setBusy(false);
    }
  }

  async function remove(coordinatorId: string): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await portalClient.removeTeamMember(session.token, coordinatorId);
      await loadTeam();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not remove that coordinator');
    } finally {
      setBusy(false);
    }
  }

  async function changePin(): Promise<void> {
    setPinMsg(null);
    setBusy(true);
    try {
      await portalAuth.setPin(session.token, newPin, currentPin || undefined);
      setPinMsg('Your PIN has been changed.');
      setNewPin('');
      setCurrentPin('');
    } catch (e) {
      setPinMsg(e instanceof ApiError ? e.message : 'Could not change your PIN');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="textlink" onClick={onBack}>
        ← Back
      </button>
      <p className="eyebrow">Details and team</p>
      <h1 tabIndex={-1}>Your account and your team.</h1>

      {err && <div className="err">{err}</div>}

      <h2>Change your PIN</h2>
      <p className="hint">You need your current PIN to set a new one.</p>
      <div className="field">
        <label htmlFor="curPin">Current PIN</label>
        <input
          id="curPin"
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={currentPin}
          onChange={(e) => setCurrentPin(e.target.value.replace(/[^0-9]/g, ''))}
        />
      </div>
      <div className="field">
        <label htmlFor="newPin">New PIN</label>
        <input
          id="newPin"
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={newPin}
          onChange={(e) => setNewPin(e.target.value.replace(/[^0-9]/g, ''))}
        />
      </div>
      {pinMsg && <p className="hint">{pinMsg}</p>}
      <div className="actions">
        <button
          type="button"
          className="btn-2"
          disabled={newPin.length < 4 || busy}
          onClick={() => void changePin()}
        >
          Change PIN
        </button>
      </div>

      <h2 style={{ marginTop: 24 }}>Your team</h2>
      {team === null ? (
        <p className="lede">Loading…</p>
      ) : (
        <ul className="teamlist">
          {team.map((c) => (
            <li key={c.id} className="teamrow">
              <div>
                <b>{c.name}</b> {c.isLead && <span className="pill ok">Lead</span>}
                <br />
                <span className="mail">{c.email}</span>
              </div>
              <div className="actions">
                {!c.isLead && me.coordinator?.isLead && (
                  <>
                    <button
                      type="button"
                      className="btn-2 small"
                      disabled={busy}
                      onClick={() => void handover(c.id)}
                    >
                      Make lead
                    </button>
                    <button
                      type="button"
                      className="btn-2 small"
                      disabled={busy}
                      onClick={() => void remove(c.id)}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>Add a coordinator</h3>
      <div className="field">
        <label htmlFor="teamName">Name</label>
        <input id="teamName" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="teamEmail">Email</label>
        <input
          id="teamEmail"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={!name.trim() || !emailOk(email) || busy}
          onClick={() => void addMember()}
        >
          Add coordinator
        </button>
      </div>
    </>
  );
}

// ─── Results (UX-FRM-RES-001) ───────────────────────────────────────────────

function ResultsView({
  token,
  editionId,
  organizationId,
  accessCode,
  onBack,
}: {
  token: string;
  editionId: string | null;
  organizationId: string | null;
  accessCode: string | null;
  onBack: () => void;
}): JSX.Element {
  void token;
  const [results, setResults] = useState<FirmResults | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorStateKind | null>(null);
  const [notReadyMessage, setNotReadyMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!editionId || !organizationId || !accessCode) {
        setErrorKind('service_unavailable');
        return;
      }
      try {
        const r = await portalClient.getResults(editionId, organizationId, accessCode);
        if (!cancelled) setResults(r);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.statusCode === 403) {
          setErrorKind('access_denied');
        } else if (e instanceof ApiError && e.statusCode === 409) {
          setNotReadyMessage(e.message);
        } else {
          setErrorKind('service_unavailable');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editionId, organizationId, accessCode]);

  return (
    <>
      <button type="button" className="textlink" onClick={onBack}>
        ← Back
      </button>
      <p className="eyebrow">Results</p>
      <h1 tabIndex={-1}>Your results.</h1>

      {errorKind && <ErrorState kind={errorKind} />}
      {notReadyMessage && (
        <div className="note">
          <p>{notReadyMessage}</p>
        </div>
      )}
      {!errorKind && !notReadyMessage && !results && <p className="lede">Loading…</p>}

      {results && (
        <table className="lptable">
          <thead>
            <tr>
              <th>Measure</th>
              <th>You</th>
              <th>Industry</th>
              <th>Standing</th>
            </tr>
          </thead>
          <tbody>
            {results.indices.map((idx) => (
              <tr key={idx.metricCode}>
                <td>
                  <b>{idx.name}</b>
                  <br />
                  <span className="meta">{idx.provenance}</span>
                </td>
                <td>{idx.you ?? '—'}</td>
                <td>{idx.industry ?? '—'}</td>
                <td>{idx.standing.replace('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
