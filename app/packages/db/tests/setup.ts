import path from 'path';
import { Pool } from 'pg';

import runner from 'node-pg-migrate';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://cis:cis_test_password@localhost:5433/cis_test';

let pool: Pool | null = null;

export function getTestPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  }
  return pool;
}

// Singleton guard: node-pg-migrate holds a pg_advisory_lock for the duration of
// the migration run; calling it concurrently from multiple test-file beforeAll
// hooks (even with fileParallelism:false, Vitest can overlap initialisation)
// produces "Another migration is already running". Run it at most once per
// worker process.
let migrationPromise: Promise<void> | null = null;

export async function runMigrations(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = (runner as unknown as typeof runner)({
      databaseUrl: DATABASE_URL,
      dir: path.join(__dirname, '../migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    });
  }
  return migrationPromise;
}

export async function truncateAllTables(pool: Pool): Promise<void> {
  // Order respects FK dependencies. audit_log TRUNCATE is allowed (trigger only blocks UPDATE/DELETE).
  await pool.query(`
    TRUNCATE TABLE
      content_live,
      content_versions,
      required_clauses,
      reminder_send,
      comparison_runs,
      regulator_engagement_history,
      institution_engagement,
      institution_roles,
      institutions,
      message_recipients,
      message_batches,
      message_templates,
      invitation_requests,
      regulator_contacts,
      scoring_signoffs,
      firm_report_release_history,
      firm_reports,
      adversary_health,
      national_report_dispositions,
      national_report_findings,
      national_report_sentences,
      national_report_sections,
      national_reports,
      evidence_pack_facts,
      evidence_packs,
      calculated_results,
      eligibility_results,
      calculation_runs,
      metric_definitions,
      report_dependency,
      funnel_event,
      seat_assignments,
      firm_claims,
      respondent_drafts,
      firm_coordinators,
      outreach_links,
      governed_config,
      responses,
      respondents,
      edition_instrument_snapshots,
      edition_sample_floors,
      edition_participation,
      critical_actions,
      user_permissions,
      user_roles,
      role_permissions,
      audit_log,
      instrument_questions,
      instrument_definition_versions,
      instrument_definitions,
      editions,
      organizations,
      permissions,
      roles,
      users
    RESTART IDENTITY CASCADE
  `);
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
