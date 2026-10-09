import { useCallback, useMemo } from 'react';
import { createClient } from '../api/client';
import { FirmReport } from './FirmReport';
import { IndustryReport } from './IndustryReport';
import { InstitutionalReport } from './InstitutionalReport';
import {
  operatorFirmSource,
  operatorIndustrySource,
  operatorInstitutionalSource,
  portalFirmSource,
  publicIndustrySource,
  publicInstitutionalSource,
} from './source';

/**
 * The page the API's PDF renderer prints (apps/api/src/pdf/report-pdf.ts):
 * `/print/industry?edition=…`, `/print/institutional?edition=…` or
 * `/print/firm?edition=…&firm=…`. The document
 * alone — no navigation, no controls — fetched as whoever asked for the PDF:
 *
 * - no `audience` — an operator, with the session the renderer placed in this
 *   page's storage (the requesting operator's own);
 * - `audience=firm` — a firm coordinator, their own released report, with
 *   their own portal session;
 * - `audience=public` — the published Industry report, no session.
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

function storedToken(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(key);
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
  const audience = params.get('audience');
  const client = useMemo(() => createClient(storedToken('cis.admin.session')), []);

  const ready = useCallback(() => {
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() => {
        window.__REPORT_READY = true;
      }),
    );
  }, []);

  if (
    !editionId ||
    (kind === 'firm' && !firmId) ||
    !['industry', 'institutional', 'firm'].includes(kind)
  ) {
    return <p>Unknown report.</p>;
  }
  if (kind === 'institutional') {
    const source =
      audience === 'public'
        ? publicInstitutionalSource(editionId)
        : operatorInstitutionalSource(client, editionId);
    return <InstitutionalReport source={source} printMode onReady={ready} />;
  }
  if (kind === 'industry') {
    const source =
      audience === 'public'
        ? publicIndustrySource(editionId)
        : operatorIndustrySource(client, editionId);
    return <IndustryReport source={source} printMode onReady={ready} />;
  }
  const source =
    audience === 'firm'
      ? portalFirmSource(storedToken('cis.portal.session') ?? '', editionId)
      : operatorFirmSource(client, editionId, firmId!);
  return <FirmReport source={source} printMode onReady={ready} />;
}
