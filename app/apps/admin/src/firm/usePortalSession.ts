import { useCallback, useState } from 'react';

const STORAGE_KEY = 'cis.portal.session';

export interface PortalSession {
  token: string;
  coordinator: { id: string; organizationId: string; name: string; email: string; isLead: boolean };
}

function read(): PortalSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PortalSession;
  } catch {
    return null;
  }
}

/** Forget any stored sign-in. An emailed invitation link calls this before the
 *  portal opens: whatever session this browser kept (another firm, an earlier
 *  test) is not the person following the link (QA item 13). */
export function clearStoredPortalSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** A coordinator's own session — stored separately from the operator admin
 *  session (see apps/admin/src/auth/useSession.ts), never sharing a storage
 *  key or a token, matching the distinct claim spaces the API enforces. */
export function usePortalSession(): {
  session: PortalSession | null;
  signIn: (session: PortalSession) => void;
  signOut: () => void;
} {
  const [session, setSession] = useState<PortalSession | null>(() => read());

  const signIn = useCallback((next: PortalSession) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Non-fatal: session simply won't persist across reloads.
    }
    setSession(next);
  }, []);

  const signOut = useCallback(() => {
    clearStoredPortalSession();
    setSession(null);
  }, []);

  return { session, signIn, signOut };
}
