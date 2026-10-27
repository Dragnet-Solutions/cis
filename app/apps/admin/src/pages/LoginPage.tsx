import { useState, type FormEvent } from 'react';
import { login, requestPasswordReset } from '../api/client';
import { ApiError } from '../api/types';
import type { Session } from '../auth/useSession';
import { STUDY_SHORT_NAME } from '@cis/survey';
import { BrandLockup } from '../components/BrandLockup';

export function LoginPage({
  onSignIn,
  notice = null,
}: {
  onSignIn: (session: Session) => void;
  /** Why the operator is back at sign-in, e.g. an ended session. */
  notice?: string | null;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [resetNote, setResetNote] = useState<string | null>(null);

  async function submitReset(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await requestPasswordReset(email.trim());
      setResetNote(res.message);
    } catch (err) {
      setError(
        err instanceof ApiError && err.statusCode === 429
          ? 'Too many requests. Wait a few minutes and try again.'
          : 'Could not send the request. Try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (forgot) {
    return (
      <div className="login-wrap">
        <div className="brand-row">
          <BrandLockup />
        </div>
        <p className="eyebrow">{STUDY_SHORT_NAME}</p>
        <h1 tabIndex={-1}>Reset your password</h1>
        <p className="lede">
          Enter the email address you sign in with. If it has an account, we will email it a link to
          choose a new password.
        </p>
        {resetNote ? (
          <p className="note" role="status">
            {resetNote}
          </p>
        ) : (
          <form onSubmit={submitReset}>
            <div className="field">
              <label htmlFor="reset-email">Email</label>
              <input
                id="reset-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            {error && <div className="err">{error}</div>}
            <div className="actions">
              <button type="submit" className="btn" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a reset link'}
              </button>
            </div>
          </form>
        )}
        <p>
          <button
            type="button"
            className="textlink"
            onClick={() => {
              setForgot(false);
              setResetNote(null);
              setError(null);
            }}
          >
            Back to sign in
          </button>
        </p>
      </div>
    );
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login(email.trim(), password);
      onSignIn({ token: res.token, user: res.user });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="brand-row">
        <BrandLockup />
      </div>
      <p className="eyebrow">{STUDY_SHORT_NAME}</p>
      <h1 tabIndex={-1}>Study operations</h1>
      <p className="lede">Sign in to manage the current edition and its surveys.</p>
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <div className="err">{error}</div>}
        <div className="actions">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
      <p>
        <button
          type="button"
          className="textlink"
          onClick={() => {
            setForgot(true);
            setError(null);
          }}
        >
          Forgot password?
        </button>
      </p>
    </div>
  );
}
