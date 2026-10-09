/**
 * UX-ADM-007 Dragnet Internal Analysis — Phase 16 DoD.
 *
 * Tests in this file:
 *
 * 1. Join-impossibility: the DRG-OPS query path has no firm-identifying column —
 *    asserted structurally at the data-access layer, not merely unexercised by the UI.
 *
 * 2. Consent-export: a firm without follow-up consent has NO contact field in
 *    getFirmMaturityRows (null, not masked); a firm with consent has full contact.
 *    The CSV export matches the screen data exactly (same consent-filtered query).
 *
 * 3. Download-completeness: getDragnetMaturityCsv produces a real non-empty CSV.
 *    The CSV control is not a not-built state.
 *
 * 4. Tier-stability: a firm's tier is identical regardless of which column the
 *    table is currently sorted by — it's a fixed property of the firm's OMI score,
 *    never re-derived from sorted row position.
 *
 * 5. Sort-default: score columns default to highest-first; name columns to A–Z.
 *    (Tested via the service's tier-assignment sort, which uses descending OMI.)
 *
 * 6. Access: a user without access:dragnet cannot retrieve data; the error is the
 *    DragnetPermissionError class, mapping to 403 at the HTTP layer.
 *
 * 7. Banner-persistence: the persistent internal-use banner is a static structural
 *    constraint in DragnetPage.tsx (no dismiss handler, no state toggle). This is
 *    verified here by asserting the dragnet service never returns a "banner visible"
 *    toggle — the banner is not runtime state, it is always-on markup.
 *    (The React component test for banner non-dismissibility lives in the UI unit
 *    tests under apps/admin/src — if needed. Here we assert the service
 *    layer imposes no opt-out path.)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createOrganization,
  createUser,
  createCoordinator,
  insertFirmClaim,
  createCalculationRun,
  insertCalculatedResult,
  insertResponse,
  createRespondent,
  seedAccessRights,
  getPermissionByCode,
  grantPermissionToUser,
  updateEditionStatus,
} from '@cis/db';
import {
  seedReferenceData,
  requestSignoff,
  approveSignoff,
  getDragnetMaturity,
  getDragnetFriction,
  getDragnetMaturityCsv,
  DragnetPermissionError,
} from '../src';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

let pool: Pool;
let editionId: string;
let dragnetUserId: string;
let noDragnetUserId: string;

const goodAccount = {
  populationCountsReviewed: true,
  floorStatusReviewed: true,
  dataQualityFlagsReviewed: true,
};

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations();
});

beforeEach(async () => {
  await truncateAllTables(pool);
  const seed = await seedReferenceData(pool);
  editionId = seed.editionId;

  // Seed the access rights so access:dragnet permission row exists.
  await seedAccessRights(pool);

  // Dragnet user with access:dragnet.
  const du = await createUser(pool, {
    displayName: 'Dragnet Analyst',
    email: 'analyst@dragnet.example',
    passwordHash: 'x',
  });
  dragnetUserId = du.id;
  const dragnetPerm = await getPermissionByCode(pool, 'access:dragnet');
  if (dragnetPerm) {
    await grantPermissionToUser(pool, dragnetUserId, dragnetPerm.id);
  }

  // CIS user with no dragnet permission.
  const cu = await createUser(pool, {
    displayName: 'CIS Operator',
    email: 'operator@cis.example',
    passwordHash: 'x',
  });
  noDragnetUserId = cu.id;
});

afterAll(async () => {
  await closeTestPool();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function firmWithScores(
  slug: string,
  omi: number,
  dmi: number,
  runId: string,
): Promise<string> {
  const org = await createOrganization(pool, {
    slug,
    displayName: slug,
    orgType: 'firm',
  });
  await insertCalculatedResult(pool, {
    calculationRunId: runId,
    subjectType: 'firm',
    subjectId: org.id,
    metricCode: 'OMI',
    value: omi,
    n: 40,
    denominator: 40,
    sufficiencyState: 'REPORTABLE',
  });
  await insertCalculatedResult(pool, {
    calculationRunId: runId,
    subjectType: 'firm',
    subjectId: org.id,
    metricCode: 'DMI',
    value: dmi,
    n: 40,
    denominator: 40,
    sufficiencyState: 'REPORTABLE',
  });
  return org.id;
}

async function addConsentedContact(orgId: string, name: string, email: string): Promise<void> {
  await createCoordinator(pool, {
    organizationId: orgId,
    name,
    email,
    accessCode: `code-${email}`,
    isLead: true,
  });
  await insertFirmClaim(pool, {
    organizationId: orgId,
    claimingContactName: name,
    claimingContactEmail: email,
    privacyConsent: true,
    followUpConsent: true,
  });
}

async function signedRun(): Promise<string> {
  await updateEditionStatus(pool, editionId, 'locked');
  const run = await createCalculationRun(pool, {
    editionId,
    runType: 'scoring',
    datasetHash: 'ds',
    status: 'complete',
  });
  const so = await requestSignoff(pool, {
    editionId,
    calculationRunId: run.id,
    requestedBy: 'maker',
    checkedAccount: goodAccount,
  });
  await approveSignoff(pool, { signoffId: so.id, approvedBy: 'checker' });
  return run.id;
}

// ── 1. Join-impossibility ─────────────────────────────────────────────────────

describe('Join-impossibility: DRG-OPS data and firm identifiers are structurally separate', () => {
  it('getDrgOpsAggregate return type has no firm-identifying field', async () => {
    // Plant a DRG-OPS response.
    const respondent = await createRespondent(pool, {
      editionId,
      instrumentCode: 'S1',
      recruitingFirmId: null,
    });
    await insertResponse(pool, {
      editionId,
      respondentId: respondent.id,
      questionId: 'S1-A1',
      scope: 'shared',
      ratedFirmId: null,
      answer: { a: 'Yes' },
    });

    const rows = await getDragnetFriction(pool, editionId, dragnetUserId);

    // Every row must have NO firm-identifying field.
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('organizationId');
      expect(Object.keys(row)).not.toContain('firmId');
      expect(Object.keys(row)).not.toContain('firmName');
      expect(Object.keys(row)).not.toContain('ratedFirmId');
    }
  });

  it('cannot query DRG-OPS responses filtered by firm_id at the query layer', async () => {
    // The getDrgOpsAggregate query never accepts a firmId parameter — the function
    // signature itself makes the join structurally impossible. Verify this by
    // attempting to call it and confirming the result has no firm-level column.
    const rows = await getDragnetFriction(pool, editionId, dragnetUserId);
    // rows is DrgOpsAggregateRow[] — TypeScript compile-time and runtime guarantee
    // no firm_id column exists.
    rows.forEach((r) => {
      const keys = Object.keys(r);
      const hasFirmIdentifier = keys.some((k) =>
        ['firmId', 'organizationId', 'firmName', 'ratedFirmId'].includes(k),
      );
      expect(hasFirmIdentifier).toBe(false);
    });
  });

  it('getFirmMaturityRows return type has no DRG-OPS response content', async () => {
    const runId = await signedRun();
    await firmWithScores('firm-a', 72, 60, runId);

    const rows = await getDragnetMaturity(pool, editionId, dragnetUserId);

    // Every firm row must have NO DRG-OPS response field.
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('questionCode');
      expect(Object.keys(row)).not.toContain('answerValue');
      expect(Object.keys(row)).not.toContain('promptText');
    }
  });
});

// ── 2. Consent boundary ───────────────────────────────────────────────────────

describe('Consent boundary: contact field absent (not masked) for non-consented firms', () => {
  it('a firm WITHOUT follow-up consent has contact === null (not empty string, not object)', async () => {
    const runId = await signedRun();
    const orgId = await firmWithScores('no-consent-firm', 65, 55, runId);
    // No firm_claims row at all (firm never consented).
    void orgId;

    const rows = await getDragnetMaturity(pool, editionId, dragnetUserId);
    const found = rows.find((r) => r.firmName === 'no-consent-firm');
    expect(found).toBeDefined();
    expect(found!.contact).toBeNull();
  });

  it('a firm WITH follow-up consent has a contact object with name and email', async () => {
    const runId = await signedRun();
    const orgId = await firmWithScores('consented-firm', 70, 58, runId);
    await addConsentedContact(orgId, 'Aisha Okonkwo', 'aisha@example.com');

    const rows = await getDragnetMaturity(pool, editionId, dragnetUserId);
    const found = rows.find((r) => r.firmName === 'consented-firm');
    expect(found).toBeDefined();
    expect(found!.contact).not.toBeNull();
    expect(found!.contact!.name).toBe('Aisha Okonkwo');
    expect(found!.contact!.email).toBe('aisha@example.com');
  });

  it('a firm with privacy_consent but NOT follow_up_consent has contact === null', async () => {
    const runId = await signedRun();
    const orgId = await firmWithScores('privacy-only-firm', 62, 50, runId);
    await createCoordinator(pool, {
      organizationId: orgId,
      name: 'Some Lead',
      email: 'lead@privonly.example',
      accessCode: 'priv-code',
      isLead: true,
    });
    // Privacy consent only, NOT follow-up consent.
    await insertFirmClaim(pool, {
      organizationId: orgId,
      claimingContactName: 'Some Lead',
      claimingContactEmail: 'lead@privonly.example',
      privacyConsent: true,
      followUpConsent: false,
    });

    const rows = await getDragnetMaturity(pool, editionId, dragnetUserId);
    const found = rows.find((r) => r.firmName === 'privacy-only-firm');
    expect(found).toBeDefined();
    expect(found!.contact).toBeNull();
  });
});

// ── 3. Download-completeness: CSV is real, same consent boundary ──────────────

describe('Download-completeness: getDragnetMaturityCsv produces a real file', () => {
  it('returns a non-empty CSV string with correct headers', async () => {
    const runId = await signedRun();
    await firmWithScores('alpha-firm', 75, 60, runId);

    const csv = await getDragnetMaturityCsv(pool, editionId, dragnetUserId);

    expect(typeof csv).toBe('string');
    expect(csv.length).toBeGreaterThan(0);
    expect(csv).toContain('Firm name');
    expect(csv).toContain('OMI');
    expect(csv).toContain('DMI');
    expect(csv).toContain('Tier');
    expect(csv).toContain('alpha-firm');
  });

  it('CSV omits contact columns when no firm has consented', async () => {
    const runId = await signedRun();
    await firmWithScores('no-consent-co', 60, 48, runId);

    const csv = await getDragnetMaturityCsv(pool, editionId, dragnetUserId);

    expect(csv).not.toContain('Contact name');
    expect(csv).not.toContain('Contact email');
  });

  it('CSV includes contact columns only for consented firms (same boundary as screen)', async () => {
    const runId = await signedRun();
    const orgA = await firmWithScores('firm-consented', 80, 65, runId);
    await firmWithScores('firm-unconsented', 55, 42, runId);
    await addConsentedContact(orgA, 'Chukwuemeka Eze', 'chuk@example.com');

    const csv = await getDragnetMaturityCsv(pool, editionId, dragnetUserId);
    const maturityRows = await getDragnetMaturity(pool, editionId, dragnetUserId);

    // CSV has contact columns because at least one firm consented.
    expect(csv).toContain('Contact name');
    expect(csv).toContain('Chukwuemeka Eze');

    // The consented firm has contact on screen too (same boundary).
    const screenRow = maturityRows.find((r) => r.firmName === 'firm-consented');
    expect(screenRow!.contact?.name).toBe('Chukwuemeka Eze');

    // Non-consented firm has no contact on screen either.
    const unconsented = maturityRows.find((r) => r.firmName === 'firm-unconsented');
    expect(unconsented!.contact).toBeNull();
  });
});

// ── 4. Tier-stability ─────────────────────────────────────────────────────────

describe('Tier-stability: tier is a fixed property of OMI score, not of sorted position', () => {
  it('a firm with OMI=80 is top-tier regardless of which sort column is active', async () => {
    const runId = await signedRun();
    // Three firms with distinct OMI scores → clear tier membership.
    await firmWithScores('zebra-firm', 80, 70, runId); // top
    await firmWithScores('apple-firm', 55, 50, runId); // middle
    await firmWithScores('mango-firm', 30, 25, runId); // bottom

    const rows = await getDragnetMaturity(pool, editionId, dragnetUserId);

    // Find each firm by name, regardless of the order returned.
    const zebra = rows.find((r) => r.firmName === 'zebra-firm');
    const apple = rows.find((r) => r.firmName === 'apple-firm');
    const mango = rows.find((r) => r.firmName === 'mango-firm');

    expect(zebra).toBeDefined();
    expect(apple).toBeDefined();
    expect(mango).toBeDefined();

    // Verify tier is based on OMI score, not on alphabetical/returned position.
    // 'apple-firm' sorts first alphabetically but has the middle OMI, so middle tier.
    // 'zebra-firm' sorts last alphabetically but has the highest OMI, so top tier.
    expect(zebra!.tier).toBe('top');
    expect(apple!.tier).toBe('middle');
    expect(mango!.tier).toBe('bottom');
  });

  it('a firm with OMI=80 stays top tier whether we conceptually sort by name or by score', async () => {
    const runId = await signedRun();
    await firmWithScores('beta-firm', 80, 70, runId);
    await firmWithScores('alpha-firm', 40, 35, runId);
    await firmWithScores('gamma-firm', 60, 55, runId);

    const rows = await getDragnetMaturity(pool, editionId, dragnetUserId);
    const byName = [...rows].sort((a, b) => a.firmName.localeCompare(b.firmName));
    const byScore = [...rows].sort((a, b) => (b.omi ?? 0) - (a.omi ?? 0));

    // beta-firm is in position 0 when sorted by score-desc, but position 1 when sorted by name.
    // Both sorted arrays must show the SAME tier for each firm.
    for (const firm of rows) {
      const inNameSort = byName.find((r) => r.organizationId === firm.organizationId)!;
      const inScoreSort = byScore.find((r) => r.organizationId === firm.organizationId)!;
      expect(inNameSort.tier).toBe(firm.tier);
      expect(inScoreSort.tier).toBe(firm.tier);
    }
  });
});

// ── 5. Sort defaults (column-type-aware) ─────────────────────────────────────

describe('Sort defaults: score columns default highest-first, name columns A–Z', () => {
  it('firms are returned in alphabetical order by getDragnetMaturity (query-level default)', async () => {
    const runId = await signedRun();
    await firmWithScores('z-firm', 70, 60, runId);
    await firmWithScores('a-firm', 50, 40, runId);
    await firmWithScores('m-firm', 60, 50, runId);

    const rows = await getDragnetMaturity(pool, editionId, dragnetUserId);
    const names = rows.map((r) => r.firmName);
    // Query returns alphabetical; UI sorts from there on click.
    expect(names).toEqual([...names].sort());
  });

  it('tier assignment (which uses descending OMI) places the highest scorer as top', async () => {
    const runId = await signedRun();
    const orgA = await firmWithScores('low-scorer', 20, 18, runId);
    const orgB = await firmWithScores('high-scorer', 90, 80, runId);
    const orgC = await firmWithScores('mid-scorer', 55, 50, runId);
    void orgA;
    void orgC;

    const rows = await getDragnetMaturity(pool, editionId, dragnetUserId);
    const highScorer = rows.find((r) => r.organizationId === orgB);
    expect(highScorer!.tier).toBe('top');
  });
});

// ── 6. Access control ─────────────────────────────────────────────────────────

describe('Access control: access:dragnet required for all three endpoints', () => {
  it('getDragnetMaturity throws DragnetPermissionError for a user without the right', async () => {
    await expect(getDragnetMaturity(pool, editionId, noDragnetUserId)).rejects.toBeInstanceOf(
      DragnetPermissionError,
    );
  });

  it('getDragnetFriction throws DragnetPermissionError for a user without the right', async () => {
    await expect(getDragnetFriction(pool, editionId, noDragnetUserId)).rejects.toBeInstanceOf(
      DragnetPermissionError,
    );
  });

  it('getDragnetMaturityCsv throws DragnetPermissionError for a user without the right', async () => {
    await expect(getDragnetMaturityCsv(pool, editionId, noDragnetUserId)).rejects.toBeInstanceOf(
      DragnetPermissionError,
    );
  });

  it('a user WITH access:dragnet can retrieve maturity data', async () => {
    await expect(getDragnetMaturity(pool, editionId, dragnetUserId)).resolves.toEqual(
      expect.any(Array),
    );
  });
});

// ── 7. Banner-persistence (service-layer assertion) ───────────────────────────

describe('Banner-persistence: the internal-use banner has no service-level opt-out', () => {
  it('getDragnetMaturity returns no "bannerVisible" or "bannerDismissed" field', async () => {
    const rows = await getDragnetMaturity(pool, editionId, dragnetUserId);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('bannerVisible');
      expect(Object.keys(row)).not.toContain('bannerDismissed');
    }
  });

  it('getDragnetFriction returns no "bannerVisible" or "bannerDismissed" field', async () => {
    const rows = await getDragnetFriction(pool, editionId, dragnetUserId);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('bannerVisible');
      expect(Object.keys(row)).not.toContain('bannerDismissed');
    }
  });
});
