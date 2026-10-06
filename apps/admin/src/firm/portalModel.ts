/**
 * Pure, framework-agnostic model for the firm portal (UX-FRM-001).
 *
 * Task D rebuilt FirmPortal.tsx against the real backend (coordinator auth,
 * team, seats, outreach, results), which retires two things that were
 * artefacts of the earlier unwired prototype rather than real design:
 *
 *  - `notBuiltForSeat` — a seat row now links to a real entry point (Part 6),
 *    so there is nothing left to invoke a "not built" dead end for.
 *  - `DESTINATIONS.team` / `DESTINATIONS.results` — both are now built INTO
 *    this surface, so a "not built, owned elsewhere" label for either would
 *    be a stale claim (the exact defect class fixed once before, in Mission
 *    Board). The last entry, `survey`, was a raw design ID rendered as copy,
 *    so the constant is gone; the portal names the seat link in plain words.
 *
 * `PORTAL_VIEWS` now covers only the unauthenticated claim/sign-in flow —
 * the authenticated portal's own navigation is a separate, simpler type,
 * since a progress indicator only makes sense before a coordinator exists.
 */

/** The claim/sign-in views. Deliberately no `access_model` (§2c) and no
 *  invented invitation-code state — claiming has no code to check server
 *  side; the real gate is `AlreadyClaimedError` redirecting to sign-in. */
export const PORTAL_VIEWS = ['email', 'pin', 'unclaimed', 'claim', 'nocode', 'requested'] as const;

export type PortalView = (typeof PORTAL_VIEWS)[number];

/** The claim flow is genuinely two steps (address → set up access). Two pips,
 *  not four — the claim view itself reads "Step 2 of 2". (§2b) */
export const PROGRESS_PIP_COUNT = 2;

/** How many pips are lit on a given view. Never exceeds PROGRESS_PIP_COUNT. */
export function pipsOnFor(view: PortalView): number {
  const map: Partial<Record<PortalView, number>> = {
    email: 1,
    claim: 2,
  };
  return Math.min(map[view] ?? 0, PROGRESS_PIP_COUNT);
}

/** The four seat states — never six, never two. */
export type SeatState = 'empty' | 'invited' | 'started' | 'complete';

export const SEAT_STATE_LABEL: Record<SeatState, string> = {
  empty: 'Nobody yet',
  invited: 'Invited',
  started: 'Started',
  complete: 'Complete',
};

/**
 * The cost of replacing a seat's occupant, stated BEFORE the change. Mirrors the
 * domain rule (firm-portal-service.replacementCost): a started seat loses a
 * part-finished answer; a completed seat's response is discarded; otherwise no
 * cost. Kept here too so the UI can warn without a round-trip.
 */
export function replacementCost(
  state: SeatState,
  name: string | null,
): { requiresConfirm: boolean; warning: string | null } {
  const who = name ?? 'this person';
  if (state === 'started') {
    return {
      requiresConfirm: true,
      warning:
        `Their link stops working straight away. Anything ${who} had begun is lost — a ` +
        `part-finished answer cannot be passed to someone else.`,
    };
  }
  if (state === 'complete') {
    return {
      requiresConfirm: true,
      warning:
        'This survey is already submitted. Naming someone else discards the completed response and starts again.',
    };
  }
  return { requiresConfirm: false, warning: null };
}

/** The three outreach audiences — the firm segments its own client list. */
export type Segment = 'individual' | 'local_institutional' | 'foreign_institutional';

export interface SegmentCopy {
  tab: string;
  helpTitle: string;
  helpBody: string;
  subject: string;
  body: string[];
  sms: string;
}

/** Copy is provisional under D-31; the three-segment structure is not. */
export const SEGMENTS: Record<Segment, SegmentCopy> = {
  individual: {
    tab: 'Individual investors',
    helpTitle: 'Individual clients',
    helpBody: 'People investing their own money through you.',
    subject: 'An independent survey about your stockbroker',
    body: [
      'The Chartered Institute of Stockbrokers and Dragnet Solutions Limited are running a national study of how stockbroking firms serve investors. We are inviting our clients to take part.',
      'It takes about ten minutes and is completely confidential.',
    ],
    sms: 'We have been asked to pass this on. The Chartered Institute of Stockbrokers and Dragnet Solutions Limited are running a national study of how stockbroking firms serve investors. About ten minutes, completely confidential.',
  },
  local_institutional: {
    tab: 'Nigerian institutions',
    helpTitle: 'Institutional clients in Nigeria',
    helpBody: 'Pension funds, asset managers, insurers and similar, investing on behalf of others.',
    subject: 'An independent study of stockbroking services to institutions',
    body: [
      'The Chartered Institute of Stockbrokers and Dragnet Solutions Limited are running a national study of how stockbroking firms serve institutional investors. We are inviting the institutions we work with to take part.',
      'It takes about twelve minutes. Colleagues in operations, compliance and investment often see different things, and each can answer separately.',
    ],
    sms: 'Passing this on: the Chartered Institute of Stockbrokers and Dragnet Solutions Limited are running a national study of how stockbroking firms serve institutional investors. About twelve minutes, and colleagues can answer separately.',
  },
  foreign_institutional: {
    tab: 'Institutions abroad',
    helpTitle: 'Institutional clients outside Nigeria',
    helpBody:
      'Offshore funds and managers with exposure to this market, including those whose global custodian appoints you.',
    subject: 'An independent study of Nigerian stockbroking services to international institutions',
    body: [
      'The Chartered Institute of Stockbrokers and Dragnet Solutions Limited are running a study of how Nigerian stockbroking firms serve institutions investing from outside the country. We are inviting the institutions we work with to take part.',
      'It takes about twelve minutes. How your information is handled, including under the GDPR where it applies to you, is set out before anything is asked of you.',
    ],
    sms: 'Passing this on: the Chartered Institute of Stockbrokers and Dragnet Solutions Limited are running a study of how Nigerian stockbroking firms serve institutions investing from abroad. About twelve minutes.',
  },
};

export const SEGMENT_ORDER: Segment[] = [
  'individual',
  'local_institutional',
  'foreign_institutional',
];
