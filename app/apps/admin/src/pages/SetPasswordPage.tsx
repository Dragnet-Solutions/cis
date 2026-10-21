import { useEffect, useState, type FormEvent } from 'react';
import { getPasswordSetInfo, setPasswordWithLink } from '../api/client';
import { ApiError, type PasswordSetInfo } from '../api/types';
import { passwordHint } from '../auth/passwordHint';

/**
 * Public page opened from the emailed set-password link
 * (`/set-password?token=…`). Outside the operator app: no session. The person
 * chooses their own password (twice), then signs in. The token is removed from
 * the address bar as soon as it is read, so it does not linger in history.
 */

type State =
  | { kind: 'loading' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ready'; info: PasswordSetInfo }
  | { kind: 'done'; email: string };

function readToken(): string {
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

export function SetPasswordPage(): JSX.Element {
  const [token] = useState(readToken);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Keep the token out of the browser history once read.
    if (window.location.search) window.history.replaceState(null, '', '/set-password');
    if (!token) {
      setState({
        kind: 'invalid',
        message: 'This link is incomplete. Open the link from the email again.',
      });
      return;
    }
    let cancelled = false;
    getPasswordSetInfo(token)
      .then((info) => {
        if (!cancelled) setState({ kind: 'ready', info });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: 'invalid',
          message: err instanceof ApiError ? err.message : 'This link could not be checked.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const email = state.kind === 'ready' ? state.info.email : '';
  const hint = passwordHint(password, email);
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !hint.problem && confirm === password && !busy;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await setPasswordWithLink(token, password);
      setPassword('');
      setConfirm('');
      setState({ kind: 'done', email: res.email });
    } catch (err) {
      if (err instanceof ApiError && (err.statusCode === 410 || err.statusCode === 404)) {
        setState({ kind: 'invalid', message: err.message });
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not set the password');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-wrap">
        <p className="eyebrow">CIS × Dragnet Benchmark</p>
        {state.kind === 'loading' && <p>Checking your link…</p>}

        {state.kind === 'invalid' && (
          <>
            <h1 tabIndex={-1}>This link cannot be used</h1>
            <div className="err" role="alert">
              {state.message}
            </div>
            <p className="lede">
              Ask an administrator to send you a new link from People and access.
            </p>
            <div className="actions">
              <a className="btn-2" href="/">
                Go to sign in
              </a>
            </div>
          </>
        )}

        {state.kind === 'done' && (
          <>
            <h1 tabIndex={-1}>Your password is set</h1>
            <p className="lede" role="status">
              Sign in with {state.email} and the password you just chose.
            </p>
            <div className="actions">
              <a className="btn" href="/">
                Sign in
              </a>
            </div>
          </>
        )}

        {state.kind === 'ready' && (
          <>
            <h1 tabIndex={-1}>
              {state.info.purpose === 'invite' ? 'Choose your password' : 'Set a new password'}
            </h1>
            <p className="lede">
              {state.info.name}, this is for signing in to study operations as{' '}
              <b>{state.info.email}</b>.
            </p>
            <form onSubmit={submit}>
              {/* Lets password managers save the pair against the right account. */}
              <input
                type="email"
                autoComplete="username"
                value={state.info.email}
                readOnly
                hidden
              />
              <div className="field">
                <label htmlFor="newPassword">New password</label>
                <input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby="pwHint"
                  required
                />
                <p id="pwHint" className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
                  {password.length === 0
                    ? 'At least 12 characters. A few unrelated words make a strong password.'
                    : `Strength: ${hint.label}.${hint.problem ? ` ${hint.problem}` : ''}`}
                </p>
              </div>
              <div className="field">
                <label htmlFor="confirmPassword">Type it again</label>
                <input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
                {mismatch && <p className="err">The two passwords do not match.</p>}
              </div>
              {error && (
                <div className="err" role="alert">
                  {error}
                </div>
              )}
              <div className="actions">
                <button type="submit" className="btn" disabled={!canSubmit}>
                  {busy ? 'Saving…' : 'Set password'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
