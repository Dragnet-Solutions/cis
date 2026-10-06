import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

/**
 * Render a report document to PDF by printing the real report page in headless
 * Chrome — one source of truth for the design, so the PDF is exactly what an
 * operator sees on screen, as vector text.
 *
 * The page is the admin app's print route (`/print/industry`, `/print/firm`),
 * opened as whoever asked: their own session — an operator's, or a firm
 * coordinator's for their own released report — is placed in that page's
 * storage before it loads, so the page fetches the report with their access and
 * nobody else's. The public Industry report needs no session at all. The page sets `window.__REPORT_READY` once the report (and its
 * narrative) has rendered; printing waits for that, never a fixed delay.
 *
 * Configuration (.env):
 *   REPORT_RENDER_URL  — the admin app's origin (default http://localhost:5174)
 *   CHROME_PATH        — a Chrome / Chromium binary (defaults to the usual install paths)
 */

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export class ReportPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportPdfError';
  }
}

function chromePath(): string {
  const configured = process.env['CHROME_PATH'];
  if (configured) return configured;
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new ReportPdfError(
      'No Chrome or Chromium was found to render the PDF — set CHROME_PATH in .env.',
    );
  }
  return found;
}

/** The session the print page reads: the storage key, and what is stored there. */
export interface PdfSession {
  storageKey: 'cis.admin.session' | 'cis.portal.session';
  value: unknown;
}

export async function renderReportPdf(path: string, session: PdfSession | null): Promise<Buffer> {
  const origin = new URL(process.env['REPORT_RENDER_URL'] || 'http://localhost:5174').origin;
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 1400 });
    // The requester's own session, for this page's origin only. Passed as a
    // string: this runs in the page, and the API is compiled without DOM types.
    if (session) {
      await page.evaluateOnNewDocument(
        `if (window.location.origin === ${JSON.stringify(origin)}) {
           window.localStorage.setItem(${JSON.stringify(session.storageKey)}, ${JSON.stringify(
             JSON.stringify(session.value),
           )});
         }`,
      );
    }
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle0', timeout: 60_000 });
    try {
      await page.waitForFunction('window.__REPORT_READY === true', { timeout: 60_000 });
    } catch {
      const shown = String(await page.evaluate('document.body.innerText.slice(0, 300)'));
      throw new ReportPdfError(`The report page did not finish rendering: ${shown}`);
    }
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
