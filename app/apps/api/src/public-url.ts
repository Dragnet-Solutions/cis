/**
 * The public site's origin, for links in emails: PORTAL_URL, else
 * REPORT_RENDER_URL, else the local admin dev server. The firm portal is at
 * `/firm`, the respondent survey at `/survey`, the operator site at `/`.
 */
export function publicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(env['PORTAL_URL'] || env['REPORT_RENDER_URL'] || 'http://localhost:5174').origin;
}

/** Where a firm's coordinators sign in. */
export const firmPortalUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  `${publicOrigin(env)}/firm`;
