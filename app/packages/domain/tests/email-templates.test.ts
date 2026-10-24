/**
 * The approved email designs: every template renders with its merge fields
 * filled and escaped, the CIS crest beside the Dragnet logo, the study's name
 * and the support address, and a plain-text
 * alternative that carries the email's link. The embedded copy of the HTML
 * files is checked to be current.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_IDS,
  TEMPLATE_SUBJECTS,
  MissingMergeFieldError,
  renderTemplate,
  renderLayout,
  requiredFields,
  optionalFields,
  emailBrand,
  EMAIL_LOGO,
  DEFAULT_SUPPORT_EMAIL,
  type TemplateId,
} from '../src/email-templates';
import { SAMPLE_FIELDS, SAMPLE_BASE_NOTICES } from '../src/email-templates/samples';
import { renderEmailHtml, renderEmailText } from '../src/email-content';

const BRAND = {
  logoUrl: 'https://cis.example/cis-logo.png',
  partnerLogoUrl: 'https://cis.example/dragnet-logo.png',
  supportEmail: 'help@cis.example',
};

/** Both logos, at one height, split by a thin rule; alt text names both
 *  organisations (Outlook blocks images by default). */
function expectLogoPair(html: string): void {
  const h = EMAIL_LOGO.height;
  expect(html).toContain(
    `<img src="https://cis.example/cis-logo.png" width="${EMAIL_LOGO.cisWidth}" height="${h}" alt="Chartered Institute of Stockbrokers"`,
  );
  expect(html).toContain(
    `<img src="https://cis.example/dragnet-logo.png" width="${EMAIL_LOGO.partnerWidth}" height="${h}" alt="Dragnet Solutions"`,
  );
  expect(html).toMatch(
    /border-left:1px solid #DCCDA8;"><img src="https:\/\/cis\.example\/dragnet-logo\.png"/,
  );
  // The old joint name, in any spelling, is gone.
  expect(html).not.toMatch(/×|&times;/);
}

/** The link each template exists to deliver (null: it carries none). */
const KEY_LINK: Record<TemplateId, string | null> = {
  'F-01': 'portal_link',
  'F-02': 'portal_link',
  'F-03': 'portal_link',
  'F-04': 'portal_link',
  'F-05': 'survey_link',
  'F-06': 'portal_link',
  'F-07': 'portal_link',
  'F-08': null,
  'F-09': 'portal_link',
  'F-10': null,
  'F-11': null,
  'F-12': null,
  'F-13': 'portal_link',
  'I-01': 'survey_link',
  'I-02': 'survey_link',
  'I-03': null,
  'I-04': null,
  'O-01': 'set_password_url',
  'O-02': 'reset_url',
  'O-03': 'approval_url',
  'O-04': 'ops_url',
  'P-01': 'survey_link',
  'P-02': 'recovery_url',
  'P-03': 'recovery_url',
  'P-04': 'optout_url',
  'P-05': 'report_url',
};

describe('the embedded templates', () => {
  it('match the HTML files (run `pnpm --filter @cis/domain email:templates` after an edit)', () => {
    const script = join(__dirname, '..', 'scripts', 'gen-email-templates.mjs');
    expect(() => execFileSync(process.execPath, [script, '--check'])).not.toThrow();
  });

  it('cover all 23 approved designs plus the four built in the same design', () => {
    expect(TEMPLATE_IDS).toHaveLength(26);
    for (const id of TEMPLATE_IDS) expect(SAMPLE_FIELDS[id]).toBeDefined();
  });
});

describe.each(TEMPLATE_IDS)('template %s', (id) => {
  const r = renderTemplate(id, SAMPLE_FIELDS[id], { brand: BRAND });

  it('fills every merge field, in the subject, the HTML and the text', () => {
    expect(r.subject).not.toMatch(/\{\{|\}\}/);
    expect(r.html).not.toMatch(/\{\{|\}\}/);
    expect(r.text).not.toMatch(/\{\{|\}\}/);
    expect(r.subject.length).toBeGreaterThan(5);
  });

  it('shows the CIS crest beside the Dragnet logo, and the support address', () => {
    expectLogoPair(r.html);
    expect(r.html).toContain('href="mailto:help@cis.example"');
    expect(r.text).toContain('help@cis.example');
  });

  it('has a plain-text part with the key link and no markup', () => {
    const field = KEY_LINK[id];
    if (field) {
      const url = String(SAMPLE_FIELDS[id][field]);
      expect(r.text).toContain(url);
      expect(r.html).toContain(url.replace(/&/g, '&amp;'));
    }
    expect(r.text).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(r.text).not.toContain('Button not working');
    expect(r.text).toContain('Kind regards,');
    expect(r.text).not.toContain('×');
  });

  it('signs off as the study team, by its one name', () => {
    if (id.startsWith('O-')) return; // operator emails sign off from Study Operations
    expect(r.html).toContain('The CIS - Dragnet Study Team');
    expect(r.text).toContain('The CIS - Dragnet Study Team');
  });

  it('escapes every merge value', () => {
    const hostile = '<script>alert("x")</script> & Co';
    const fields = Object.fromEntries(requiredFields(id).map((f) => [f, hostile]));
    const evil = renderTemplate(id, fields, { brand: BRAND });
    expect(evil.html).not.toContain('<script>');
    expect(evil.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co');
    // The text part is plain text: the value as given, never interpreted.
    expect(evil.text).toContain(hostile);
  });

  it('refuses to render with a merge field missing', () => {
    const [first] = requiredFields(id);
    const fields = { ...SAMPLE_FIELDS[id] };
    delete fields[first as string];
    expect(() => renderTemplate(id, fields, { brand: BRAND })).toThrow(MissingMergeFieldError);
  });
});

describe('template details', () => {
  it('subjects are the approved ones', () => {
    const r = renderTemplate('O-03', SAMPLE_FIELDS['O-03'], { brand: BRAND });
    expect(r.subject).toBe('Approval needed: Release the firm reports');
    expect(TEMPLATE_SUBJECTS['F-01']).toBe(
      '{{firm}} is invited to the CIS-Dragnet {{edition}} Benchmark Study',
    );
  });

  it('only the later reminder (P-03) carries a stop link (DEC-012)', () => {
    const first = renderTemplate('P-02', SAMPLE_FIELDS['P-02'], { brand: BRAND });
    const later = renderTemplate('P-03', SAMPLE_FIELDS['P-03'], { brand: BRAND });
    expect(first.html).not.toContain('Stop these reminders');
    expect(first.html).not.toContain('?stop=');
    expect(later.text).toContain(
      `Stop these reminders (${String(SAMPLE_FIELDS['P-03'].stop_url)})`,
    );
  });

  it('a market institution whose Q0 closed the survey is thanked, never declined (I-04)', () => {
    const r = renderTemplate('I-04', SAMPLE_FIELDS['I-04'], { brand: BRAND });
    expect(r.text).toContain('Thank you for responding');
    expect(r.text.toLowerCase()).not.toMatch(/declin|refus/);
  });

  it('the brand comes from PORTAL_URL and SUPPORT_EMAIL, with a default address', () => {
    expect(emailBrand({ PORTAL_URL: 'https://dev-cis.idhub.ng/firm' })).toEqual({
      logoUrl: 'https://dev-cis.idhub.ng/cis-logo.png',
      partnerLogoUrl: 'https://dev-cis.idhub.ng/dragnet-logo.png',
      supportEmail: 'support@cisdragnetstudy.com',
    });
    expect(DEFAULT_SUPPORT_EMAIL).toBe('support@cisdragnetstudy.com');
    expect(
      emailBrand({ PORTAL_URL: 'https://x.example', SUPPORT_EMAIL: ' help@x.example ' })
        .supportEmail,
    ).toBe('help@x.example');
  });
});

describe('the shared layout (notices without a template)', () => {
  it.each(SAMPLE_BASE_NOTICES.map((n) => [n.kind, n] as const))('%s', (_kind, n) => {
    const html = renderEmailHtml(n, { brand: BRAND });
    const text = renderEmailText(n, { brand: BRAND });
    expect(html).not.toMatch(/\{\{|\}\}/);
    expectLogoPair(html);
    expect(text).toContain('help@cis.example');
    expect(`${n.subject}\n${text}`).not.toContain('×');
    if (n.audience !== 'operator') expect(text).toContain('The CIS - Dragnet Study Team');
    if (n.action) expect(text).toContain(n.action.url);
  });

  it('never fills a merge field that arrives inside a value', () => {
    const html = renderLayout(
      {
        title: '{{support_email}}',
        preheader: '',
        content: '<p>{{logo_url}}</p>',
        footerExtra: '',
        footerNote: '{{support_email}}',
      },
      { brand: BRAND },
    );
    expect(html).toContain('<title>{{support_email}}</title>');
    expect(html).toContain('<p>{{logo_url}}</p>');
  });

  it('an operator notice signs off from Study Operations, without the respondent small print', () => {
    const text = renderEmailText({ paragraphs: ['Hello'], audience: 'operator' }, { brand: BRAND });
    expect(text).toContain('CIS-Dragnet Study Operations');
    expect(text).not.toContain('Individual answers are confidential');
  });
});

describe('optional parts (restored for platform parity)', () => {
  const HOSTILE = '<b>x</b> & "y"';
  const ESCAPED = '&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;';
  const without = (id: TemplateId, field: string) => {
    const f = { ...SAMPLE_FIELDS[id] };
    delete f[field];
    return renderTemplate(id, f, { brand: BRAND });
  };
  const withValue = (id: TemplateId, field: string, value: string | string[]) =>
    renderTemplate(id, { ...SAMPLE_FIELDS[id], [field]: value }, { brand: BRAND });

  // template, field, a phrase that appears only with the field
  const cases: Array<[TemplateId, string, string]> = [
    [
      'P-05',
      'institutional_url',
      'The Institutional Perspectives report is published alongside it',
    ],
    ['P-05', 'optout_url', 'opt out here'],
    ['P-04', 'institution', ' on behalf of '],
    ['F-01', 'expires_on', 'This link is personal and expires on'],
    ['F-08', 'still_to_come', 'Still to come:'],
  ];

  it.each(cases)('%s %s: present when given, absent when not, escaped', (id, field, phrase) => {
    expect(optionalFields(id)).toContain(field);
    const given = renderTemplate(id, SAMPLE_FIELDS[id], { brand: BRAND });
    expect(given.text).toContain(phrase);
    expect(given.text).toContain(String(SAMPLE_FIELDS[id][field]));
    const absent = without(id, field);
    expect(absent.html).not.toContain(phrase);
    expect(absent.html).not.toMatch(/\{\{/);
    expect(withValue(id, field, '').html).not.toContain(phrase);
    const evil = withValue(id, field, HOSTILE);
    expect(evil.html).toContain(ESCAPED);
    expect(evil.html).not.toContain('<b>x</b>');
  });

  it('P-05 links the institutional report under the button and opts out in the small print', () => {
    const r = renderTemplate('P-05', SAMPLE_FIELDS['P-05'], { brand: BRAND });
    const body = r.html.indexOf('<body');
    const button = r.html.indexOf('Read the report', body);
    const inst = r.html.indexOf('Institutional Perspectives report', body);
    const footer = r.html.indexOf('background:#1B1530', body);
    const optout = r.html.indexOf('opt out here', body);
    expect(button).toBeLessThan(inst);
    expect(inst).toBeLessThan(footer);
    expect(footer).toBeLessThan(optout);
  });

  it.each(['F-01', 'F-02', 'F-03', 'F-06', 'F-07', 'F-09', 'P-01', 'P-02', 'P-03'] as TemplateId[])(
    '%s: an edited body replaces the opening paragraphs, escaped, one paragraph each',
    (id) => {
      const approved = renderTemplate(id, SAMPLE_FIELDS[id], { brand: BRAND });
      const edited = withValue(id, 'body', ['Hello <you>,', 'Line one\nline two']);
      expect(edited.html).toContain('>Hello &lt;you&gt;,</p>');
      expect(edited.html).toContain('>Line one<br>line two</p>');
      expect(edited.text).toContain('Hello <you>,\n\nLine one\nline two');
      expect(edited.html).not.toMatch(/\{\{/);
      // Everything after the opening paragraphs (rows, button) is unchanged.
      const tail = (h: string) => h.slice(h.indexOf('<table', h.indexOf('</h1>')));
      expect(tail(edited.html)).toBe(tail(approved.html));
      expect(edited.html.length).not.toBe(approved.html.length);
    },
  );

  it('the year is the edition label, never a fixed 2026', () => {
    for (const id of TEMPLATE_IDS) {
      // Sample dates move to 2027 too, so any 2026 left is the template's own.
      const fields = Object.fromEntries(
        Object.entries(SAMPLE_FIELDS[id]).map(([k, v]) => [
          k,
          typeof v === 'string' ? v.replace(/2026/g, '2027') : v,
        ]),
      );
      const r = renderTemplate(id, { ...fields, edition: '2027' }, { brand: BRAND });
      expect(`${r.subject}\n${r.html}`).not.toContain('2026');
      expect(r.html).toContain('2027');
    }
    const base = renderEmailHtml(
      { paragraphs: ['Hi'], audience: 'firm' },
      { brand: BRAND, edition: '2027' },
    );
    expect(base).toContain('CIS-Dragnet 2027 Benchmark Study');
    expect(base).not.toContain('2026');
  });
});
