import { useCallback, useState } from 'react';
import type { AuthUser } from '../api/types';
import { tokenExpiry } from '../api/client';

const STORAGE_KEY = 'cis.admin.session';

export interface Session {
  token: string;
  user: AuthUser;
}

function read(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    // A stored session whose token has already expired is not a session: it
    // would open the app signed-in and then fail every call.
    const exp = tokenExpiry(session.token);
    if (exp !== null && exp * 1000 <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function useSession(): {
  session: Session | null;
  signIn: (session: Session) => void;
  signOut: () => void;
  replaceToken: (token: string) => void;
} {
  const [session, setSession] = useState<Session | null>(() => read());

  const signIn = useCallback((next: Session) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Non-fatal: session simply won't persist across reloads.
    }
    setSession(next);
  }, []);

  const signOut = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setSession(null);
  }, []);

  const replaceToken = useCallback((token: string) => {
    setSession((current) => {
      if (!current) return current;
      const next = { ...current, token };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Non-fatal, as in signIn.
      }
      return next;
    });
  }, []);

  return { session, signIn, signOut, replaceToken };
}
