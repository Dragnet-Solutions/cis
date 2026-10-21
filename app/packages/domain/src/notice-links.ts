/**
 * Links that go into emails. Every service that emails someone takes the
 * public site's address from its caller (the API knows it — PORTAL_URL) as
 * `portalUrl`; these helpers turn that into the links people open.
 */

const DEV_ORIGIN = 'http://localhost:5174';

/** The site origin from `portalUrl` (any path on it is dropped). */
export function siteOrigin(portalUrl?: string | null): string {
  const raw = portalUrl?.trim() || DEV_ORIGIN;
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

/** Where firm coordinators sign in (email + PIN). */
export const firmPortalLink = (portalUrl?: string | null): string =>
  `${siteOrigin(portalUrl)}/firm`;

/** A respondent's own link back into their survey. */
export const surveyResumeLink = (portalUrl: string | null | undefined, recoveryToken: string) =>
  `${siteOrigin(portalUrl)}/survey?resume=${encodeURIComponent(recoveryToken)}`;

/** A firm seat holder's personal link into their seat's survey (S1/S2/S3). */
export const firmSeatLink = (portalUrl: string | null | undefined, linkToken: string) =>
  `${siteOrigin(portalUrl)}/survey?firmSeat=${encodeURIComponent(linkToken)}`;

/** Stops a respondent's survey reminders (the survey app handles ?stop=). */
export const stopRemindersLink = (portalUrl: string | null | undefined, recoveryToken: string) =>
  `${siteOrigin(portalUrl)}/survey?stop=${encodeURIComponent(recoveryToken)}`;

/** Splits plain text into paragraphs on blank lines. */
export function textParagraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
