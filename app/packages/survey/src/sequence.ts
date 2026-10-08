import { perFirmItems, sharedItems } from './logic';
import type { SurveyItem } from './types';

/**
 * A single step in a survey-taking journey. A shared step is answered once
 * (ratedFirmId null); a firm-specific step is answered once per rated firm and
 * carries which firm it belongs to.
 */
export interface JourneyStep {
  item: SurveyItem;
  /** null for shared items; the rated firm's id for firm-specific items. */
  ratedFirmId: string | null;
  /** Position of the rated firm in the loop (1-based); 0 for shared steps. */
  firmIndex: number;
}

/**
 * Build the ordered journey sequence for an instrument, applied identically to
 * every multi-firm-scoped instrument (S4, S5a, S5b) and to single-scope ones
 * (which simply have no firm loop).
 *
 * Scope grouping supersedes the Register's absolute item order (a controlled
 * decision recorded in QUESTION_SCOPE_MAPPING): all shared items come first, in
 * Register order, then the firm-specific items repeat per active rated firm, in
 * Register order — even where the Register itself interleaves a shared item
 * between firm-specific ones. Within each scope the Register order is preserved.
 *
 * `items` must already be in Register order (the DB returns them by
 * display_order). This is the same shared/perFirm split the renderer uses,
 * lifted to the journey level — one function, not one per instrument.
 */
export function buildJourneySequence(items: SurveyItem[], ratedFirmIds: string[]): JourneyStep[] {
  const shared = sharedItems(items);
  const perFirm = perFirmItems(items);

  const steps: JourneyStep[] = shared.map((item) => ({ item, ratedFirmId: null, firmIndex: 0 }));

  ratedFirmIds.forEach((firmId, i) => {
    for (const item of perFirm) {
      steps.push({ item, ratedFirmId: firmId, firmIndex: i + 1 });
    }
  });

  return steps;
}

/**
 * The rated firm currently being answered at a given step index, plus loop
 * position — used to restore exact firm context on resume, not just a question
 * number.
 */
export interface FirmContext {
  ratedFirmId: string | null;
  firmIndex: number;
  firmCount: number;
}

export function firmContextAt(steps: JourneyStep[], stepIndex: number): FirmContext {
  const firmCount = new Set(steps.filter((s) => s.ratedFirmId !== null).map((s) => s.ratedFirmId))
    .size;
  const step = steps[stepIndex];
  if (!step) return { ratedFirmId: null, firmIndex: 0, firmCount };
  return { ratedFirmId: step.ratedFirmId, firmIndex: step.firmIndex, firmCount };
}
