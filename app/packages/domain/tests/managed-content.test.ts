/**
 * UX-ADM-CNT-001 Managed Wording Admin — Phase 15 DoD.
 *
 *  - Content-area mapping: each area reads/writes to its correct underlying table
 *    (no duplicate content store for anything already in governed_config or message_templates).
 *  - Required-clause test: removing a load-bearing phrase blocks save even when field non-empty.
 *  - Versioning: two saves → two distinct versions; publishing an earlier-saved draft promotes
 *    exactly that version (not the most-recently edited text).
 *  - Permission: setup right (edition:manage) required; absent it, both save and publish throw.
 *  - Non-critical-action regression: wording publication does not appear in critical_actions.
 *  - Migration: invitation_landing content is present from seed (seeded in migration).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createUser,
  getConfig,
  getTemplateByName,
  listContentVersions,
  getLiveContent,
} from '@cis/db';
import {
  seedReferenceData,
  saveDraft,
  publishDraft,
  getContentState,
  ManagedContentPermissionError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let setupUserId: string;
let noRightsUserId: string;

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});

beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);

  // The seeded maker has edition:manage (setup right).
  setupUserId = seed.makerUserId;

  // Create a second user with no permissions for permission tests.
  const noRightsUser = await createUser(pool, {
    displayName: 'No Rights',
    email: 'no-rights@test.example',
    passwordHash: 'x',
  });
  noRightsUserId = noRightsUser.id;
});

afterAll(async () => {
  await closeTestPool();
});

// ─── Content-area mapping ─────────────────────────────────────────────────────

describe('Content-area mapping: privacy_notice wires to governed_config[consent.pat011]', () => {
  it('publishing a draft updates consent.pat011.notice in governed_config (no parallel store)', async () => {
    const before = await getConfig<{ notice: string }>(pool, 'consent.pat011');
    const original = before?.notice ?? '';

    const newNotice = `${original} kept separate from your answers.`;
    const draft = await saveDraft(pool, 'privacy_notice', '', newNotice, setupUserId);
    await publishDraft(pool, 'privacy_notice', '', draft.id, setupUserId);

    const after = await getConfig<{ notice: string }>(pool, 'consent.pat011');
    expect(after?.notice).toBe(newNotice);
  });

  it('saving a draft does NOT update consent.pat011 (save ≠ publish)', async () => {
    const before = await getConfig<{ notice: string }>(pool, 'consent.pat011');
    const draft = await saveDraft(
      pool,
      'privacy_notice',
      '',
      `New text kept separate from your answers.`,
      setupUserId,
    );
    const after = await getConfig<{ notice: string }>(pool, 'consent.pat011');
    // governed_config unchanged until publish
    expect(after?.notice).toBe(before?.notice);
    expect(draft.versionNumber).toBe(1);
  });
});

describe('Content-area mapping: participant_templates wires to message_templates', () => {
  it('publishing a draft updates the template body in message_templates', async () => {
    const subKey = 'Retail survey invitation';
    const before = await getTemplateByName(pool, subKey);
    expect(before).not.toBeNull();

    // New body preserves the required {{survey_link}} placeholder
    const newBody = `Updated invitation. Complete your survey: {{survey_link}}`;
    const draft = await saveDraft(pool, 'participant_templates', subKey, newBody, setupUserId);
    await publishDraft(pool, 'participant_templates', subKey, draft.id, setupUserId);

    const after = await getTemplateByName(pool, subKey);
    expect(after?.body).toBe(newBody);
  });
});

describe('Content-area mapping: invitation_landing is a standalone governed area', () => {
  it('is seeded from the migration and has a live version', async () => {
    const state = await getContentState(pool, 'invitation_landing', '');
    expect(state.liveBody).not.toBeNull();
    expect(state.liveBody).toContain('independent');
    expect(state.liveVersionId).not.toBeNull();
  });
});

// ─── Required-clause enforcement ─────────────────────────────────────────────

describe('Required-clause enforcement', () => {
  it('blocks save for privacy_notice when the required phrase is removed (field non-empty)', async () => {
    // "kept separate from your answers" is the seeded required clause for privacy_notice
    const body = 'This is fine wording but the key clause has been removed.';
    await expect(saveDraft(pool, 'privacy_notice', '', body, setupUserId)).rejects.toMatchObject({
      code: 'REQUIRED_CLAUSE_MISSING',
    });
  });

  it('allows save when the required phrase is present (even reworded)', async () => {
    const body = 'We keep your answers kept separate from your answers at all times.';
    const draft = await saveDraft(pool, 'privacy_notice', '', body, setupUserId);
    expect(draft.versionNumber).toBeGreaterThan(0);
  });

  it('blocks publish of a draft that would violate required clauses', async () => {
    // First, save a good draft
    const good = await saveDraft(
      pool,
      'privacy_notice',
      '',
      'Your data is kept separate from your answers.',
      setupUserId,
    );
    // Manually insert a bad version directly to simulate a draft that slipped through
    const { insertContentVersion } = await import('@cis/db');
    const bad = await insertContentVersion(
      pool,
      'privacy_notice',
      '',
      'This text is fine but violates the requirement.',
      setupUserId,
    );
    await expect(
      publishDraft(pool, 'privacy_notice', '', bad.id, setupUserId),
    ).rejects.toMatchObject({ code: 'REQUIRED_CLAUSE_MISSING' });
    // Good draft is still publishable
    await expect(
      publishDraft(pool, 'privacy_notice', '', good.id, setupUserId),
    ).resolves.toBeUndefined();
  });

  it('blocks save for participant_templates when {{survey_link}} is removed', async () => {
    const body = 'No link placeholder here — just some text.';
    await expect(
      saveDraft(pool, 'participant_templates', 'Retail survey invitation', body, setupUserId),
    ).rejects.toMatchObject({ code: 'REQUIRED_CLAUSE_MISSING' });
  });

  it('blocks save for invitation_landing when "independent" is removed', async () => {
    const body = 'The Capital Market Brokerage Benchmark is a great study.';
    await expect(
      saveDraft(pool, 'invitation_landing', '', body, setupUserId),
    ).rejects.toMatchObject({ code: 'REQUIRED_CLAUSE_MISSING' });
  });
});

// ─── Versioning ───────────────────────────────────────────────────────────────

describe('Versioning: every save creates a new retained draft; publish promotes exact draft', () => {
  it('two saves create two distinct versions, neither overwriting the other', async () => {
    const body1 = 'Version one text — independent benchmark study.';
    const body2 = 'Version two text — independent benchmark study.';
    const v1 = await saveDraft(pool, 'invitation_landing', '', body1, setupUserId);
    const v2 = await saveDraft(pool, 'invitation_landing', '', body2, setupUserId);

    expect(v1.id).not.toBe(v2.id);
    expect(v1.versionNumber).toBe(v2.versionNumber - 1);

    const versions = await listContentVersions(pool, 'invitation_landing', '');
    const found = versions.filter((v) => v.id === v1.id || v.id === v2.id);
    expect(found).toHaveLength(2);
  });

  it('publishing an earlier-saved draft promotes exactly that draft (not the most-recent)', async () => {
    const bodyFirst = 'First independent body.';
    const bodySecond = 'Second independent body.';
    const first = await saveDraft(pool, 'invitation_landing', '', bodyFirst, setupUserId);
    await saveDraft(pool, 'invitation_landing', '', bodySecond, setupUserId);

    // Publish the FIRST draft
    await publishDraft(pool, 'invitation_landing', '', first.id, setupUserId);

    const live = await getLiveContent(pool, 'invitation_landing', '');
    expect(live?.versionId).toBe(first.id);
    expect(live?.version.body).toBe(bodyFirst);
  });

  it('the version history is retained after publish — old drafts not deleted', async () => {
    const v1 = await saveDraft(
      pool,
      'invitation_landing',
      '',
      'First independent draft.',
      setupUserId,
    );
    const v2 = await saveDraft(
      pool,
      'invitation_landing',
      '',
      'Second independent draft.',
      setupUserId,
    );
    await publishDraft(pool, 'invitation_landing', '', v2.id, setupUserId);

    const versions = await listContentVersions(pool, 'invitation_landing', '');
    const ids = versions.map((v) => v.id);
    // Both v1 and v2 are retained even though v2 is live
    expect(ids).toContain(v1.id);
    expect(ids).toContain(v2.id);
  });
});

// ─── Permission ───────────────────────────────────────────────────────────────

describe('Permission: edition:manage (setup right) required', () => {
  it('saveDraft throws ManagedContentPermissionError for a user without setup right', async () => {
    const body = 'independent benchmark body text.';
    await expect(
      saveDraft(pool, 'invitation_landing', '', body, noRightsUserId),
    ).rejects.toBeInstanceOf(ManagedContentPermissionError);
  });

  it('publishDraft throws ManagedContentPermissionError for a user without setup right', async () => {
    // Setup user saves the draft first
    const body = 'independent benchmark body text.';
    const draft = await saveDraft(pool, 'invitation_landing', '', body, setupUserId);
    await expect(
      publishDraft(pool, 'invitation_landing', '', draft.id, noRightsUserId),
    ).rejects.toBeInstanceOf(ManagedContentPermissionError);
  });

  it('a user WITH edition:manage can save and publish', async () => {
    const body = 'independent benchmark body text.';
    const draft = await saveDraft(pool, 'invitation_landing', '', body, setupUserId);
    await expect(
      publishDraft(pool, 'invitation_landing', '', draft.id, setupUserId),
    ).resolves.toBeUndefined();
  });
});

// ─── Non-critical-action regression ──────────────────────────────────────────

describe('Non-critical-action regression: wording publication does NOT use critical_actions', () => {
  it('publishing wording creates no critical_action row', async () => {
    const draft = await saveDraft(
      pool,
      'invitation_landing',
      '',
      'independent benchmark.',
      setupUserId,
    );
    await publishDraft(pool, 'invitation_landing', '', draft.id, setupUserId);

    const { query } = await import('@cis/db');
    const result = await query<{ n: string }>(
      pool,
      "SELECT COUNT(*)::text AS n FROM critical_actions WHERE action_type LIKE '%wording%' OR action_type LIKE '%content%'",
    );
    expect(parseInt(result.rows[0]?.n ?? '0', 10)).toBe(0);
  });
});

// ─── Migration: invitation_landing seeded ────────────────────────────────────

describe('Migration: invitation_landing copy seeded from PublicLanding hardcoded text', () => {
  it('has a live version with the benchmark heading text', async () => {
    const state = await getContentState(pool, 'invitation_landing', '');
    expect(state.liveBody).toContain('Nigerian Capital Market Brokerage Benchmark');
  });

  it('has a live version with the independence lede', async () => {
    const state = await getContentState(pool, 'invitation_landing', '');
    expect(state.liveBody).toContain('independent read');
  });
});
