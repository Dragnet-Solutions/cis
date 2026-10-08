/**
 * UX-OPS-001's phase-awareness rule, mirrored client-side: "sections not yet
 * relevant to the current edition phase are shown disabled, not hidden, so
 * the shape of the whole programme stays visible from day one." This must
 * match `editionPhase()` in packages/domain/src/mission-board-service.ts
 * exactly (draft → before_launch; locked/archived/closed → closed;
 * ≤7 days remaining → closing_week; else collection_open) — duplicated here
 * rather than fetched from the mission-board endpoint, since that endpoint
 * evaluates the full 23-condition board just to answer a five-way nav check.
 */
export type EditionPhase = 'before_launch' | 'collection_open' | 'closing_week' | 'closed';

export function editionPhase(status: string, surveyCloseAt: string | null): EditionPhase {
  if (status === 'draft') return 'before_launch';
  if (status === 'locked' || status === 'archived') return 'closed';
  if (!surveyCloseAt) return 'collection_open';
  const daysRemaining = Math.floor((new Date(surveyCloseAt).getTime() - Date.now()) / 86_400_000);
  if (daysRemaining <= 0) return 'closed';
  if (daysRemaining <= 7) return 'closing_week';
  return 'collection_open';
}
