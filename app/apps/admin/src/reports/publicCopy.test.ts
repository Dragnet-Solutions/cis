/**
 * BUG-001: /reports/institutional, before anything is published, said "No
 * Industry report has been published yet." Each public report page names its
 * own document.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PUBLIC_REPORT_COPY, PublicReportMissing, publicReportKind } from './publicCopy';

describe('publicReportKind', () => {
  it('reads the document from the path', () => {
    expect(publicReportKind('/reports/institutional')).toBe('institutional');
    expect(publicReportKind('/reports/institutional/')).toBe('institutional');
    expect(publicReportKind('/reports/industry')).toBe('industry');
    expect(publicReportKind('/reports')).toBe('industry');
  });
});

describe('PublicReportMissing', () => {
  const render = (kind: 'industry' | 'institutional') =>
    renderToStaticMarkup(createElement(PublicReportMissing, { kind }));

  it('names the Institutional Perspectives report, never the Industry report', () => {
    const html = render('institutional');
    expect(html).toContain('The Institutional Perspectives report has not been published yet.');
    expect(html).not.toContain('No Industry report');
    expect(html).toContain('href="/survey"');
  });

  it('keeps the Industry report wording on its own page', () => {
    const html = render('industry');
    expect(html).toContain('No Industry report has been published yet.');
    expect(html).not.toContain('Institutional Perspectives');
  });

  it('gives every kind its own heading', () => {
    expect(PUBLIC_REPORT_COPY.institutional.notPublished).not.toBe(
      PUBLIC_REPORT_COPY.industry.notPublished,
    );
  });
});
