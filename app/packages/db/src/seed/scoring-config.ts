import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Pool } from 'pg';
import { query } from '../client';

/**
 * The sole authoritative scoring configuration is
 * `CIS_SCORING_CONFIG_CANDIDATE_v0.15.yaml` (methodology spec §18: "No embedded
 * duplicate config"). It is read from that YAML here and never hardcoded a
 * second time in application code. If the file cannot be read, this throws — we
 * do not proceed on reconstructed values.
 *
 * v0.14 → v0.15 (Phase 21 §2 follow-up, actual YAML supplied and diffed
 * directly against the prior file — no numeric weight, transform or threshold
 * changed): D1's decision_status moved from CANDIDATE_PENDING_APPROVAL to
 * PRODUCT_DECISION_APPLIED_PENDING_METHODOLOGY_VALIDATION, its candidate now
 * named `..._with_directional_standalone_display`; the IEI/ICI `headline.
 * disclosure` blocks gained `standalone_below_floor_display`; and `privacy`
 * was restructured into `standalone_segment_display.{shown_directionally,
 * suppressed}` — all confirming, in the actual authoritative document, the
 * exact separation this session's Phase 21 §2.1 work already built
 * (`SegmentDisplayState`, `pooledHeadline`'s `standaloneState`, the
 * `SUPPRESSED_SEGMENT_RECONSTRUCTABLE` check). The v0.14 file is kept
 * alongside this one — never deleted — as the prior authoritative version a
 * signed-off v0.14 run's provenance still points to.
 */

export interface ScoringConfig {
  methodology: { id: string; version: string; status: string; score_range: [number, number] };
  transforms: Record<string, RawTransform>;
  item_transform_binding: Record<string, string>;
  indices: {
    DMI: { weighted_items: Record<string, string>; firm_completeness: { required: string[] } };
    SEI: {
      industry_eligibility: {
        minimum_firm_investor_observations: {
          value: unknown;
          engineering_may_invent_value: boolean;
        };
      };
    };
    [k: string]: unknown;
  };
  firm_counts: Record<string, { definition: string }>;
  [k: string]: unknown;
}

export interface RawTransform {
  type: string;
  formula?: string;
  map?: Record<string, number>;
  midpoint_map?: Record<string, number>;
  score_formula?: string;
}

const CONFIG_FILENAME = 'CIS_SCORING_CONFIG_CANDIDATE_v0.15.yaml';
let cached: ScoringConfig | null = null;

/** Parse and cache the authoritative candidate config from its YAML. */
export function loadScoringConfig(): ScoringConfig {
  if (cached) return cached;
  const file = path.join(__dirname, CONFIG_FILENAME);
  const text = readFileSync(file, 'utf8');
  const parsed = parseYaml(text) as ScoringConfig;
  if (!parsed?.methodology?.id) {
    throw new Error(`Scoring config ${CONFIG_FILENAME} is missing or malformed`);
  }
  cached = parsed;
  return parsed;
}

/** Methodology identity + status (id / version / status). */
export function getMethodologyMeta(): { id: string; version: string; status: string } {
  const m = loadScoringConfig().methodology;
  return { id: m.id, version: m.version, status: m.status };
}

/** `methodology_version` string stamped on runs, e.g. "CIS-SCORE-2026@0.14". */
export function methodologyVersionString(): string {
  const m = getMethodologyMeta();
  return `${m.id}@${m.version}`;
}

export function getTransform(name: string): RawTransform | undefined {
  return loadScoringConfig().transforms[name];
}

/** The item → transform name binding table (direction lives here, not in flags). */
export function getItemTransformBinding(): Record<string, string> {
  return loadScoringConfig().item_transform_binding;
}

/** DMI weighted items as numbers, e.g. { 'S1-Q3': 0.4, 'S3-Q2': 0.4, 'S1-Q8': 0.2 }. */
export function getDmiWeights(): Record<string, number> {
  const raw = loadScoringConfig().indices.DMI.weighted_items;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Number(v);
  return out;
}

/** The three items a firm must have valid to be DMI-complete (item-level). */
export function getDmiRequiredItems(): string[] {
  return loadScoringConfig().indices.DMI.firm_completeness.required;
}

/**
 * The OMI role sub-indices and their contributing item ids (methodology §OMI).
 * A composite item (e.g. `S3-Q4_composite`) is expanded to its bound sub-items
 * (`S3-Q4.performance`, `S3-Q4.risk`) so completeness is checked against real
 * answerable items. OMI-complete requires all three role sub-indices calculable
 * (`all_three_role_subindices_required`); the per-sub-index calculability bar
 * (≥1 valid contributing item, the standard mean-of-valid reading) is a framework
 * interpretation flagged pending methodology approval — no threshold is invented.
 */
export function getOmiRoleItemGroups(): Record<string, string[]> {
  const omi = loadScoringConfig().indices['OMI'] as Record<string, unknown>;
  const binding = getItemTransformBinding();
  const roles = (omi['firm_components'] as string[]) ?? ['CEO', 'Compliance', 'Operations'];
  const expand = (item: string): string[] => {
    if (binding[item]) return [item];
    // A composite maps to any bound items that share its stem (e.g. S3-Q4.*).
    const stem = item.replace(/_composite$/, '');
    const parts = Object.keys(binding).filter((k) => k === stem || k.startsWith(`${stem}.`));
    return parts.length > 0 ? parts : [item];
  };
  const out: Record<string, string[]> = {};
  for (const role of roles) {
    const spec = omi[role] as { items?: string[] } | undefined;
    const items = spec?.items ?? [];
    out[role] = items.flatMap(expand);
  }
  return out;
}

/**
 * The approved Industry SEI minimum firm-investor observation floor, or NULL
 * when unset (`PENDING_VALIDATOR`). NULL means Industry SEI is NOT_CALCULABLE —
 * engineering must not invent a value.
 */
export function getIndustrySeiFloor(): number | null {
  const cfg =
    loadScoringConfig().indices.SEI.industry_eligibility.minimum_firm_investor_observations;
  if (typeof cfg.value === 'number') return cfg.value;
  return null; // 'PENDING_VALIDATOR'
}

/**
 * Persist the candidate methodology into `metric_definitions` (Phase 5's
 * config-as-data pattern) as version 15, is_active = FALSE (it is not the active
 * official config — it is TEST_UNAPPROVED), is_provisional = TRUE. Provenance
 * only; live computation reads the YAML via the accessors above. Idempotent.
 */
export async function seedCandidateScoringConfig(pool: Pool): Promise<void> {
  const cfg = loadScoringConfig();
  const version = 15;
  for (const code of ['OMI', 'DMI', 'IEI', 'ICI', 'SEI']) {
    await query(
      pool,
      `INSERT INTO metric_definitions (metric_code, version, config, is_provisional, is_active, description)
       VALUES ($1,$2,$3,TRUE,FALSE,$4)
       ON CONFLICT (metric_code, version) DO NOTHING`,
      [
        code,
        version,
        JSON.stringify({
          methodology: cfg.methodology,
          index: cfg.indices[code] ?? null,
          transforms: cfg.transforms,
          binding: cfg.item_transform_binding,
          source: CONFIG_FILENAME,
          candidate_test_unapproved: true,
        }),
        `CIS-SCORE-2026 v0.15 candidate config for ${code} (TEST_UNAPPROVED; read from ${CONFIG_FILENAME}).`,
      ],
    );
  }
}
