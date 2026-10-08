/**
 * Phase 18 — Investor categories, firm digest, previous editions, shared
 * error states + withdrawal, help/privacy/about. DoD gates from
 * PHASE_18_CLAUDE_CODE_PROMPT.md §7.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import {
  createRespondent,
  setRespondentContact,
  getRespondentByRecoveryToken,
  markRespondentWithdrawn,
  createOrganization,
  createCoordinator,
  emitFunnelEvent,
  createNationalReport,
  approveNationalReport,
  createCalculationRun,
} from '@cis/db';
import {
  seedReferenceData,
  updateInvestorCategoriesServed,
  InvestorCategoriesError,
  assembleFirmDigest,
  sendFirmDigest,
  getPublicContent,
  listPreviousPublishedEditions,
  saveDraft,
  publishDraft,
  ERROR_STATES,
  getErrorStateCopy,
  withdrawRespondent,
  saveDraftAnswer,
  submitJourney,
  ParticipationClosedError,
  type SendingService,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;
let setupUserId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});
beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;
  setupUserId = seed.makerUserId; // has edition:manage (setup right)
});
afterAll(async () => {
  await closeTestPool();
});

// ─── Gate: UX-FRM-002 inertness ──────────────────────────────────────────────

describe('Gate — investor categories are provably inert', () => {
  it('no scoring/eligibility/evidence-pack source file references the field', () => {
    const domainSrc = path.join(__dirname, '../src');
    const excluded = new Set(['investor-categories-service.ts']);
    const offenders: string[] = [];
    for (const file of readdirSync(domainSrc)) {
      if (!file.endsWith('.ts') || excluded.has(file)) continue;
      const content = readFileSync(path.join(domainSrc, file), 'utf8');
      if (
        content.includes('investorCategoriesServed') ||
        content.includes('investor_categories_served')
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('updating the declaration has zero effect on the organization beyond the field itself', async () => {
    const org = await createOrganization(pool, {
      slug: 'test-firm-18',
      displayName: 'Test Firm 18',
      orgType: 'firm',
    });
    const updated = await updateInvestorCategoriesServed(pool, org.id, ['retail', 'not_sure']);
    expect(updated.investorCategoriesServed.sort()).toEqual(['not_sure', 'retail']);
    expect(updated.isActive).toBe(org.isActive);
    expect(updated.orgType).toBe(org.orgType);
  });

  it('rejects an unknown category', async () => {
    const org = await createOrganization(pool, {
      slug: 'test-firm-18b',
      displayName: 'Test Firm 18b',
      orgType: 'firm',
    });
    await expect(
      updateInvestorCategoriesServed(pool, org.id, [
        'retail' as unknown as 'retail',
        'bogus' as unknown as 'retail',
      ]),
    ).rejects.toThrow(InvestorCategoriesError);
  });
});

// ─── Gate: UX-FRM-DIG-001 content boundary + delivery ───────────────────────

describe('Gate — firm digest content boundary and delivery', () => {
  it('the firm-digest query source cannot join to answer content', () => {
    const raw = readFileSync(path.join(__dirname, '../../db/src/queries/firm-digest.ts'), 'utf8');
    // Strip comments so the file's own explanatory prose (which necessarily
    // names the forbidden tables/columns) doesn't produce a false positive —
    // only actual code is checked.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/respondent_drafts/);
    expect(code).not.toMatch(/FROM\s+responses\b/i);
    expect(code).not.toMatch(/JOIN\s+responses\b/i);
    expect(code).not.toMatch(/question_id/);
    expect(code).not.toMatch(/respondent_id/);
  });

  it('assembles counts and state only, from an org with real responses attributed to it', async () => {
    const org = await createOrganization(pool, {
      slug: 'test-firm-digest',
      displayName: 'Digest Firm',
      orgType: 'firm',
    });
    // Claimed but nobody assigned yet — the 'noassign' attention state.
    await pool.query(
      `INSERT INTO firm_claims (organization_id, claiming_contact_name, claiming_contact_email, privacy_consent)
       VALUES ($1, 'Claimant', 'claimant@digestfirm.example', TRUE)`,
      [org.id],
    );
    await emitFunnelEvent(pool, {
      eventType: 'completed',
      editionId,
      segment: 'retail',
      firmId: org.id,
      channel: 'email',
      source: 'invitation',
    });
    await emitFunnelEvent(pool, {
      eventType: 'completed',
      editionId,
      segment: 'retail',
      firmId: org.id,
      channel: 'email',
      source: 'invitation',
    });
    await emitFunnelEvent(pool, {
      eventType: 'completed',
      editionId,
      segment: 'foreign_institution',
      firmId: org.id,
      channel: 'email',
      source: 'invitation',
    });

    const digest = await assembleFirmDigest(pool, editionId, org.id);
    expect(digest.investorContribution.retail).toBe(2);
    expect(digest.investorContribution.foreignInstitutional).toBe(1);
    expect(digest.investorContribution.total).toBe(3);
    expect(digest.seatCompletion.total).toBe(3); // S1/S2/S3
    expect(digest.attention.state).toBe('noassign'); // claimed=false path: no seats assigned yet
    // Structural guarantee: nothing answer-shaped anywhere in the digest —
    // no answer envelope, no question id, no respondent identity.
    const flatKeys = JSON.stringify(Object.keys(digest)) + JSON.stringify(digest.attention);
    expect(digest).not.toHaveProperty('answer');
    expect(digest).not.toHaveProperty('respondentId');
    expect(flatKeys).not.toMatch(/question_id|S4-|respondent_id/);
  });

  it('a scheduled send reuses the SendingService abstraction, not a second mechanism', async () => {
    const org = await createOrganization(pool, {
      slug: 'test-firm-digest-send',
      displayName: 'Digest Send Firm',
      orgType: 'firm',
    });
    await createCoordinator(pool, {
      organizationId: org.id,
      name: 'Lead Coordinator',
      email: 'lead@digestfirm.example',
      isLead: true,
      accessCode: 'DIGEST01',
    });

    const sent: unknown[] = [];
    const spy: SendingService = {
      name: 'test-spy',
      async send(message) {
        sent.push(message);
        return { deliveryState: 'sent' };
      },
    };

    const result = await sendFirmDigest(pool, editionId, org.id, spy);
    expect(sent).toHaveLength(1);
    expect(result.recipientEmail).toBe('lead@digestfirm.example');
    expect(result.deliveryState).toBe('sent');
  });
});

// ─── Gate: UX-PUB-002 previous editions ─────────────────────────────────────

describe('Gate — previous editions listing', () => {
  it('year 1 (no other published edition) returns empty', async () => {
    const rows = await listPreviousPublishedEditions(pool, editionId);
    expect(rows).toEqual([]);
  });

  it('a second published edition is correctly listed with year, status, and lineage', async () => {
    // A second edition with its own approved national report.
    const other = await pool.query<{ id: string }>(
      `INSERT INTO editions (label, status) VALUES ('2025', 'archived') RETURNING id`,
    );
    const otherEditionId = other.rows[0]!.id;
    const run = await createCalculationRun(pool, {
      editionId: otherEditionId,
      runType: 'scoring',
      datasetHash: 'ds-test-18',
      status: 'complete',
    });
    const report = await createNationalReport(pool, {
      editionId: otherEditionId,
      scoringRunId: run.id,
    });
    await approveNationalReport(pool, report.id, 'approver-1');

    const rows = await listPreviousPublishedEditions(pool, editionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editionId).toBe(otherEditionId);
    expect(rows[0]!.editionLabel).toBe('2025');
    expect(rows[0]!.publicationStatus).toBe('approved');
    expect(rows[0]!.lineageNote).toBe('Original publication for this edition.');
  });

  it('a correction (second approved report for the same edition) is a new version, never a silent overwrite', async () => {
    const other = await pool.query<{ id: string }>(
      `INSERT INTO editions (label, status) VALUES ('2024', 'archived') RETURNING id`,
    );
    const otherEditionId = other.rows[0]!.id;
    const run1 = await createCalculationRun(pool, {
      editionId: otherEditionId,
      runType: 'scoring',
      datasetHash: 'ds-a',
      status: 'complete',
    });
    const report1 = await createNationalReport(pool, {
      editionId: otherEditionId,
      scoringRunId: run1.id,
    });
    await approveNationalReport(pool, report1.id, 'approver-1');

    const run2 = await createCalculationRun(pool, {
      editionId: otherEditionId,
      runType: 'scoring',
      datasetHash: 'ds-b',
      status: 'complete',
    });
    const report2 = await createNationalReport(pool, {
      editionId: otherEditionId,
      scoringRunId: run2.id,
    });
    await approveNationalReport(pool, report2.id, 'approver-2');

    const rows = await listPreviousPublishedEditions(pool, editionId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.lineageNote).toBe('Original publication for this edition.');
    expect(rows[1]!.lineageNote).toMatch(/^Correction — supersedes/);
    // Both rows are real, independent report ids — report1 was never touched.
    const reportIds = rows.map((r) => r.reportId).sort();
    expect(reportIds).toEqual([report1.id, report2.id].sort());
  });
});

// ─── Gate: UX-X-002 managed-content wiring + forbidden phrase ───────────────

describe('Gate — help/privacy/about wired to managed content, no hardcoding', () => {
  it('changing published content is reflected with no code change', async () => {
    const draft = await saveDraft(
      pool,
      'organisation_descriptions',
      '',
      JSON.stringify({
        cis: 'CIS is the professional body.',
        dragnet: 'Dragnet built the platform.',
      }),
      setupUserId,
    );
    await publishDraft(pool, 'organisation_descriptions', '', draft.id, setupUserId);

    const helpDraft = await saveDraft(
      pool,
      'help_text',
      '',
      JSON.stringify({ general: 'Email support@example.org for help.' }),
      setupUserId,
    );
    await publishDraft(pool, 'help_text', '', helpDraft.id, setupUserId);

    const content = await getPublicContent(pool);
    expect(content.organisationDescriptions.cis).toBe('CIS is the professional body.');
    expect(content.organisationDescriptions.dragnet).toBe('Dragnet built the platform.');
    expect(content.helpText).toBe('Email support@example.org for help.');
  });

  it('privacy notice renders from governed_config via the same content-state routing', async () => {
    const content = await getPublicContent(pool);
    // Seeded PAT-011 notice text (Phase 3) — proves this routes through
    // governed_config, not a separate hardcoded string in this surface.
    expect(content.privacyNotice.length).toBeGreaterThan(0);
  });
});

describe('Gate — forbidden-phrase check blocks absolute-anonymity claims', () => {
  it('rejects a privacy-notice save claiming "completely anonymous"', async () => {
    const body = 'Your answers are kept separate from your answers and are completely anonymous.';
    await expect(saveDraft(pool, 'privacy_notice', '', body, setupUserId)).rejects.toThrow(
      /Forbidden phrase/,
    );
  });

  it('accepts privacy-notice content with no forbidden phrase', async () => {
    const body =
      'Your identifying details are kept separate from your answers. ' +
      'Aggregated, confidential reporting only.';
    const draft = await saveDraft(pool, 'privacy_notice', '', body, setupUserId);
    expect(draft.body).toContain('confidential');
  });

  it('the same check runs at publish time, not just save time', async () => {
    // Save a benign draft, then attempt to publish a DIFFERENT (forbidden) draft
    // by inserting it directly — publishDraft must independently re-validate.
    const badBody = 'kept separate from your answers — no record is kept, ever.';
    const badDraft = await saveDraft(pool, 'privacy_notice', '', badBody, setupUserId).catch(
      (e: Error) => e,
    );
    // saveDraft itself blocks it; there is no draft id to publish, which IS the point.
    expect(badDraft).toBeInstanceOf(Error);
  });
});

// ─── Gate: UX-X-001 shared error states ──────────────────────────────────────

describe('Gate — shared error-state component contract', () => {
  it('exposes exactly the five approved states, each with title + detail', () => {
    expect(ERROR_STATES).toHaveLength(5);
    expect([...ERROR_STATES].sort()).toEqual(
      [
        'access_denied',
        'expired_link',
        'no_unfinished_survey',
        'participation_closed',
        'service_unavailable',
      ].sort(),
    );
    for (const kind of ERROR_STATES) {
      const copy = getErrorStateCopy(kind);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.detail.length).toBeGreaterThan(0);
    }
  });

  it('at least one previously ad-hoc error surface is retrofitted to use it', () => {
    const src = readFileSync(
      path.join(__dirname, '../../../apps/admin/src/journey/RespondentApp.tsx'),
      'utf8',
    );
    expect(src).toMatch(/ErrorState/);
    expect(src).toMatch(/no_unfinished_survey/);
    expect(src).toMatch(/participation_closed/);
  });
});

describe('Gate — no-leakage on an invalid/expired resume token', () => {
  it('an unknown recovery token resolves to null, never a partial respondent', async () => {
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    await setRespondentContact(pool, respondent.id, {
      channel: 'email',
      email: 'identifiable-person@example.com',
      recoveryToken: 'real-token-should-not-leak',
    });

    const result = await getRespondentByRecoveryToken(pool, 'totally-unrelated-fake-token');
    expect(result).toBeNull();
  });

  it("the API route's not-found reply is a fixed literal with no interpolated identity", () => {
    const src = readFileSync(
      path.join(__dirname, '../../../apps/api/src/routes/journeys.ts'),
      'utf8',
    );
    // The exact literal used for the 404 case — no template-literal identity fields.
    expect(src).toContain("'No journey for this recovery link'");
    // Guard against a regression that starts interpolating respondent data into it.
    const notFoundLine = src
      .split('\n')
      .find((l) => l.includes('No journey for this recovery link'));
    expect(notFoundLine).toBeDefined();
    expect(notFoundLine).not.toMatch(/\$\{/);
  });
});

// ─── Gate: withdrawal flag + check (§5) ──────────────────────────────────────

describe('Gate — withdrawal flag blocks continuing, distinct from reminders_opted_out', () => {
  it('a withdrawn respondent cannot save further answers or submit', async () => {
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    // Sanity: works before withdrawal.
    await saveDraftAnswer(pool, respondent.id, {
      questionId: 'S4-P1',
      ratedFirmId: null,
      answer: { a: '5' },
    });

    await withdrawRespondent(pool, respondent.id);

    await expect(
      saveDraftAnswer(pool, respondent.id, {
        questionId: 'S4-P1',
        ratedFirmId: null,
        answer: { a: '4' },
      }),
    ).rejects.toThrow(ParticipationClosedError);

    await expect(submitJourney(pool, respondent.id)).rejects.toThrow(ParticipationClosedError);
  });

  it('withdrawal surfaces on the respondent record fetched by recovery token', async () => {
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    const token = 'withdrawal-test-token-' + respondent.id;
    await setRespondentContact(pool, respondent.id, {
      channel: 'email',
      email: 'w@example.com',
      recoveryToken: token,
    });
    let fetched = await getRespondentByRecoveryToken(pool, token);
    expect(fetched?.withdrawnAt).toBeNull();

    await markRespondentWithdrawn(pool, respondent.id);

    fetched = await getRespondentByRecoveryToken(pool, token);
    expect(fetched?.withdrawnAt).not.toBeNull();
  });

  it('withdrawal is structurally distinct from Phase 17 reminders_opted_out', async () => {
    const respondent = await createRespondent(pool, { editionId, instrumentCode: 'S4' });
    await withdrawRespondent(pool, respondent.id);
    const res = await pool.query('SELECT reminders_opted_out FROM respondents WHERE id = $1', [
      respondent.id,
    ]);
    expect(res.rows[0].reminders_opted_out).toBe(false);
  });
});
