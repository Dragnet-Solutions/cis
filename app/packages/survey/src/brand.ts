/**
 * The study's names, as people see them: on every screen, report, email
 * sender name and sign-off. Kept here, in the one package the API, the domain
 * and the admin app all build against, so they are set in one place (D-17,
 * Bobby's naming of 27 Oct).
 *
 *   full title   State of Stockbroking Operations and Investor Experience in
 *                Nigeria: A 2026 CIS-Dragnet Study           → studyTitle(year)
 *   short form   The CIS-Dragnet Benchmark Study             → STUDY_SHORT_NAME
 *   attribution  A CIS-Dragnet Study                         → STUDY_ATTRIBUTION
 *   sign-off     The CIS-Dragnet Benchmark Study Team        → STUDY_SIGN_OFF
 *
 * STUDY_NAME is the short form without its article, for running text
 * ("… in the CIS-Dragnet Benchmark Study").
 */
export const STUDY_NAME = 'CIS-Dragnet Benchmark Study';
export const STUDY_SHORT_NAME = `The ${STUDY_NAME}`;
export const STUDY_ATTRIBUTION = 'A CIS-Dragnet Study';
export const STUDY_SIGN_OFF = `The ${STUDY_NAME} Team`;
export const STUDY_TITLE_SUBJECT =
  'State of Stockbroking Operations and Investor Experience in Nigeria';

/** The full title for an edition: "…in Nigeria: A 2026 CIS-Dragnet Study". */
export function studyTitle(year: string): string {
  return `${STUDY_TITLE_SUBJECT}: A ${year} CIS-Dragnet Study`;
}
