import { Pool } from 'pg';
import {
  createEdition,
  createUser,
  createRole,
  createPermission,
  assignRoleToUser,
  assignPermissionToRole,
  upsertSampleFloor,
  updateClosingDate,
  seedSurveyRegister,
  seedGovernedConfigDefaults,
  seedProvisionalMetricDefinitions,
  upsertReportDependency,
  seedAccessRights,
  getPermissionByCode,
  grantPermissionToUser,
  seedInvitationDefaults,
  seedInstitutions,
  seedInstitutionEngagement,
  seedMissionBoardDependencies,
  seedCandidateScoringConfig,
  seedManagedContentDefaults,
} from '@cis/db';
import { hashPassword } from '@cis/auth';
import { EDITION_MANAGE_PERMISSION, EDITION_LOCK_ACTION } from './edition-service';
import { INSTRUMENT_FREEZE_ACTION } from './instrument-service';

export interface SeededReferenceData {
  editionId: string;
  makerUserId: string;
  checkerUserId: string;
  roleId: string;
  /** instrument code → instrument_definition id */
  instruments: Record<string, string>;
}

/**
 * Seed the reference dataset for the 2026 edition: RBAC + two operator users,
 * the draft edition with sample floors, and the full controlled Survey Register
 * (nine instruments, 90 questions) via the shared register loader. Assumes a
 * clean/truncated schema. Not idempotent — callers that may re-run should guard.
 */
export async function seedReferenceData(pool: Pool): Promise<SeededReferenceData> {
  // ── RBAC ──────────────────────────────────────────────────────────────────
  const role = await createRole(pool, {
    name: 'study_operations',
    description: 'Study operations: manage edition, request and approve critical actions',
  });

  const managePerm = await createPermission(pool, {
    code: EDITION_MANAGE_PERMISSION,
    description: 'Edit edition floors and closing date',
    permissionType: 'standard',
  });
  const lockRequestPerm = await createPermission(pool, {
    code: 'edition:lock:request',
    permissionType: 'can_request_critical_action',
    actionScope: EDITION_LOCK_ACTION,
  });
  const lockApprovePerm = await createPermission(pool, {
    code: 'edition:lock:approve',
    permissionType: 'can_approve_critical_action',
    actionScope: EDITION_LOCK_ACTION,
  });
  const freezeRequestPerm = await createPermission(pool, {
    code: 'instrument:freeze:request',
    permissionType: 'can_request_critical_action',
    actionScope: INSTRUMENT_FREEZE_ACTION,
  });
  const freezeApprovePerm = await createPermission(pool, {
    code: 'instrument:freeze:approve',
    permissionType: 'can_approve_critical_action',
    actionScope: INSTRUMENT_FREEZE_ACTION,
  });

  for (const p of [
    managePerm,
    lockRequestPerm,
    lockApprovePerm,
    freezeRequestPerm,
    freezeApprovePerm,
  ]) {
    await assignPermissionToRole(pool, role.id, p.id);
  }

  // Two users. Both hold request + approve so either can be maker or checker;
  // the maker-checker constraint (a different person) still holds.
  const passwordHash = await hashPassword('ChangeMe!2026');
  const maker = await createUser(pool, {
    email: 'adaeze.okoro@cis.example',
    passwordHash,
    displayName: 'Adaeze Okoro',
    organization: 'CIS',
  });
  const checker = await createUser(pool, {
    email: 'segun.oyegbesan@dragnet.example',
    passwordHash,
    displayName: 'Segun Oyegbesan',
    organization: 'Dragnet',
  });
  await assignRoleToUser(pool, maker.id, role.id, null);
  await assignRoleToUser(pool, checker.id, role.id, null);

  // ── Edition (draft) ─────────────────────────────────────────────────────────
  const edition = await createEdition(pool, { label: '2026' });
  await updateClosingDate(pool, edition.id, new Date('2026-11-30T00:00:00.000Z'));
  await upsertSampleFloor(pool, { editionId: edition.id, category: 'firm', floorValue: 80 });
  await upsertSampleFloor(pool, { editionId: edition.id, category: 'retail', floorValue: 1111 });
  await upsertSampleFloor(pool, {
    editionId: edition.id,
    category: 'local_institution',
    floorValue: 25,
  });
  await upsertSampleFloor(pool, {
    editionId: edition.id,
    category: 'foreign_institution',
    floorValue: 15,
  });

  // ── Governed content/parameters ──────────────────────────────────────────────
  // Consent copy (legally provisional, OPEN-003) and the recovery-link TTL are
  // governed data, not hardcoded constants — seed their defaults here.
  await seedGovernedConfigDefaults(pool);

  // ── Provisional scoring methodology (Phase 5) ────────────────────────────────
  // Clearly-marked placeholder (equal weighting, no settled question mapping).
  // NOT Dragnet's validated methodology — replaced by a new metric_definitions
  // version once approved, no code deploy needed.
  await seedProvisionalMetricDefinitions(pool);

  // ── Report-dependency configuration (Phase 5) ────────────────────────────────
  // Editable runtime config; seeded with the guaranteed vs. gated report outputs.
  await upsertReportDependency(pool, {
    outputId: 'PUBLIC_REPORT',
    dependsOn: ['retail'],
    sufficiencyRule: 'all_sufficient',
  });
  await upsertReportDependency(pool, {
    outputId: 'FIRM_REPORT.FRM_04',
    dependsOn: ['retail'],
    sufficiencyRule: 'all_sufficient',
  });
  await upsertReportDependency(pool, {
    outputId: 'PUBLIC_REPORT.PUB_10',
    dependsOn: ['local_institution', 'foreign_institution'],
    sufficiencyRule: 'any_sufficient',
  });

  // ── Access rights (Phase 8) ───────────────────────────────────────────────
  // The seven canonical right→permission rows for the People & Access surface,
  // plus the bootstrap grants that make the two operators proper "people" on it:
  // both hold request + approve directly, so the estate opens at exactly the
  // two-approver floor (a coherent starting roster the surface itself manages).
  await seedAccessRights(pool);
  const grant = async (userId: string, codes: string[]): Promise<void> => {
    for (const code of codes) {
      const perm = await getPermissionByCode(pool, code);
      if (perm) await grantPermissionToUser(pool, userId, perm.id, null);
    }
  };
  await grant(maker.id, [
    'access:view',
    'access:send',
    'access:regs',
    'edition:manage',
    'critical:request',
    'critical:approve',
  ]);
  await grant(checker.id, [
    'access:view',
    'access:send',
    'edition:manage',
    'critical:request',
    'critical:approve',
    'access:dragnet',
  ]);

  // ── Invitation templates + regulator contacts (Phase 9) ──────────────────────
  // Six per-firm-state templates and the three provisional regulator contacts.
  await seedInvitationDefaults(pool, edition.id);

  // ── Institutional instrument families (Phase 19) ─────────────────────────────
  // Idempotent re-seed of the institutions/roles the migration also seeds —
  // needed here (not just once, at migration time) so test suites that
  // truncate and reseed on every run start from a complete roster.
  await seedInstitutions(pool);

  // ── Mission board (Phase 10) ─────────────────────────────────────────────────
  // Ten reporting-dependency rows (brief §3.3), and one engagement row per
  // (institution, family) role, seeded structurally with NO target_by
  // (DECISION NEEDED).
  await seedMissionBoardDependencies(pool);
  await seedInstitutionEngagement(pool, edition.id);

  // ── Candidate scoring methodology (Phase 11) ──────────────────────────────────
  // CIS-SCORE-2026 v0.15 candidate config, persisted from its authoritative YAML
  // as version 15 / is_active=FALSE (TEST_UNAPPROVED — never the active config).
  await seedCandidateScoringConfig(pool);

  // ── Managed wording defaults (Phase 15) ──────────────────────────────────────
  // Required clauses, participant templates, and initial invitation_landing live version.
  await seedManagedContentDefaults(pool, edition.id, maker.id);

  // ── Controlled Survey Register (9 instruments, 90 questions) ──────────────────
  const instruments = await seedSurveyRegister(pool, maker.id);

  return {
    editionId: edition.id,
    makerUserId: maker.id,
    checkerUserId: checker.id,
    roleId: role.id,
    instruments,
  };
}
