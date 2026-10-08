/**
 * UX-X-001 — Shared error, access and permission states.
 *
 * One shared recovery grammar for participant and organiser journeys: five
 * states, ONE component, used consistently instead of each surface inventing
 * its own error copy. The wording here is a direct, deliberate hardcode of
 * the approved artefact's own five short messages — unlike UX-X-002, this is
 * NOT routed through the managed-content system (the artefact itself
 * hardcodes these, and they are not legally/operationally owned copy).
 *
 * Hard safety constraint: no state takes a respondent id, name, or answer
 * fragment as a prop — there is no way to construct an instance of this
 * component that leaks identity or content, whatever the caller passes.
 */

export const ERROR_STATES = [
  'expired_link',
  'no_unfinished_survey',
  'access_denied',
  'service_unavailable',
  'participation_closed',
] as const;

export type ErrorStateKind = (typeof ERROR_STATES)[number];

const COPY: Record<ErrorStateKind, { title: string; detail: string }> = {
  expired_link: {
    title: 'Expired continuation link',
    detail: 'This link has expired. Request a new continuation link to resume safely.',
  },
  no_unfinished_survey: {
    title: 'No unfinished survey found',
    detail: 'There is no unfinished response associated with this link.',
  },
  access_denied: {
    title: 'Access denied',
    detail: 'You do not have permission to open this area.',
  },
  service_unavailable: {
    title: 'Service temporarily unavailable',
    detail: 'The service is temporarily unavailable. Your saved work is not lost.',
  },
  participation_closed: {
    title: 'Participation closed or withdrawn',
    detail: 'This survey is no longer accepting responses.',
  },
};

export function ErrorState({
  kind,
  onBack,
}: {
  kind: ErrorStateKind;
  onBack?: () => void;
}): JSX.Element {
  const copy = COPY[kind];
  return (
    <div className="card" role="alert">
      <h2>{copy.title}</h2>
      <p>{copy.detail}</p>
      {onBack && (
        <button type="button" className="btn" onClick={onBack}>
          Back to safe starting point
        </button>
      )}
    </div>
  );
}
