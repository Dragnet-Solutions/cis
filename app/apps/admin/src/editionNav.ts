import type { EditionPhase } from './editionPhase';

export type Tab =
  | 'board'
  | 'responses'
  | 'unfinished'
  | 'edition'
  | 'surveys'
  | 'renderer'
  | 'firmteam'
  | 'people'
  | 'invitations'
  | 'regulators'
  | 'scoring'
  | 'national'
  | 'firmreports'
  | 'wording'
  | 'dragnet'
  | 'mail'
  | 'audit';

const ALL: EditionPhase[] = ['before_launch', 'collection_open', 'closing_week', 'closed'];

/**
 * Which nav tabs are relevant in which edition phase (UX-OPS-001: "sections
 * not yet relevant... are shown disabled, not hidden"). A tab not listed for
 * the current phase is rendered disabled, never hidden — the shape of the
 * whole programme stays visible from day one.
 *
 * Surveys stays reachable while collecting (D-01): in that phase it opens in
 * a restricted mode that only freezes questionnaires added to the register
 * after the edition was frozen (e.g. a new market institution's), so their
 * survey links can be issued. Nothing already frozen can be edited.
 */
export const TAB_PHASES: Record<Tab, EditionPhase[]> = {
  board: ALL,
  edition: ALL,
  surveys: ['before_launch', 'collection_open', 'closing_week'],
  renderer: ['before_launch', 'collection_open'],
  firmteam: ['before_launch', 'collection_open', 'closing_week'],
  people: ALL,
  invitations: ['before_launch', 'collection_open', 'closing_week'],
  regulators: ['before_launch', 'collection_open', 'closing_week'],
  responses: ['collection_open', 'closing_week'],
  unfinished: ['collection_open', 'closing_week'],
  scoring: ['closed'],
  national: ['closed'],
  firmreports: ['closed'],
  wording: ALL,
  mail: ALL,
  dragnet: ALL,
  audit: ALL,
};

export function isTabEnabled(tab: Tab, phase: EditionPhase): boolean {
  return TAB_PHASES[tab].includes(phase);
}

/**
 * Why a tab is greyed out, shown on hover. A greyed tab means "no work to do in
 * this phase" (UX-OPS-001), not "the data is hidden": its records stay in the
 * study, operators with the right can still read them, and the audit trail
 * keeps every change (QA exception #6). The wording says so, so the screen and
 * the API do not seem to disagree.
 */
export function tabDisabledReason(tab: Tab, phase: EditionPhase): string | null {
  if (isTabEnabled(tab, phase)) return null;
  const allowed = TAB_PHASES[tab];
  if (phase === 'closed') {
    return 'Nothing to do here once collection has closed. Its records are kept and appear in the audit trail and reports.';
  }
  if (phase === 'before_launch' && allowed.every((p) => p !== 'before_launch')) {
    return 'Opens once the survey is collecting.';
  }
  return allowed.includes('closed')
    ? 'Opens once collection has closed and the results are locked.'
    : 'Not used in this phase of the edition.';
}

/** Surveys outside "before launch" only adds questionnaires not yet frozen. */
export function surveysRestricted(phase: EditionPhase): boolean {
  return phase !== 'before_launch';
}

/**
 * The edition the admin opens on, from the list the API returns (newest
 * first): the open (collecting) one; else the newest locked one (scoring and
 * reporting); else the newest. Mirrors `currentEditionOf` in @cis/db, so a
 * next-year draft never takes over from the edition in progress.
 */
export function pickCurrentEdition<T extends { status: string }>(editions: T[]): T | null {
  return (
    editions.find((e) => e.status === 'open') ??
    editions.find((e) => e.status === 'locked') ??
    editions[0] ??
    null
  );
}

const isTab = (v: string | null | undefined): v is Tab => !!v && v in TAB_PHASES;

/**
 * The page a URL names: `?tab=mail`, or a bare path such as `/mail` typed or
 * bookmarked by hand. Anything else opens the edition page. A reload therefore
 * comes back to the page it was on, not the edition overview.
 */
export function tabFromLocation(pathname: string, search: string): Tab {
  const asked = new URLSearchParams(search).get('tab');
  if (isTab(asked)) return asked;
  const segment = pathname.replace(/^\/+|\/+$/g, '');
  return isTab(segment) ? segment : 'edition';
}

/** The address a page is kept at (`/?tab=mail`). A query, never a path: the
 *  firm portal owns every path beginning `/firm`, `firmteam` included. */
export function tabUrl(tab: Tab): string {
  return `/?tab=${tab}`;
}

const STATUS_WORDS: Record<string, string> = {
  draft: 'draft',
  open: 'collecting',
  locked: 'locked',
  archived: 'archived',
};

/** "2026 · collecting" — the edition switcher's option text. */
export function editionOptionLabel(e: { label: string; status: string }): string {
  return `${e.label} · ${STATUS_WORDS[e.status] ?? e.status}`;
}
