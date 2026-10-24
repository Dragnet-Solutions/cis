import type { AudienceCategory } from '../api/types';

type Audience = AudienceCategory['audiences'][number];

/**
 * A participant survey reminder ("Retail survey reminder", or any participant
 * template named as a reminder) — the same rule the server applies when it
 * sends one (`isParticipantReminder`). It goes only to respondents who have
 * not finished, never to anyone who submitted (D-03).
 */
export function isSurveyReminder(template: { name: string; audienceKind: string } | null): boolean {
  return !!template && template.audienceKind === 'participant' && /\bremind/i.test(template.name);
}

/** The number a send to this audience will reach, for this template: a
 *  reminder counts only the unfinished respondents who can be emailed. */
export function audienceReach(audience: Audience, reminder: boolean): number | null {
  if (reminder && audience.unfinishedCount !== undefined) return audience.unfinishedCount;
  return audience.count;
}
