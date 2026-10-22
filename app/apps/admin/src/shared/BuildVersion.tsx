import { useEffect, useMemo, useState } from 'react';
import {
  adminBuild,
  fetchApiVersion,
  formatBuildLine,
  type ApiVersion,
  type BuildLine,
} from '../lib/buildVersion';

/** The build line for the running API and this admin bundle (D-06). */
export function useBuildLine(): BuildLine {
  const [api, setApi] = useState<ApiVersion | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchApiVersion().then((v) => {
      if (!cancelled) setApi(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(() => formatBuildLine(api, adminBuild()), [api]);
}

/** Small, muted "Build api … · admin … · image … · built …" line. */
export function BuildVersion(): JSX.Element {
  const { text, mismatch } = useBuildLine();
  return (
    <footer className={mismatch ? 'buildline mismatch' : 'buildline'} aria-label="Build version">
      {text}
    </footer>
  );
}
