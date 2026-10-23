import { execFileSync } from 'node:child_process';

/**
 * Which build of the API is running (D-06). The image build bakes GIT_COMMIT,
 * IMAGE_TAG and BUILD_TIME into the container's environment (see
 * apps/api/Dockerfile and the api-ci workflow). In local development they are
 * unset, so the commit falls back to `git rev-parse HEAD` and everything else
 * to "unknown". Resolving this never throws: GET /version must always answer.
 *
 * Only values that are safe to publish are returned — a commit sha, an image
 * tag and a timestamp — and each is validated, so a stray or mistyped build
 * arg can't leak arbitrary text through a public endpoint.
 */
export interface BuildInfo {
  service: 'cis-api';
  /** Full 40-character git sha, or "unknown". */
  commit: string;
  /** First 7 characters of the sha, or "unknown". */
  commitShort: string;
  /** The container image tag (CI pushes the commit sha), or "unknown". */
  imageTag: string;
  /** ISO-8601 build time in UTC, or "unknown". */
  buildTime: string;
}

export const UNKNOWN = 'unknown';

const SHA = /^[0-9a-f]{7,40}$/i;
// Docker tag grammar: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127}
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

let gitHeadCache: string | null | undefined;

/** `git rev-parse HEAD`, read once per process; null when git or the repo is absent. */
export function readGitHead(): string | null {
  if (gitHeadCache !== undefined) return gitHeadCache;
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    gitHeadCache = SHA.test(out) ? out.toLowerCase() : null;
  } catch {
    gitHeadCache = null;
  }
  return gitHeadCache;
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function resolveBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
  gitHead: () => string | null = readGitHead,
): BuildInfo {
  const envCommit = clean(env['GIT_COMMIT']);
  let commit = UNKNOWN;
  if (envCommit && SHA.test(envCommit)) {
    commit = envCommit.toLowerCase();
  } else {
    try {
      commit = gitHead() ?? UNKNOWN;
    } catch {
      commit = UNKNOWN;
    }
  }

  const tag = clean(env['IMAGE_TAG']);
  const imageTag = tag && IMAGE_TAG.test(tag) ? tag : UNKNOWN;

  const rawTime = clean(env['BUILD_TIME']);
  const parsed = rawTime ? Date.parse(rawTime) : Number.NaN;
  const buildTime = Number.isNaN(parsed) ? UNKNOWN : new Date(parsed).toISOString();

  return {
    service: 'cis-api',
    commit,
    commitShort: commit === UNKNOWN ? UNKNOWN : commit.slice(0, 7),
    imageTag,
    buildTime,
  };
}
