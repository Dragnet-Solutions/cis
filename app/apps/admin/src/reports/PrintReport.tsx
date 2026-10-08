import { useCallback, useMemo } from 'react';
import { createClient } from '../api/client';
import { FirmReport } from './FirmReport';
import { IndustryReport } from './IndustryReport';
import { operatorFirmSource } from './source';

/**
 * The page the API's PDF renderer prints (apps/api/src/pdf/report-pdf.ts):
 * `/print/industry?edition=…` or `/print/firm?edition=…&firm=…`. The document
 * alone — no navigation, no operator controls — fetched with the session the
 * renderer placed in this page's storage (the requesting operator's own).
 *
 * `window.__REPORT_READY` tells the renderer the report has rendered and its
 * fonts have loaded, so it prints the finished page rather than a fixed-delay
 * guess.
 */

declare global {
  interface Window {
    __REPORT_READY?: boolean;
  }
}

function storedToken(): string | null {
  try {
    const raw = window.localStorage.getItem('cis.admin.session');
    return raw ? ((JSON.parse(raw) as { token?: string }).token ?? null) : null;
  } catch {
    return null;
  }
}

export function PrintReport(): JSX.Element {
  const params = new URLSearchParams(window.location.search);
  const kind = window.location.pathname.replace(/^\/print\//, '').replace(/\/$/, '');
  const editionId = params.get('edition');
  const firmId = params.get('firm');
  const client = useMemo(() => createClient(storedToken()), []);

  const ready = useCallback(() => {
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() => {
        window.__REPORT_READY = true;
      }),
    );
  }, []);

  if (!editionId || (kind === 'firm' && !firmId) || !['industry', 'firm'].includes(kind)) {
    return <p>Unknown report.</p>;
  }
  return kind === 'industry' ? (
    <IndustryReport
      client={client}
      editionId={editionId}
      onBack={() => undefined}
      printMode
      onReady={ready}
    />
  ) : (
    <FirmReport
      source={operatorFirmSource(client, editionId, firmId!)}
      onBack={() => undefined}
      printMode
      onReady={ready}
    />
  );
}
