import { STUDY_NAME } from '@cis/survey';
import { TEMPLATE_HTML } from './templates.generated';
import { htmlToText } from './text';

export { htmlToText };

/**
 * The approved email designs (CIS crest, purple #22006A, gold #B8985A): the 23
 * templates of the client's set, kept verbatim in html/ apart from merge
 * fields, plus four built in the same design where the set had none —
 *
 *   I-02  market institution: survey reminder (I-01's layout)
 *   I-03  market institution: response received
 *   I-04  market institution: response recorded (its Q0 answer closed the
 *         survey — a complete response, never framed as a refusal)
 *   BASE  the shared header and footer around free content, for every notice
 *         without a template of its own
 *
 * `{{name}}` is a merge field: its value is HTML-escaped. `{{{name}}}` (BASE
 * only) is HTML the platform itself built and escaped. Every template is
 * rendered with the brand fields (BRAND_FIELDS): the two logos and their
 * sizes, the study name and the support address, from `emailBrand()`.
 */

export type TemplateId =
  | 'F-01'
  | 'F-02'
  | 'F-03'
  | 'F-04'
  | 'F-05'
  | 'F-06'
  | 'F-07'
  | 'F-08'
  | 'F-09'
  | 'F-10'
  | 'F-11'
  | 'F-12'
  | 'F-13'
  | 'I-01'
  | 'I-02'
  | 'I-03'
  | 'I-04'
  | 'O-01'
  | 'O-02'
  | 'O-03'
  | 'O-04'
  | 'P-01'
  | 'P-02'
  | 'P-03'
  | 'P-04'
  | 'P-05';

/** Subject lines, as approved (README of the template set). */
export const TEMPLATE_SUBJECTS: Readonly<Record<TemplateId, string>> = {
  'F-01': '{{firm}} is invited to the CIS-Dragnet {{edition}} Benchmark Study',
  'F-02': 'Reminder: {{firm}} has not yet set up its space',
  'F-03': 'A new invitation code for {{firm}}',
  'F-04': "{{firm}}'s study space is ready",
  'F-05': 'Please complete the {{survey_name}} for {{firm}}',
  'F-06': 'Who at {{firm}} is answering?',
  'F-07': '{{firm}} has surveys still to complete',
  'F-08': 'Received: {{survey_name}} for {{firm}}',
  'F-09': "Invite {{firm}}'s clients to rate their experience",
  'F-10': 'We have received your request (ref {{request_ref}})',
  'F-11': '{{firm}} has been added to the study',
  'F-12': 'Your request to join the study (ref {{request_ref}})',
  'F-13': 'Your {{edition}} CIS-Dragnet firm report is ready',
  'I-01': '{{institution}}: your perspective for the {{edition}} State of Stockbroking report',
  'I-02':
    "Reminder: {{institution}}'s perspective for the {{edition}} State of Stockbroking report",
  'I-03': "Received: {{institution}}'s response for the {{edition}} State of Stockbroking report",
  'I-04': "Received: {{institution}}'s response for the {{edition}} State of Stockbroking report",
  'O-01': 'You have been given access to CIS-Dragnet Study Operations',
  'O-02': 'Reset your Study Operations password',
  'O-03': 'Approval needed: {{action}}',
  'O-04': '{{action}}: {{outcome}}',
  'P-01': 'Rate your stockbroker: the CIS-Dragnet {{edition}} investor survey',
  'P-02': 'Your survey is still open',
  'P-03': 'Your survey is still open',
  'P-04': 'Thank you for taking part',
  'P-05': 'The {{edition}} State of Stockbroking report is published',
};

export const TEMPLATE_IDS = Object.keys(TEMPLATE_SUBJECTS) as TemplateId[];

/** Filled for every template from the deployment, never by the caller. */
export const BRAND_FIELDS = [
  'logo_url',
  'partner_logo_url',
  'logo_width',
  'partner_logo_width',
  'logo_height',
  'study_name',
  'support_email',
] as const;

/** Where questions — and every reply to an email — go, unless SUPPORT_EMAIL says otherwise. */
export const DEFAULT_SUPPORT_EMAIL = 'support@cisdragnetstudy.com';
const DEV_ORIGIN = 'http://localhost:5174';

/**
 * The header shows the CIS crest and the Dragnet logo side by side at one
 * height. Outlook ignores CSS sizes, so each image carries explicit width and
 * height attributes, worked out from the image's own proportions — this is
 * the one place they are set. Both files are 440×144 px today (the Dragnet one
 * a placeholder). When the real Dragnet logo arrives, replace
 * apps/admin/public/dragnet-logo.png; if its proportions differ, set
 * EMAIL_LOGO.partnerWidth to round(height × its width ÷ its height).
 */
export const EMAIL_LOGO = {
  height: 48,
  /** round(48 × 440 / 144) */
  cisWidth: 147,
  /** round(48 × 440 / 144) */
  partnerWidth: 147,
} as const;

export interface EmailBrand {
  /** `<public site origin>/cis-logo.png` — the CIS crest, served by the admin app. */
  logoUrl: string;
  /** `<public site origin>/dragnet-logo.png` — the Dragnet logo, beside the crest. */
  partnerLogoUrl: string;
  /** SUPPORT_EMAIL, else support@cisdragnetstudy.com. */
  supportEmail: string;
}

/** The public site's origin, as the API's publicOrigin(): PORTAL_URL, else REPORT_RENDER_URL. */
export function emailOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['PORTAL_URL']?.trim() || env['REPORT_RENDER_URL']?.trim() || DEV_ORIGIN;
  try {
    return new URL(raw).origin;
  } catch {
    return DEV_ORIGIN;
  }
}

export function emailBrand(env: NodeJS.ProcessEnv = process.env): EmailBrand {
  return {
    logoUrl: `${emailOrigin(env)}/cis-logo.png`,
    partnerLogoUrl: `${emailOrigin(env)}/dragnet-logo.png`,
    supportEmail: env['SUPPORT_EMAIL']?.trim() || DEFAULT_SUPPORT_EMAIL,
  };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class MissingMergeFieldError extends Error {
  constructor(
    public readonly templateId: string,
    public readonly fields: string[],
  ) {
    super(`Email template ${templateId} is missing merge field(s): ${fields.join(', ')}`);
    this.name = 'MissingMergeFieldError';
  }
}

/** A value, or a list of paragraphs (each escaped and set as the template's
 *  body paragraph). */
export type MergeValue = string | number | readonly string[] | null | undefined;
export type MergeFields = Record<string, MergeValue>;

const FIELD_RE = /\{\{\{?\s*([a-z_]+)\s*\}?\}\}/g;

function htmlOf(id: TemplateId | 'BASE'): string {
  const html = TEMPLATE_HTML[id];
  if (html === undefined) throw new Error(`Unknown email template ${id}`);
  // The note at the top of a file (what was added to the approved design) is
  // for maintainers, not recipients.
  return html.replace(/<!--\n {2}Added for platform parity:[\s\S]*?-->\n/, '');
}

/**
 * Optional parts: `{{#name}}…{{/name}}` is kept only when `name` has a value
 * (not null, undefined, '' or an empty list); `{{^name}}…{{/name}}` only when
 * it has none. Sections of different names may nest.
 */
const SECTION_RE = /\{\{([#^])([a-z_]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;

const present = (v: MergeValue): boolean =>
  v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

function sections(text: string, fields: MergeFields | null): string {
  let out = text;
  for (let prev = ''; prev !== out;) {
    prev = out;
    out = out.replace(SECTION_RE, (_m, kind: string, name: string, inner: string) => {
      if (fields === null) return ''; // strip every section: what is left is required
      return present(fields[name]) === (kind === '#') ? inner : '';
    });
  }
  return out;
}

function namesIn(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(FIELD_RE)) names.add(m[1] as string);
  for (const m of text.matchAll(/\{\{[#^/]([a-z_]+)\}\}/g)) names.add(m[1] as string);
  return names;
}

const subjectOf = (id: TemplateId | 'BASE') => (id === 'BASE' ? '' : TEMPLATE_SUBJECTS[id]);

/** Every merge field a template (and its subject) uses, brand fields included. */
export function templateFields(id: TemplateId | 'BASE'): string[] {
  return [...namesIn(`${subjectOf(id)}\n${htmlOf(id)}`)].sort();
}

const notBrand = (f: string) => !(BRAND_FIELDS as readonly string[]).includes(f);

/** The fields a caller must give: every field used outside an optional section,
 *  except the brand's. */
export function requiredFields(id: TemplateId | 'BASE'): string[] {
  return [...namesIn(`${subjectOf(id)}\n${sections(htmlOf(id), null)}`)].filter(notBrand).sort();
}

/** The fields only used in optional sections: given, they add a part; absent, it is left out. */
export function optionalFields(id: TemplateId | 'BASE'): string[] {
  const required = new Set(requiredFields(id));
  return templateFields(id).filter((f) => notBrand(f) && !required.has(f));
}

/** The style of the designed templates' body paragraphs. */
export const BODY_PARAGRAPH_STYLE =
  'margin:0 0 16px;font-family:Arial, Helvetica, sans-serif;font-size:15px;line-height:24px;color:#3B3848;';

/**
 * A missing field is a programming error: outside production it throws (so a
 * test catches it); in production the email still goes, with the gap left
 * blank and the error logged, rather than failing the action that sent it.
 */
function checkFields(id: string, fields: MergeFields, names: string[]): void {
  const missing = names.filter((n) => fields[n] === undefined || fields[n] === null);
  if (missing.length === 0) return;
  const err = new MissingMergeFieldError(id, missing);
  if (process.env['NODE_ENV'] !== 'production') throw err;
  console.error(err.message);
}

/** Sections first (template text only), then one pass over the fields, so a
 *  value that itself contains "{{…}}" is never filled again. */
function fill(text: string, fields: MergeFields, escape: boolean): string {
  return sections(text, fields).replace(
    /\{\{\{\s*([a-z_]+)\s*\}\}\}|\{\{\s*([a-z_]+)\s*\}\}/g,
    (_m, raw: string | undefined, name: string | undefined) => {
      if (raw !== undefined) return String(fields[raw] ?? '');
      const v = fields[name as string];
      if (Array.isArray(v)) {
        if (!escape) return v.join(' ');
        return v
          .map(
            (p) =>
              `<p style="${BODY_PARAGRAPH_STYLE}">${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`,
          )
          .join('');
      }
      const str = String(v ?? '');
      return escape ? escapeHtml(str) : str;
    },
  );
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function withBrand(fields: MergeFields, brand: EmailBrand): MergeFields {
  return {
    ...fields,
    logo_url: brand.logoUrl,
    partner_logo_url: brand.partnerLogoUrl,
    logo_width: EMAIL_LOGO.cisWidth,
    partner_logo_width: EMAIL_LOGO.partnerWidth,
    logo_height: EMAIL_LOGO.height,
    study_name: STUDY_NAME,
    support_email: brand.supportEmail,
  };
}

/** Render one of the designed templates: subject (unescaped), HTML and plain text. */
export function renderTemplate(
  id: TemplateId,
  fields: MergeFields,
  opts: { brand?: EmailBrand } = {},
): RenderedEmail {
  if (!(id in TEMPLATE_SUBJECTS)) throw new Error(`Unknown email template ${id}`);
  checkFields(id, fields, requiredFields(id));
  const all = withBrand(fields, opts.brand ?? emailBrand());
  // Raw ({{{ }}}) slots are BASE-only: in a designed template every value is escaped.
  const html = fill(
    htmlOf(id)
      .replace(/\{\{\{/g, '{{')
      .replace(/\}\}\}/g, '}}'),
    all,
    true,
  );
  return {
    subject: fill(TEMPLATE_SUBJECTS[id], all, false).replace(/\s+/g, ' ').trim(),
    html,
    text: htmlToText(html),
  };
}

/**
 * The shared layout around platform-built content (BASE). `content` and
 * `footerExtra` are trusted HTML the caller has escaped; the rest are escaped
 * here.
 */
export function renderLayout(
  parts: {
    title: string;
    preheader: string;
    content: string;
    footerExtra: string;
    footerNote: string;
    /** The edition label, e.g. "2026" (the header and footer name the year). */
    edition: string;
  },
  opts: { brand?: EmailBrand } = {},
): string {
  return fill(
    htmlOf('BASE'),
    withBrand(
      {
        title: parts.title,
        preheader: parts.preheader,
        content: parts.content,
        footer_extra: parts.footerExtra,
        footer_note: parts.footerNote,
        edition: parts.edition,
      },
      opts.brand ?? emailBrand(),
    ),
    true,
  );
}
