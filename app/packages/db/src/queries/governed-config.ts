import { Pool } from 'pg';
import { query } from '../client';

/**
 * Governed configuration / content: values that are legally or operationally
 * owned, not hardcoded in the app. Consent copy (OPEN-003, DPO/legal), the
 * recovery-link TTL (operational), and the results-section visibility flag all
 * live here as swappable data.
 */
export async function getConfig<T = unknown>(pool: Pool, key: string): Promise<T | null> {
  const result = await query<{ value: T }>(
    pool,
    'SELECT value FROM governed_config WHERE key = $1',
    [key],
  );
  return result.rows[0]?.value ?? null;
}

export async function getAllConfig(pool: Pool): Promise<Record<string, unknown>> {
  const result = await query<{ key: string; value: unknown }>(
    pool,
    'SELECT key, value FROM governed_config ORDER BY key',
  );
  const out: Record<string, unknown> = {};
  for (const row of result.rows) out[row.key] = row.value;
  return out;
}

export async function setConfig(
  pool: Pool,
  key: string,
  value: unknown,
  description?: string,
): Promise<void> {
  await query(
    pool,
    `INSERT INTO governed_config (key, value, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           description = COALESCE(EXCLUDED.description, governed_config.description),
           updated_at = NOW()`,
    [key, JSON.stringify(value), description ?? null],
  );
}

/** Default governed content/parameters. Provisional consent copy is clearly
 *  marked; the words are owned by the DPO/legal and are meant to be swapped. */
export const GOVERNED_CONFIG_DEFAULTS: ReadonlyArray<{
  key: string;
  value: unknown;
  description: string;
}> = [
  {
    key: 'consent.pat011',
    description: 'PAT-011 consent content (PROVISIONAL — owned by DPO/legal, OPEN-003). Swappable.',
    value: {
      provisional: true,
      notice: 'Used for nothing else, and kept separate from your answers.',
      expansionTitle: 'How your information is handled',
      expansion:
        'Contact details are used only to return you to an unfinished survey and to send the ' +
        'final report. Your answers are never shown to the firms you rated, and no firm is told ' +
        'whether you took part. The full notice is provided by the study’s data protection officer.',
      checkboxLabel: 'I have read and accepted how my information is handled.',
    },
  },
  {
    key: 'recovery.link_ttl_seconds',
    description:
      'Recovery/continuation link lifetime (operational, UX-OPS). Not a design constant.',
    value: 172800, // 48h default; operationally governed.
  },
  {
    key: 'public.results_section_visible',
    description: 'Year 1 content decision: whether the public results section is shown.',
    value: true,
  },
  {
    key: 'reporting.retail_cut_thresholds',
    description:
      'Firm-report retail category cut (FRM_04) sufficiency thresholds. PROVISIONAL — a ' +
      'signed-off Year 1 assumption, pending methodology validation. Below `directional` ' +
      'nothing at category level; `directional`..`reportable`-1 is DIRECTIONAL only; ' +
      '`reportable`+ unlocks the cut. Held as configuration, never a hardcoded constant.',
    value: { directional: 10, reportable: 30, provisional: true },
  },
  {
    key: 'reporting.firm_investor_thresholds',
    description:
      'Reporting_Sufficiency_Specification candidate investor-evidence thresholds (Phase 11). ' +
      'PROVISIONAL and INDEPENDENTLY CONFIGURABLE — kept SEPARATE from ' +
      'reporting.retail_cut_thresholds (EVIDENCE_PACK_CONTRACT 10/29/30), which it must never ' +
      'overwrite. The two documents give different numbers for related-but-distinct claims; the ' +
      'conflict is FLAGGED for product/methodology reconciliation (see README §8), not resolved ' +
      'here. Neither is final until validated.',
    value: {
      provisional: true,
      firm_investor_headline: 20, // firm's own IEI/ICI mean unlock (~20 own investors)
      firm_vs_industry_gap: 30, // firm-vs-industry comparison/gap claim (~30 own investors)
      binary_consequence_min: 75, // binary signals need materially more n (~75–100)
      binary_consequence_max: 100,
      shared_investor: 15,
      subsegment: 15,
      note: 'Candidate/provisional per Reporting_Sufficiency_Specification — TO VALIDATE.',
    },
  },
  {
    key: 'reminders.schedule',
    description:
      'UX-OPS-004 investor-side reminder schedule. A STARTING POSITION, not a decision — set here ' +
      'and adjustable during fieldwork. Steps are relative to when a person STOPPED ' +
      '(last_activity_at + days), except the final step which is timed against the edition close ' +
      '(closes − beforeCloseDays), a LIVE reference that moves if the close date moves. STOP ' +
      'language is carried on every reminder after the first (a send-sequence flag, not content).',
    value: {
      steps: [
        { step: 1, kind: 'relative', days: 2, enabled: true },
        { step: 2, kind: 'relative', days: 7, enabled: true },
        { step: 3, kind: 'before_close', beforeCloseDays: 3, enabled: true },
      ],
    },
  },
  {
    key: 'reminders.cap',
    description:
      'UX-OPS-004 maximum total reminders to any one person. Governed configuration, never a ' +
      'hardcoded limit — without a cap a schedule with several steps and a long field period ' +
      'sends indefinitely to someone who has already decided.',
    value: 3,
  },
  {
    key: 'reporting.comparison_margin',
    description:
      'UX-FRM-RES-001 firm-vs-industry comparison margin (points). A difference smaller than ' +
      'this makes NO claim either way — reporting a difference the data cannot support is the ' +
      'failure the sufficiency specification exists to prevent. The artefact hardcodes 3; kept ' +
      'here as governed config, PROVISIONAL, to be reconciled alongside the other open ' +
      'sufficiency-threshold questions (retail_cut_thresholds, firm_investor_thresholds, ' +
      'industry_sei floor). Never a per-index value — one margin for all indices.',
    value: 3,
  },
];

export async function seedGovernedConfigDefaults(pool: Pool): Promise<void> {
  for (const c of GOVERNED_CONFIG_DEFAULTS) {
    await setConfig(pool, c.key, c.value, c.description);
  }
}
