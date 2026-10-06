import { useState, type FormEvent } from 'react';
import { login } from '../api/client';
import { ApiError } from '../api/types';
import type { Session } from '../auth/useSession';

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
      <p className="eyebrow">CIS × Dragnet Benchmark</p>
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
    </div>
  );
}
