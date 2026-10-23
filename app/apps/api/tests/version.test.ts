/**
 * GET /version (D-06) — which build is running. The image build injects
 * GIT_COMMIT, IMAGE_TAG and BUILD_TIME; without them (local dev) the commit
 * comes from `git rev-parse HEAD` and the rest is "unknown". It never fails.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildServer } from '../src/server';
import { resolveBuildInfo } from '../src/build-info';

const KEYS = ['GIT_COMMIT', 'IMAGE_TAG', 'BUILD_TIME'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';

async function getVersion() {
  const app = await buildServer();
  try {
    await app.ready();
    return await app.inject({ method: 'GET', url: '/version' });
  } finally {
    await app.close();
  }
}

describe('GET /version', () => {
  it('reports the build args baked into the image', async () => {
    process.env['GIT_COMMIT'] = SHA;
    process.env['IMAGE_TAG'] = SHA;
    process.env['BUILD_TIME'] = '2026-10-22T14:05:00Z';

    const res = await getVersion();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      service: 'cis-api',
      commit: SHA,
      commitShort: '1a2b3c4',
      imageTag: SHA,
      buildTime: '2026-10-22T14:05:00.000Z',
    });
  });

  it('answers without authentication when the build args are unset', async () => {
    for (const k of KEYS) delete process.env[k];

    const res = await getVersion();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.service).toBe('cis-api');
    expect(body.imageTag).toBe('unknown');
    expect(body.buildTime).toBe('unknown');
    // The test runs inside the git checkout, so HEAD is found; elsewhere "unknown".
    expect(body.commit).toMatch(/^([0-9a-f]{40}|unknown)$/);
    expect(body.commitShort).toBe(body.commit === 'unknown' ? 'unknown' : body.commit.slice(0, 7));
  });
});

describe('resolveBuildInfo', () => {
  it('falls back to "unknown" when neither the env nor git has a commit', () => {
    expect(resolveBuildInfo({}, () => null)).toEqual({
      service: 'cis-api',
      commit: 'unknown',
      commitShort: 'unknown',
      imageTag: 'unknown',
      buildTime: 'unknown',
    });
  });

  it('never throws when the git lookup does', () => {
    const info = resolveBuildInfo({}, () => {
      throw new Error('git not installed');
    });
    expect(info.commit).toBe('unknown');
  });

  it('prefers GIT_COMMIT over git HEAD', () => {
    expect(resolveBuildInfo({ GIT_COMMIT: SHA }, () => 'f'.repeat(40)).commit).toBe(SHA);
  });

  it('rejects values that are not a sha, an image tag or a date', () => {
    const info = resolveBuildInfo(
      { GIT_COMMIT: 'not a sha', IMAGE_TAG: 'bad tag/with spaces', BUILD_TIME: 'yesterday' },
      () => null,
    );
    expect(info).toMatchObject({ commit: 'unknown', imageTag: 'unknown', buildTime: 'unknown' });
  });
});
