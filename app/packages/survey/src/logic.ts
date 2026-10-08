import { getCanonical } from './answer';
import type { GridAnswer, SelectGreatestAnswer, SurveyItem, YesNoAnswer } from './types';

/**
 * Column count for a wrapped scale, chosen by target count (ported from
 * R.scaleColumns). 10 targets → 5 (a balanced 5×2); 11 targets → 6 (6 then 5,
 * the fuller row first so the scale tapers). This is a deliberate approved rule.
 */
export function scaleColumns(count: number): number {
  if (count % 5 === 0) return 5;
  if (count % 4 === 0) return 4;
  return Math.ceil(count / 2);
}

function asPicked(a: unknown): string[] {
  if (Array.isArray(a)) return a as string[];
  if (a && typeof a === 'object' && 'picked' in (a as object)) {
    return (a as SelectGreatestAnswer).picked ?? [];
  }
  return [];
}

function asYesNo(a: unknown): YesNoAnswer {
  if (a && typeof a === 'object' && 'v' in (a as object)) return a as YesNoAnswer;
  return { v: typeof a === 'string' ? a : '' };
}

function gridColumns(item: SurveyItem): string[] {
  return item.gridDimensions ? Object.keys(item.gridDimensions) : ['Rating'];
}

/**
 * Whether an item is completely answered. Ported from R.answered — per-kind,
 * viewport-independent, and an optional comment is never itself an answer.
 */
export function isAnswered(item: SurveyItem, value: unknown): boolean {
  const a = getCanonical(value).a;
  if (a === undefined || a === null) return !!item.answerOptional;

  switch (item.kind) {
    case 'rank':
      return Array.isArray(a) && a.length === (item.rankExactlyN ?? 3);
    case 'select': {
      const picked = asPicked(a);
      if (item.selectThenGreatest) {
        return picked.length >= 1 && !!(a as SelectGreatestAnswer).greatest;
      }
      return picked.length >= 1;
    }
    case 'multi':
      return Array.isArray(a) && a.length >= 1;
    case 'yesno': {
      const y = asYesNo(a);
      if (!y.v) return false;
      if (item.conditionalDetailOn && y.v === item.conditionalDetailOn) {
        return !!(y.detail && y.detail.trim());
      }
      return true;
    }
    case 'grid': {
      const cols = gridColumns(item);
      const grid = (a ?? {}) as GridAnswer;
      return (item.gridRows ?? []).every((r) => {
        const rowVal = grid[r];
        return !!rowVal && cols.every((c) => !!rowVal[c]);
      });
    }
    case 'open':
      return item.answerOptional ? true : String(a ?? '').trim().length > 0;
    default:
      // scale, single
      return String(a).trim() !== '';
  }
}

/**
 * A message naming what is still outstanding, or '' when answered. Ported from
 * R.outstanding — every kind names what is missing rather than only refusing.
 */
export function outstanding(item: SurveyItem, value: unknown): string {
  if (isAnswered(item, value)) return '';
  const a = getCanonical(value).a;
  switch (item.kind) {
    case 'rank': {
      const n = Array.isArray(a) ? a.length : 0;
      const target = item.rankExactlyN ?? 3;
      return `Choose ${target}, in order. ${n} of ${target} chosen.`;
    }
    case 'select': {
      const picked = asPicked(a);
      if (item.selectThenGreatest && picked.length) {
        return 'Now choose which of those carries the greatest consequence.';
      }
      return `Choose at least one, up to ${item.selectUpToN ?? 3}.`;
    }
    case 'multi':
      return 'Choose at least one.';
    case 'yesno': {
      const y = asYesNo(a);
      if (item.conditionalDetailOn && y.v === item.conditionalDetailOn) {
        return 'Briefly, what happened?';
      }
      return 'Choose one.';
    }
    case 'grid':
      return 'Complete every row.';
    case 'scale':
      return `Choose a number from ${item.scaleMin ?? 1} to ${item.scaleMax ?? 10}.`;
    case 'open':
      return 'This one needs an answer in your own words.';
    default:
      return 'Choose one.';
  }
}

/**
 * Toggle an option in a select-up-to-N set. Adds only while under the cap
 * (over-selection is refused, not truncated); removes if already present.
 * Ported from R.controls.select's toggle so the cap rule lives in one place.
 */
export function toggleSelect(current: string[], opt: string, cap: number): string[] {
  const next = current.slice();
  const at = next.indexOf(opt);
  if (at > -1) {
    next.splice(at, 1);
  } else if (next.length < cap) {
    next.push(opt);
  }
  return next;
}

/**
 * Toggle an option in a rank-exactly-N ordering. Appends in tap order while
 * under N; removes if already ranked. The ordering is the answer.
 */
export function toggleRank(current: string[], opt: string, n: number): string[] {
  const next = current.slice();
  const at = next.indexOf(opt);
  if (at > -1) {
    next.splice(at, 1);
  } else if (next.length < n) {
    next.push(opt);
  }
  return next;
}

/** Scope split for a journey wrapper (R.shared / R.perFirm). */
export function sharedItems(items: SurveyItem[]): SurveyItem[] {
  return items.filter((i) => i.scope !== 'firm_specific');
}
export function perFirmItems(items: SurveyItem[]): SurveyItem[] {
  return items.filter((i) => i.scope === 'firm_specific');
}

/**
 * Whether an instrument's journey requires an accepted consent gate before
 * submission. The institutional investor instruments (S5a, S5b) carry a privacy
 * notice — a deleted consent gate on these was a real defect that a full
 * content-accuracy rebuild missed, so it is enforced here, not only in the UI.
 */
export function requiresConsent(instrumentCode: string): boolean {
  return instrumentCode === 'S5a' || instrumentCode === 'S5b';
}
