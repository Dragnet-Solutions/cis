import type { Persona } from './answers';
import { fakeInstitution, fakePerson } from './names';
import { Rng, clamp } from './rng';

/**
 * The plan: who answers what, derived deterministically from the seed and the
 * firm list. Nothing here talks to the API, so `--dry-run` can print it and
 * the unit tests can check it.
 *
 *  - Each firm gets a seeded "personality" (quality in [0, 1]) that tilts its
 *    own seat answers and its investors' ratings.
 *  - Popularity is Zipf-like over a seeded firm order; the least popular
 *    `tailShare` of firms are a deliberate small-firm tail with 3–8 retail
 *    ratings each (under the reports' ten-response floor), while every other
 *    firm gets at least `headMin` ratings plus a Zipf share of the rest.
 *  - Retail investors rate 2–3 firms; institutions 1–3. Most arrive through a
 *    rated firm's outreach link (attributable), the rest through the public
 *    entry.
 *  - A small share of investors are lazy: speeders and straight-liners.
 */

export interface FirmRef {
  id: string;
  displayName: string;
}

export type Segment = 'retail' | 'local' | 'foreign';
export const SEGMENT_INSTRUMENT: Record<Segment, 'S4' | 'S5a' | 'S5b'> = {
  retail: 'S4',
  local: 'S5a',
  foreign: 'S5b',
};
/** The outreach-link segment a firm's coordinator hands to each investor type. */
export const SEGMENT_OUTREACH: Record<
  Segment,
  'individual' | 'local_institutional' | 'foreign_institutional'
> = {
  retail: 'individual',
  local: 'local_institutional',
  foreign: 'foreign_institutional',
};

export const SEAT_CODES = ['S1', 'S2', 'S3'] as const;
export type SeatCode = (typeof SEAT_CODES)[number];

export interface Targets {
  firms: number;
  retail: number;
  local: number;
  foreign: number;
  regulators: number;
}

export const DEFAULT_TARGETS: Targets = {
  firms: 80,
  retail: 1111,
  local: 25,
  foreign: 15,
  // One per active Market Institutions role: SEC, NGX, CSCS (clearing and
  // depository), LCFE, NASD, FMDQ.
  regulators: 7,
};

export interface PlanOptions {
  seed: string;
  targets: Targets;
  /** Zipf exponent for popularity among the non-tail firms. */
  zipf: number;
  /** Share of firms in the deliberate small-firm tail (< 10 retail ratings). */
  tailShare: number;
  /** Minimum retail ratings planned for every non-tail firm. */
  headMin: number;
  /** Share of investors arriving through a firm's outreach link. */
  outreachShare: number;
  speederShare: number;
  straightlinerShare: number;
}

export const DEFAULT_PLAN_OPTIONS: Omit<PlanOptions, 'seed' | 'targets'> = {
  zipf: 1.0,
  tailShare: 0.1,
  headMin: 12,
  outreachShare: 0.8,
  speederShare: 0.03,
  straightlinerShare: 0.03,
};

export type Tier = 'strong' | 'average' | 'weak';

export interface PlannedFirm {
  id: string;
  name: string;
  /** Seeded quality in [0, 1]; tilts seat answers and investor ratings. */
  quality: number;
  tier: Tier;
  /** 1 = most popular. */
  popularityRank: number;
  isTail: boolean;
  /** Planned retail ratings (relationships), from the quota allocation. */
  retailQuota: number;
}

export interface Contact {
  channel: 'email' | 'text' | 'both' | 'none';
  email: string | null;
  phone: string | null;
}

export interface PlannedInvestor {
  key: string;
  segment: Segment;
  instrument: 'S4' | 'S5a' | 'S5b';
  index: number;
  ratedFirmIds: string[];
  /** The firm whose outreach link they follow; null = public entry. */
  viaFirmId: string | null;
  persona: Persona;
  contact: Contact;
  institutionName: string | null;
  /** Goodness for shared (market-level) items. */
  disposition: number;
}

export interface PlannedSeat {
  key: string;
  firmId: string;
  seatCode: SeatCode;
}

export interface Plan {
  seed: string;
  firms: PlannedFirm[];
  seats: PlannedSeat[];
  retail: PlannedInvestor[];
  local: PlannedInvestor[];
  foreign: PlannedInvestor[];
}

export function tierOf(quality: number): Tier {
  if (quality >= 0.62) return 'strong';
  if (quality <= 0.38) return 'weak';
  return 'average';
}

/** Largest-remainder rounding of non-negative reals to integers summing to `total`. */
export function apportion(shares: number[], total: number): number[] {
  const sum = shares.reduce((s, x) => s + x, 0);
  if (sum <= 0 || total <= 0) return shares.map(() => 0);
  const raw = shares.map((s) => (s / sum) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left--;
  }
  return out;
}

function personaFor(rng: Rng, opts: PlanOptions): Persona {
  const r = rng.next();
  if (r < opts.speederShare) return { kind: 'speeder' };
  if (r < opts.speederShare + opts.straightlinerShare) {
    return { kind: 'straightliner', position: rng.pick([0, 0.5, 1]) };
  }
  return { kind: 'normal' };
}

function contactFor(rng: Rng, tag: string, persona: Persona): Contact {
  const p = fakePerson(rng, tag);
  const channel: Contact['channel'] =
    persona.kind !== 'normal'
      ? 'none'
      : (['none', 'email', 'text', 'both'] as const)[rng.weightedIndex([0.45, 0.35, 0.1, 0.1])]!;
  return {
    channel,
    email: channel === 'email' || channel === 'both' ? p.email : null,
    phone: channel === 'text' || channel === 'both' ? p.phone : null,
  };
}

/** Distinct firms, chosen with probability proportional to `weights`. */
function weightedDistinct(rng: Rng, ids: string[], weights: number[], k: number): string[] {
  const w = weights.slice();
  const out: string[] = [];
  while (out.length < k && w.some((x) => x > 0)) {
    const i = rng.weightedIndex(w);
    out.push(ids[i] as string);
    w[i] = 0;
  }
  return out;
}

export function buildPlan(allFirms: FirmRef[], opts: PlanOptions): Plan {
  const { seed, targets } = opts;
  const firmsIn = allFirms.slice(0, targets.firms);
  if (firmsIn.length === 0) throw new Error('No firms to plan for');

  // ── Firms: personality and popularity ─────────────────────────────────────
  const popularityOrder = Rng.derive(seed, 'popularity').shuffle(firmsIn.map((f) => f.id));
  const rankOf = new Map(popularityOrder.map((id, i) => [id, i + 1]));
  const tailCount =
    firmsIn.length > 1 ? Math.max(1, Math.round(firmsIn.length * opts.tailShare)) : 0;
  const tailIds = new Set(popularityOrder.slice(popularityOrder.length - tailCount));
  if (opts.tailShare <= 0) tailIds.clear();

  const firms: PlannedFirm[] = firmsIn.map((f) => {
    const quality = clamp(0.52 + Rng.derive(seed, 'quality', f.id).normal(0, 0.2), 0.05, 0.95);
    return {
      id: f.id,
      name: f.displayName,
      quality,
      tier: tierOf(quality),
      popularityRank: rankOf.get(f.id) ?? 0,
      isTail: tailIds.has(f.id),
      retailQuota: 0,
    };
  });
  const byId = new Map(firms.map((f) => [f.id, f]));
  const head = firms.filter((f) => !f.isTail).sort((a, b) => a.popularityRank - b.popularityRank);
  const zipfWeight = (f: PlannedFirm): number => 1 / Math.pow(f.popularityRank, opts.zipf);

  // ── Retail: how many firms each rates, then quotas per firm ───────────────
  const retailRngs = Array.from({ length: targets.retail }, (_, i) =>
    Rng.derive(seed, 'retail', i),
  );
  const ratedCounts = retailRngs.map((r) => Math.min(firms.length, r.int(2, 3)));
  const totalRatings = ratedCounts.reduce((s, k) => s + k, 0);

  const tailRng = Rng.derive(seed, 'tail');
  let tailTotal = 0;
  for (const f of firms.filter((x) => x.isTail)) {
    f.retailQuota = Math.min(tailRng.int(3, 8), Math.max(0, totalRatings - tailTotal));
    tailTotal += f.retailQuota;
  }
  const headTotal = totalRatings - tailTotal;
  if (head.length > 0) {
    const headMin = Math.min(opts.headMin, Math.floor(headTotal / head.length));
    const extra = apportion(head.map(zipfWeight), headTotal - headMin * head.length);
    head.forEach((f, i) => (f.retailQuota = headMin + (extra[i] ?? 0)));
  }

  const remaining = new Map(firms.map((f) => [f.id, f.retailQuota]));
  const assignRng = Rng.derive(seed, 'assign');
  const ids = firms.map((f) => f.id);
  const retail: PlannedInvestor[] = retailRngs.map((rng, i) => {
    const k = ratedCounts[i] ?? 2;
    const rated = weightedDistinct(
      assignRng,
      ids,
      ids.map((id) => remaining.get(id) ?? 0),
      k,
    );
    if (rated.length < k) {
      const fill = weightedDistinct(
        assignRng,
        head.map((f) => f.id).filter((id) => !rated.includes(id)),
        head.filter((f) => !rated.includes(f.id)).map(zipfWeight),
        k - rated.length,
      );
      rated.push(...fill);
    }
    for (const id of rated) remaining.set(id, (remaining.get(id) ?? 0) - 1);
    return investor(rng, 'retail', i, rated);
  });

  // ── Institutions: rate 1–3 firms, popularity-weighted, from the head ──────
  const instPool = head.length > 0 ? head : firms;
  const institutions = (segment: 'local' | 'foreign', count: number): PlannedInvestor[] =>
    Array.from({ length: count }, (_, i) => {
      const rng = Rng.derive(seed, segment, i);
      const k = Math.min(instPool.length, 1 + rng.weightedIndex([0.3, 0.45, 0.25]));
      const rated = weightedDistinct(
        rng,
        instPool.map((f) => f.id),
        instPool.map(zipfWeight),
        k,
      );
      return investor(rng, segment, i, rated);
    });

  function investor(rng: Rng, segment: Segment, i: number, rated: string[]): PlannedInvestor {
    const persona = personaFor(rng, opts);
    const tag = `${segment[0]}${String(i).padStart(4, '0')}`;
    const viaOutreach = rng.chance(opts.outreachShare);
    const meanQ = rated.reduce((s, id) => s + (byId.get(id)?.quality ?? 0.5), 0) / rated.length;
    return {
      key: `${segment}:${String(i).padStart(4, '0')}`,
      segment,
      instrument: SEGMENT_INSTRUMENT[segment],
      index: i,
      ratedFirmIds: rated,
      // Arriving through a firm's own link pre-selects that firm (RetailEntry),
      // so the recruiting firm is always one of those rated, listed first.
      viaFirmId: viaOutreach ? (rated[0] ?? null) : null,
      persona,
      contact: contactFor(rng, tag, persona),
      institutionName: segment === 'retail' ? null : fakeInstitution(rng, segment, i),
      disposition: clamp(meanQ + rng.normal(0, 0.1), 0, 1),
    };
  }

  // ── Firm seats: three per firm, in a seeded order (rounds take a prefix) ──
  const seats = Rng.derive(seed, 'seats').shuffle(
    firms.flatMap((f) =>
      SEAT_CODES.map((seatCode) => ({ key: `seat:${f.id}:${seatCode}`, firmId: f.id, seatCode })),
    ),
  );

  return {
    seed,
    firms,
    seats,
    retail,
    local: institutions('local', targets.local),
    foreign: institutions('foreign', targets.foreign),
  };
}

/** How many of `total` planned tasks a round with this cumulative fraction covers. */
export function roundCount(total: number, fraction: number): number {
  return Math.min(total, Math.max(0, Math.round(total * clamp(fraction, 0, 1))));
}

/** Retail ratings actually planned per firm (relationships). */
export function plannedRetailRatings(plan: Plan): Map<string, number> {
  const out = new Map(plan.firms.map((f) => [f.id, 0]));
  for (const r of plan.retail) {
    for (const id of r.ratedFirmIds) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** Investors planned to arrive through each firm's outreach link. */
export function plannedAttributed(plan: Plan): Map<string, number> {
  const out = new Map(plan.firms.map((f) => [f.id, 0]));
  for (const r of [...plan.retail, ...plan.local, ...plan.foreign]) {
    if (r.viaFirmId) out.set(r.viaFirmId, (out.get(r.viaFirmId) ?? 0) + 1);
  }
  return out;
}

/** Goodness a respondent brings to one rated firm (that firm's quality plus noise). */
export function relationshipGoodness(
  plan: Plan,
  investorKey: string,
  firmId: string,
  disposition: number,
): number {
  const firm = plan.firms.find((f) => f.id === firmId);
  const rng = Rng.derive(plan.seed, 'relationship', investorKey, firmId);
  const q = firm?.quality ?? 0.5;
  return clamp(q + rng.normal(0, 0.1) + (disposition - q) * 0.15, 0, 1);
}
