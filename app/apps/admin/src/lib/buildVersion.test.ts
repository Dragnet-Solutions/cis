/**
 * The operator footer's build line (D-06): the API's and the admin bundle's
 * build, so an admin/API image mismatch is visible at a glance.
 */
import { describe, it, expect } from 'vitest';
import {
  adminBuild,
  fetchApiVersion,
  formatBuildLine,
  formatBuildTime,
  type ApiVersion,
} from './buildVersion';

const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const OTHER = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

const api = (over: Partial<ApiVersion> = {}): ApiVersion => ({
  service: 'cis-api',
  commit: SHA,
  commitShort: SHA.slice(0, 7),
  imageTag: SHA,
  buildTime: '2026-10-22T14:05:00.000Z',
  ...over,
});

describe('formatBuildTime', () => {
  it('formats in UTC as "22 Oct 2026 14:05 UTC"', () => {
    expect(formatBuildTime('2026-10-22T14:05:59Z')).toBe('22 Oct 2026 14:05 UTC');
    expect(formatBuildTime('2026-01-03T04:07:00+01:00')).toBe('3 Jan 2026 03:07 UTC');
  });

  it('says "unknown" for anything that is not a date', () => {
    expect(formatBuildTime('unknown')).toBe('unknown');
    expect(formatBuildTime('')).toBe('unknown');
  });
});

describe('adminBuild', () => {
  it('reads the Vite build values', () => {
    expect(
      adminBuild({
        VITE_GIT_COMMIT: SHA.toUpperCase(),
        VITE_IMAGE_TAG: SHA,
        VITE_BUILD_TIME: '2026-10-22T14:05:00Z',
      }),
    ).toEqual({
      commit: SHA,
      commitShort: '1a2b3c4',
      imageTag: SHA,
      buildTime: '2026-10-22T14:05:00.000Z',
    });
  });

  it('falls back to "unknown" when built without them (local dev)', () => {
    expect(adminBuild({ VITE_GIT_COMMIT: '', VITE_BUILD_TIME: 'soon' })).toEqual({
      commit: 'unknown',
      commitShort: 'unknown',
      imageTag: 'unknown',
      buildTime: 'unknown',
    });
  });
});

describe('formatBuildLine', () => {
  const sameAdmin = adminBuild({
    VITE_GIT_COMMIT: SHA,
    VITE_IMAGE_TAG: SHA,
    VITE_BUILD_TIME: '2026-10-22T14:05:00Z',
  });

  it('shows one image tag and build time when admin and API match', () => {
    expect(formatBuildLine(api(), sameAdmin)).toEqual({
      text: `Build api 1a2b3c4 · admin 1a2b3c4 · image ${SHA} · built 22 Oct 2026 14:05 UTC`,
      mismatch: false,
    });
  });

  it('flags admin and API images from different builds', () => {
    const admin = adminBuild({
      VITE_GIT_COMMIT: OTHER,
      VITE_IMAGE_TAG: OTHER,
      VITE_BUILD_TIME: '2026-10-21T09:00:00Z',
    });
    const line = formatBuildLine(api(), admin);
    expect(line.mismatch).toBe(true);
    expect(line.text).toBe(
      `Build api 1a2b3c4 · admin 9f8e7d6 · image api ${SHA} / admin ${OTHER}` +
        ' · built api 22 Oct 2026 14:05 UTC / admin 21 Oct 2026 09:00 UTC' +
        ' · admin and API are from different builds',
    );
  });

  it('does not call it a mismatch when one side is unknown (local dev)', () => {
    const line = formatBuildLine(
      api({ imageTag: 'unknown', buildTime: 'unknown' }),
      adminBuild({}),
    );
    expect(line).toEqual({
      text: 'Build api 1a2b3c4 · admin unknown · image unknown · built unknown',
      mismatch: false,
    });
  });

  it('says the API is unavailable when /version could not be read', () => {
    expect(formatBuildLine(null, sameAdmin).text).toBe(
      `Build api unavailable · admin 1a2b3c4 · image api unknown / admin ${SHA}` +
        ' · built api unknown / admin 22 Oct 2026 14:05 UTC',
    );
  });
});

describe('fetchApiVersion', () => {
  it('fetches /api/version once and shares the result', async () => {
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      return new Response(JSON.stringify(api()), { status: 200 });
    }) as typeof fetch;
    const [a, b] = await Promise.all([fetchApiVersion(fake), fetchApiVersion(fake)]);
    expect(calls).toBe(1);
    expect(a).toEqual(api());
    expect(b).toBe(a);
  });
});
