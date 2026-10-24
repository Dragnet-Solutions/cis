/**
 * Keeping a respondent's place (D-23). A journey started on the public entry
 * (no emailed link) used to live only in the page's memory, so a reload — or
 * coming back to /survey on the same device — started over, although the entry
 * screen promises "we'll keep your place here". The journey's own recovery
 * token (minted for every respondent, contact detail or not) is the key back
 * in, so once a journey starts:
 *
 *  - the address becomes /survey?resume=<token>, so a reload resumes it the
 *    same way the emailed link does (an outreach ?ref= is kept alongside);
 *  - the token is remembered on this device, so coming back to /survey offers
 *    "Continue your survey". It is forgotten once the survey is sent or the
 *    link stops working.
 *
 * The token is the same credential the emailed link carries; nothing else
 * about the respondent is stored.
 */

/** Device storage key for the unfinished journey's recovery token. */
export const RESUME_STORAGE_KEY = 'cis.survey.resume';

/** The minimal storage surface used here (localStorage in the browser). */
export interface PlaceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The survey address that resumes this journey on reload. */
export function resumeSearch(token: string, outreachRef: string | null): string {
  const q = new URLSearchParams({ resume: token });
  if (outreachRef) q.set('ref', outreachRef);
  return `?${q.toString()}`;
}

export function rememberPlace(store: PlaceStore | null, token: string): void {
  try {
    store?.setItem(RESUME_STORAGE_KEY, token);
  } catch {
    // Storage blocked (private mode): the address still keeps the place.
  }
}

export function recalledPlace(store: PlaceStore | null): string | null {
  try {
    const t = store?.getItem(RESUME_STORAGE_KEY) ?? null;
    return t && t.trim() ? t : null;
  } catch {
    return null;
  }
}

export function forgetPlace(store: PlaceStore | null): void {
  try {
    store?.removeItem(RESUME_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** The browser's device storage, or null where it cannot be used. */
export function deviceStore(): PlaceStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Point the address bar at the resumable journey without a navigation. */
export function keepPlaceInAddress(token: string, outreachRef: string | null): void {
  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${resumeSearch(token, outreachRef)}`,
    );
  } catch {
    // A sandboxed frame may refuse; the device memory still keeps the place.
  }
}
