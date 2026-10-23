/**
 * Which build is running (D-06): the API's, from GET /api/version, and this
 * admin bundle's own, compiled in at `vite build`. Admin and API ship as
 * separate images, so both are shown and a mismatch is called out.
 */

export const UNKNOWN = 'unknown';

/** One image's build stamp. Every field is a value or "unknown". */
export interface BuildStamp {
  commit: string;
  commitShort: string;
  imageTag: string;
  buildTime: string;
}

/** GET /api/version. */
export interface ApiVersion extends BuildStamp {
  service: string;
}

const SHA = /^[0-9a-f]{7,40}$/i;

function stamp(commit?: string, imageTag?: string, buildTime?: string): BuildStamp {
  const c = commit?.trim() && SHA.test(commit.trim()) ? commit.trim().toLowerCase() : UNKNOWN;
  const time = buildTime?.trim() ? Date.parse(buildTime.trim()) : Number.NaN;
  return {
    commit: c,
    commitShort: c === UNKNOWN ? UNKNOWN : c.slice(0, 7),
    imageTag: imageTag?.trim() || UNKNOWN,
    buildTime: Number.isNaN(time) ? UNKNOWN : new Date(time).toISOString(),
  };
}

/** This admin bundle's build stamp, as compiled in by Vite. */
export function adminBuild(
  env: {
    VITE_GIT_COMMIT?: string | undefined;
    VITE_IMAGE_TAG?: string | undefined;
    VITE_BUILD_TIME?: string | undefined;
  } = import.meta.env,
): BuildStamp {
  return stamp(env.VITE_GIT_COMMIT, env.VITE_IMAGE_TAG, env.VITE_BUILD_TIME);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "22 Oct 2026 14:05 UTC" — UTC, so every operator reads the same time. */
export function formatBuildTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return UNKNOWN;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

export interface BuildLine {
  /** e.g. "Build api 1a2b3c4 · admin 1a2b3c4 · image <tag> · built 22 Oct 2026 14:05 UTC" */
  text: string;
  /** Both commits are known and differ: the admin and API images are from different builds. */
  mismatch: boolean;
}

/**
 * The one-line build summary. `api` is null while /version is loading or when
 * it could not be reached. The image tag and build time are the API's; the
 * admin's are added only when they differ.
 */
export function formatBuildLine(api: ApiVersion | null, admin: BuildStamp): BuildLine {
  const parts = [
    `Build api ${api ? api.commitShort : 'unavailable'}`,
    `admin ${admin.commitShort}`,
  ];

  const apiTag = api?.imageTag ?? UNKNOWN;
  if (admin.imageTag !== UNKNOWN && admin.imageTag !== apiTag) {
    parts.push(`image api ${apiTag} / admin ${admin.imageTag}`);
  } else {
    parts.push(`image ${apiTag}`);
  }

  const apiBuilt = api ? formatBuildTime(api.buildTime) : UNKNOWN;
  const adminBuilt = formatBuildTime(admin.buildTime);
  if (adminBuilt !== UNKNOWN && adminBuilt !== apiBuilt) {
    parts.push(`built api ${apiBuilt} / admin ${adminBuilt}`);
  } else {
    parts.push(`built ${apiBuilt}`);
  }

  const mismatch =
    !!api && api.commit !== UNKNOWN && admin.commit !== UNKNOWN && api.commit !== admin.commit;
  if (mismatch) parts.push('admin and API are from different builds');

  return { text: parts.join(' · '), mismatch };
}

let apiVersionRequest: Promise<ApiVersion | null> | null = null;

/**
 * GET /api/version, fetched once per page load and shared by every caller
 * (the footer and the Mail page). A failed request resolves to null and is
 * retried on the next call.
 */
export function fetchApiVersion(fetchFn: typeof fetch = fetch): Promise<ApiVersion | null> {
  if (!apiVersionRequest) {
    apiVersionRequest = fetchFn('/api/version', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Partial<ApiVersion>;
        return {
          service: String(body.service ?? 'cis-api'),
          ...stamp(body.commit, body.imageTag, body.buildTime),
        };
      })
      .catch(() => {
        apiVersionRequest = null;
        return null;
      });
  }
  return apiVersionRequest;
}
