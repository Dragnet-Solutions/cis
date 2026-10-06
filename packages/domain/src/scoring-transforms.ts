import { getTransform, getItemTransformBinding, type RawTransform } from '@cis/db';

/**
 * The normalisation transforms N1–N8 (methodology spec §3) and the canonical
 * item→transform binding (§4). Direction lives ONLY in which transform an item
 * is bound to (spec §1.4) — there is deliberately no `_reverse` flag and no
 * inference from item names. All values read from the sole authoritative YAML
 * config via `@cis/db` accessors; nothing here hardcodes a weight or a mapping.
 *
 * A missing / non-substantive response is MISSING (null), never neutral (§1.5).
 */

const MISSING_TOKENS = new Set([
  '',
  "Don't know",
  'Dont know',
  'Not applicable',
  'N/A',
  'Unable to assess',
  'invalid',
  'Invalid',
]);

/** Whether a raw answer is substantive (present and not a missing token). */
export function isSubstantive(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  const s = String(raw).trim();
  return s.length > 0 && !MISSING_TOKENS.has(s);
}

/** A band label in one canonical spelling: "0 to 10%" and "0-10%" both → "0-10%". */
function canonicalBand(label: string): string {
  return label.trim().replace(/\s*(?:to|–|-)\s*/gi, '-');
}

/**
 * The N4 midpoint for a band label. The config keys bands as "0-10%" while the
 * register (and so every real answer) reads "0 to 10%" — an exact-key lookup
 * missed every real answer, so S3-Q2 never scored and no firm was ever
 * DMI-scorable. Exact match first, then the canonical spelling of both sides.
 */
function bandMidpoint(map: Record<string, number> | undefined, raw: string): number | undefined {
  if (!map) return undefined;
  if (map[raw] !== undefined) return map[raw];
  const want = canonicalBand(raw);
  const key = Object.keys(map).find((k) => canonicalBand(k) === want);
  return key === undefined ? undefined : map[key];
}

/** Apply a transform definition to a raw answer, returning a 0–100 score or null
 *  when the answer is missing / unmapped. */
export function applyTransform(transform: RawTransform, raw: unknown): number | null {
  if (!isSubstantive(raw)) return null;
  switch (transform.type) {
    case 'positive_1_10': {
      const x = Number(raw);
      if (!Number.isFinite(x)) return null;
      return ((x - 1) / 9) * 100;
    }
    case 'negative_1_10': {
      const x = Number(raw);
      if (!Number.isFinite(x)) return null;
      return ((10 - x) / 9) * 100;
    }
    case 'manual_process_band': {
      const midpoint = bandMidpoint(transform.midpoint_map, String(raw));
      if (midpoint === undefined) return null;
      return 100 - midpoint; // score_formula: "100 - midpoint"
    }
    default: {
      // Map-based transforms (N3, N5, N6, N7, N8) key on the response label.
      const mapped = transform.map?.[String(raw)];
      return mapped === undefined ? null : mapped;
    }
  }
}

/**
 * Score one item by its canonical binding. Returns the direction-correct 0–100
 * score, or null when the item has no binding or the answer is missing.
 */
export function scoreItem(itemId: string, raw: unknown): number | null {
  const binding = getItemTransformBinding()[itemId];
  if (!binding) return null;
  const transform = getTransform(binding);
  if (!transform) return null;
  return applyTransform(transform, raw);
}

/**
 * S3-Q4_composite (an OMI Operations item). The config binds the grid's two
 * named dimensions as `S3-Q4.performance` (N5) and `S3-Q4.risk` (N6), but the
 * answer is stored as ONE grid under `S3-Q4` — `{ [process]: { Performance,
 * Risk } }` — so looking up either dotted id never matched an answer. This
 * expands the grid onto those bindings and takes the mean of every valid cell.
 *
 * The config names the composite without defining its operator; mean-of-valid
 * mirrors the one composite it does define (S5a-Q1, `mean_valid_attributes`) and
 * should be confirmed by the methodology owner.
 */
export function scoreS3Q4Composite(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const cells: number[] = [];
  for (const row of Object.values(raw as Record<string, Record<string, unknown>>)) {
    if (!row || typeof row !== 'object') continue;
    const performance = scoreItem('S3-Q4.performance', row['Performance']);
    const risk = scoreItem('S3-Q4.risk', row['Risk']);
    if (performance !== null) cells.push(performance);
    if (risk !== null) cells.push(risk);
  }
  return cells.length ? cells.reduce((a, b) => a + b, 0) / cells.length : null;
}

/** The transform name bound to an item (for diagnostics/tests). */
export function transformFor(itemId: string): string | undefined {
  return getItemTransformBinding()[itemId];
}
