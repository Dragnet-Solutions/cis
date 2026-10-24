import type { Pool, PoolClient } from 'pg';
import { queueEmail, type OutboxEmail } from '@cis/db';
import { STUDY_NAME } from '@cis/survey';
import {
  escapeHtml,
  htmlToText,
  renderLayout,
  renderTemplate,
  type EmailBrand,
  type MergeFields,
  type TemplateId,
} from './email-templates';
import { editionForEmail } from './email-fields';

export { escapeHtml };

/**
 * The words of a notice, and how it is queued. Every email the platform sends
 * is in the approved CIS design (email-templates/): most are one of the
 * designed templates (`queueTemplate`); the rest are written as paragraphs
 * (plus an optional action link and footer) and set in the same header and
 * footer (`queueNotice`, the BASE layout). Both are queued with an HTML body
 * and a plain-text alternative derived from it.
 *
 * All text is escaped; bare http(s) URLs in paragraphs become links.
 */

export interface EmailAction {
  label: string;
  url: string;
}

/** Who a notice is for: sets the small print and the sign-off. */
export type NoticeAudience = 'firm' | 'investor' | 'institution' | 'operator' | 'general';

export interface EmailContent {
  /** The small gold label above the heading, e.g. "Your survey". */
  label?: string;
  heading?: string;
  paragraphs: string[];
  action?: EmailAction;
  footer?: string;
  audience?: NoticeAudience;
}

const FOOTER_NOTE: Record<NoticeAudience, (edition: string) => string> = {
  firm: (e) =>
    `You are receiving this because your firm is a participating firm in the CIS-Dragnet ${e} Benchmark Study.`,
  investor: (e) =>
    `You are receiving this because you took part in, or were invited to, the CIS-Dragnet ${e} investor survey.`,
  institution: (e) =>
    `You are receiving this as the named contact for your institution in the CIS-Dragnet ${e} Benchmark Study.`,
  operator: () =>
    'You are receiving this because you have an account on CIS-Dragnet Study Operations.',
  general: (e) =>
    `You are receiving this because of your part in the CIS-Dragnet ${e} Benchmark Study.`,
};

/** The edition label emails name when none is given: the open (else latest)
 *  edition's, else the current year (an empty database). */
export async function currentEditionLabel(db: Pool | PoolClient): Promise<string> {
  return (await editionForEmail(db))?.label ?? String(new Date().getFullYear());
}

/** Rendering options: the brand (crest, support address) and the edition label. */
export interface RenderOptions {
  brand?: EmailBrand;
  edition?: string;
}

// The template set's own styles, so a BASE notice reads like the designed ones.
const ARIAL = 'font-family:Arial, Helvetica, sans-serif;';
const S = {
  label: `${ARIAL}font-size:11px;line-height:16px;letter-spacing:2.5px;text-transform:uppercase;color:#86692C;margin:0 0 10px;`,
  h1: "margin:0 0 20px;font-family:Georgia, 'Times New Roman', Times, serif;font-size:28px;line-height:36px;font-weight:normal;color:#1B1530;",
  p: `margin:0 0 16px;${ARIAL}font-size:15px;line-height:24px;color:#3B3848;`,
  small: `margin:0 0 12px;${ARIAL}font-size:12px;line-height:18px;color:#6E6A7C;`,
  link: 'color:#22006A;',
  footerLine: `margin:10px 0 0;${ARIAL}font-size:12px;line-height:18px;color:#C9C4D6;`,
};

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCT = /[.,;:!?)\]]+$/;

/** Escapes `text`, turning bare http(s) URLs into links and newlines into <br>. */
function inlineHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    const trail = TRAILING_PUNCT.exec(url)?.[0] ?? '';
    if (trail) url = url.slice(0, url.length - trail.length);
    out += escapeHtml(text.slice(last, start));
    out += `<a href="${escapeHtml(url)}" style="${S.link}word-break:break-all;">${escapeHtml(url)}</a>`;
    last = start + url.length;
  }
  out += escapeHtml(text.slice(last));
  return out.replace(/\r?\n/g, '<br>');
}

const isSafeUrl = (url: string) => /^(https?:|mailto:)/i.test(url.trim());

/** Splits plain text into paragraphs on blank lines. */
const splitParagraphs = (text: string): string[] =>
  text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/^\s*\n|\n\s*$/g, '').trim())
    .filter((p) => p.length > 0);

/** The template set's button (with its Outlook VML twin) and copy-the-link fallback. */
function buttonHtml(label: string, url: string): string {
  const u = escapeHtml(url.trim());
  const l = escapeHtml(label);
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px;">\n' +
    '<tr><td bgcolor="#22006A" style="background:#22006A;border-radius:3px;">\n' +
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${u}" style="height:50px;v-text-anchor:middle;width:300px;" arcsize="6%" stroke="f" fillcolor="#22006A"><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${l}</center></v:roundrect><![endif]-->\n` +
    `<!--[if !mso]><!--><a href="${u}" style="display:inline-block;padding:16px 34px;${ARIAL}font-size:15px;font-weight:bold;line-height:18px;letter-spacing:0.3px;color:#ffffff;text-decoration:none;border-radius:3px;">${l}&nbsp;&nbsp;&rarr;</a><!--<![endif]-->\n` +
    '</td></tr></table>\n' +
    `<p style="margin:0 0 24px;${ARIAL}font-size:12px;line-height:18px;color:#6E6A7C;">Button not working? Copy this link into your browser:<br><a href="${u}" style="color:#22006A;word-break:break-all;">${u}</a></p>`
  );
}

export function renderEmailHtml(content: EmailContent, opts: RenderOptions = {}): string {
  const edition = opts.edition ?? String(new Date().getFullYear());
  const audience = content.audience ?? 'general';
  const parts: string[] = [];
  if (content.label) parts.push(`<div style="${S.label}">${escapeHtml(content.label)}</div>`);
  if (content.heading)
    parts.push(`<h1 class="h1" style="${S.h1}">${escapeHtml(content.heading)}</h1>`);
  for (const p of content.paragraphs) parts.push(`<p style="${S.p}">${inlineHtml(p)}</p>`);
  if (content.action) {
    const { label, url } = content.action;
    parts.push(
      isSafeUrl(url)
        ? buttonHtml(label, url)
        : `<p style="${S.p}">${inlineHtml(`${label}: ${url}`)}</p>`,
    );
  }
  if (content.footer) {
    for (const p of splitParagraphs(content.footer)) {
      parts.push(`<p style="${S.small}">${inlineHtml(p)}</p>`);
    }
  }
  const team =
    audience === 'operator' ? 'CIS-Dragnet Study Operations' : `The ${escapeHtml(STUDY_NAME)} Team`;
  parts.push(
    `<p style="margin:8px 0 0;${ARIAL}font-size:15px;line-height:24px;color:#3B3848;">Kind regards,<br><strong style="color:#1B1530;">${team}</strong></p>`,
  );
  const confidential =
    audience === 'operator'
      ? ''
      : `  <p style="${S.footerLine}">Individual answers are confidential and reported only in aggregate.</p>\n`;
  const title =
    content.heading ?? content.paragraphs[0] ?? `CIS-Dragnet ${edition} Benchmark Study`;
  return renderLayout(
    {
      title,
      preheader: content.heading ?? '',
      content: parts.join(''),
      footerExtra: confidential,
      footerNote: FOOTER_NOTE[audience](edition),
      edition,
    },
    opts.brand ? { brand: opts.brand } : {},
  );
}

/** An HTML body for a plain-text notice: escaped, blank-line paragraphs, links. */
export function textToHtml(text: string, audience: NoticeAudience = 'general'): string {
  return renderEmailHtml({ paragraphs: splitParagraphs(text), audience });
}

/** The plain-text alternative: derived from the HTML, as for the designed templates. */
export function renderEmailText(content: EmailContent, opts: RenderOptions = {}): string {
  return htmlToText(renderEmailHtml(content, opts));
}

interface Addressed {
  /** What the notice is about, e.g. 'firm-report-released'. */
  kind: string;
  /** The thing it is about (uuid), if any. */
  refId: string | null;
  to: string;
  toName?: string | null;
}

export interface Notice extends EmailContent, Addressed {
  subject: string;
  /** The edition label; default currentEditionLabel(). */
  edition?: string;
}

/**
 * Queues one notice in the email outbox with text and HTML bodies, in the
 * BASE layout. Accepts a pool or a transaction client, so a notice can be
 * queued atomically with the change it reports. Sending is the API's mail
 * dispatcher's job.
 */
export async function queueNotice(db: Pool | PoolClient, notice: Notice): Promise<OutboxEmail> {
  const content: EmailContent = {
    paragraphs: notice.paragraphs,
    ...(notice.label !== undefined ? { label: notice.label } : {}),
    ...(notice.heading !== undefined ? { heading: notice.heading } : {}),
    ...(notice.action !== undefined ? { action: notice.action } : {}),
    ...(notice.footer !== undefined ? { footer: notice.footer } : {}),
    ...(notice.audience !== undefined ? { audience: notice.audience } : {}),
  };
  const html = renderEmailHtml(content, {
    edition: notice.edition ?? (await currentEditionLabel(db)),
  });
  return queueEmail(db, {
    kind: notice.kind,
    refId: notice.refId,
    toAddress: notice.to,
    toName: notice.toName ?? null,
    subject: notice.subject,
    bodyText: htmlToText(html),
    bodyHtml: html,
  });
}

export interface TemplateNotice extends Addressed {
  template: TemplateId;
  fields: MergeFields;
  /** Overrides the deployment's crest and support address (emailBrand()). */
  brand?: EmailBrand;
}

/** Queues one of the designed templates (subject, HTML and text all from it). */
export async function queueTemplate(
  db: Pool | PoolClient,
  notice: TemplateNotice,
): Promise<OutboxEmail> {
  // Every design names the edition; a caller that does not know it gets the
  // open (else latest) edition's label.
  const fields: MergeFields =
    notice.fields['edition'] === undefined || notice.fields['edition'] === null
      ? { ...notice.fields, edition: await currentEditionLabel(db) }
      : notice.fields;
  const r = renderTemplate(notice.template, fields, notice.brand ? { brand: notice.brand } : {});
  return queueEmail(db, {
    kind: notice.kind,
    refId: notice.refId,
    toAddress: notice.to,
    toName: notice.toName ?? null,
    subject: r.subject,
    bodyText: r.text,
    bodyHtml: r.html,
  });
}
