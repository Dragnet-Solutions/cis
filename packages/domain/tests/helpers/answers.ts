/**
 * Shared test helpers: answer every step of a journey with a minimal valid
 * answer, so a test can submit a real survey of any instrument.
 */
import type { Pool } from 'pg';
import { buildJourneySequence, type SurveyItem, type AnswerValue } from '@cis/survey';
import { saveDraftAnswer } from '../../src';

/** A minimal valid answer for an item of any kind (satisfies isAnswered). */
export function validAnswerFor(item: SurveyItem): AnswerValue {
  const opts = item.options ?? [];
  switch (item.kind) {
    case 'scale':
      return { a: item.scaleMin ?? 1 };
    case 'single':
      return { a: opts[0] ?? 'x' };
    case 'multi':
      return { a: [opts[0] ?? 'x'] };
    case 'select':
      if (item.selectThenGreatest) {
        return { a: { picked: [opts[0] ?? 'x'], greatest: opts[0] ?? 'x' } };
      }
      return { a: [opts[0] ?? 'x'] };
    case 'rank':
      return { a: opts.slice(0, item.rankExactlyN ?? 3) };
    case 'yesno': {
      // Pick a value that does not require conditional detail.
      const v = opts.find((o) => o !== item.conditionalDetailOn) ?? opts[0] ?? 'No';
      return { a: { v } };
    }
    case 'grid': {
      const cols = item.gridDimensions ? Object.keys(item.gridDimensions) : ['Rating'];
      const grid: Record<string, Record<string, string>> = {};
      for (const row of item.gridRows ?? []) {
        grid[row] = {};
        for (const c of cols) {
          const dimOpts = item.gridDimensions?.[c] ?? [];
          grid[row]![c] = dimOpts[0] ?? String(item.gridScale?.min ?? 1);
        }
      }
      return { a: grid };
    }
    case 'open':
    default:
      return { a: 'A written answer.' };
  }
}

/** Autosave every step of a journey with a valid answer. */
export async function answerAll(
  pool: Pool,
  respondentId: string,
  items: SurveyItem[],
  ratedFirmIds: string[],
) {
  const sequence = buildJourneySequence(items, ratedFirmIds);
  let step = 0;
  for (const s of sequence) {
    await saveDraftAnswer(pool, respondentId, {
      questionId: s.item.id,
      ratedFirmId: s.ratedFirmId,
      answer: validAnswerFor(s.item),
      step,
    });
    step += 1;
  }
  return sequence;
}
