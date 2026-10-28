/**
 * D-17 (Bobby's naming, 27 Oct): the study is never called "CIS - Dragnet" or
 * "CIS × Dragnet". Every email the platform sends — each template and each
 * plain notice — is rendered with sample data and searched, subject, HTML and
 * text alike; the brand constants are checked against the approved forms.
 */
import { describe, it, expect } from 'vitest';
import {
  STUDY_NAME,
  STUDY_SHORT_NAME,
  STUDY_ATTRIBUTION,
  STUDY_SIGN_OFF,
  studyTitle,
} from '@cis/survey';
import { TEMPLATE_IDS, renderTemplate, type TemplateId } from '../src/email-templates';
import { SAMPLE_FIELDS, SAMPLE_BASE_NOTICES } from '../src/email-templates/samples';
import { renderEmailHtml, renderEmailText } from '../src/email-content';

const RETIRED = /CIS\s*[-–—×x]\s+Dragnet|CIS\s+[-–—×x]\s*Dragnet/;

describe('Study naming (D-17)', () => {
  it('the brand constants are the approved forms', () => {
    expect(STUDY_SHORT_NAME).toBe('The CIS-Dragnet Benchmark Study');
    expect(`the ${STUDY_NAME}`).toBe('the CIS-Dragnet Benchmark Study');
    expect(STUDY_ATTRIBUTION).toBe('A CIS-Dragnet Study');
    expect(STUDY_SIGN_OFF).toBe('The CIS-Dragnet Benchmark Study Team');
    expect(studyTitle('2026')).toBe(
      'State of Stockbroking Operations and Investor Experience in Nigeria: A 2026 CIS-Dragnet Study',
    );
  });

  it.each(TEMPLATE_IDS)('template %s never uses a retired form', (id) => {
    const r = renderTemplate(id as TemplateId, SAMPLE_FIELDS[id as TemplateId]);
    for (const part of [r.subject, r.html, r.text]) expect(part).not.toMatch(RETIRED);
  });

  it('plain notices never use a retired form, and sign off as the study team', () => {
    for (const n of SAMPLE_BASE_NOTICES) {
      const html = renderEmailHtml(n, { edition: '2026' });
      const text = renderEmailText(n, { edition: '2026' });
      for (const part of [n.subject, html, text]) expect(part).not.toMatch(RETIRED);
      if (n.audience !== 'operator') expect(text).toContain(STUDY_SIGN_OFF);
    }
  });
});
