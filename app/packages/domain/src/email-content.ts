import type { Pool, PoolClient } from 'pg';
import { queueEmail, type OutboxEmail } from '@cis/db';

/**
 * The words of a notice, and how it is queued. Every email the system sends is
 * written once as paragraphs (plus an optional action link and footer) and
 * queued with both a plain-text and an HTML body.
 *
 * The HTML is deliberately plain: inline styles only (mail clients drop
 * <style>), one column of at most 560px, the system font, real text (no
 * images), and the action as a large link styled as a button. All text is
 * escaped; bare http(s) URLs in paragraphs become links.
 */

export interface EmailAction {
  label: string;
  url: string;
}

export interface EmailContent {
  heading?: string;
  paragraphs: string[];
  action?: EmailAction;
  footer?: string;
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const TEXT = '#1f2933';
const MUTED = '#616e7c';
const ACCENT = '#0b4f8a';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
    out += `<a href="${escapeHtml(url)}" style="color:${ACCENT};text-decoration:underline;">${escapeHtml(url)}</a>`;
    last = start + url.length;
  }
  out += escapeHtml(text.slice(last));
  return out.replace(/\r?\n/g, '<br>');
}

const isSafeUrl = (url: string) => /^(https?:|mailto:)/i.test(url.trim());

const paragraphHtml = (p: string, style: string) => `<p style="${style}">${inlineHtml(p)}</p>`;

/** Splits plain text into paragraphs on blank lines. */
const splitParagraphs = (text: string): string[] =>
  text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/^\s*\n|\n\s*$/g, '').trim())
    .filter((p) => p.length > 0);

export function renderEmailHtml(content: EmailContent): string {
  const pStyle = `margin:0 0 16px;font-size:16px;line-height:1.5;color:${TEXT};`;
  const parts: string[] = [];
  if (content.heading) {
    parts.push(
      `<h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;font-weight:600;color:${TEXT};">${escapeHtml(content.heading)}</h1>`,
    );
  }
  for (const p of content.paragraphs) parts.push(paragraphHtml(p, pStyle));
  if (content.action) {
    const { label, url } = content.action;
    if (isSafeUrl(url)) {
      parts.push(
        `<p style="margin:24px 0;"><a href="${escapeHtml(url.trim())}" style="display:inline-block;padding:12px 22px;background:${ACCENT};color:#ffffff;font-size:16px;font-weight:600;line-height:1.25;text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a></p>`,
        `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${MUTED};">If the button does not work, copy this link into your browser:<br><a href="${escapeHtml(url.trim())}" style="color:${ACCENT};word-break:break-all;">${escapeHtml(url.trim())}</a></p>`,
      );
    } else {
      parts.push(paragraphHtml(`${label}: ${url}`, pStyle));
    }
  }
  if (content.footer) {
    const fStyle = `margin:0 0 8px;font-size:13px;line-height:1.5;color:${MUTED};`;
    parts.push(
      `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #e4e7eb;">${splitParagraphs(
        content.footer,
      )
        .map((p) => paragraphHtml(p, fStyle))
        .join('')}</div>`,
    );
  }
  const title = content.heading ? `<title>${escapeHtml(content.heading)}</title>` : '';
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${title}</head>`,
    `<body style="margin:0;padding:0;background:#f5f7fa;">`,
    `<div role="article" aria-label="${escapeHtml(content.heading ?? 'Message')}" style="max-width:560px;margin:0 auto;padding:32px 24px;background:#ffffff;font-family:${FONT};color:${TEXT};">`,
    ...parts,
    '</div>',
    '</body>',
    '</html>',
  ].join('');
}

/** An HTML body for a legacy plain-text notice: escaped, blank-line paragraphs, links. */
export function textToHtml(text: string): string {
  return renderEmailHtml({ paragraphs: splitParagraphs(text) });
}

/** The plain-text body: paragraphs, then the action URL on its own line, then the footer. */
export function renderEmailText(content: EmailContent): string {
  const blocks = [...content.paragraphs];
  if (content.action) blocks.push(content.action.url);
  if (content.footer) blocks.push(content.footer);
  return blocks.join('\n\n');
}

export interface Notice extends EmailContent {
  /** What the notice is about, e.g. 'firm-report-released'. */
  kind: string;
  /** The thing it is about (uuid), if any. */
  refId: string | null;
  to: string;
  toName?: string | null;
  subject: string;
}

/**
 * Queues one notice in the email outbox with text and HTML bodies. Accepts a
 * pool or a transaction client, so a notice can be queued atomically with the
 * change it reports. Sending is the API's mail dispatcher's job.
 */
export async function queueNotice(db: Pool | PoolClient, notice: Notice): Promise<OutboxEmail> {
  const content: EmailContent = {
    paragraphs: notice.paragraphs,
    ...(notice.heading !== undefined ? { heading: notice.heading } : {}),
    ...(notice.action !== undefined ? { action: notice.action } : {}),
    ...(notice.footer !== undefined ? { footer: notice.footer } : {}),
  };
  return queueEmail(db, {
    kind: notice.kind,
    refId: notice.refId,
    toAddress: notice.to,
    toName: notice.toName ?? null,
    subject: notice.subject,
    bodyText: renderEmailText(content),
    bodyHtml: renderEmailHtml(content),
  });
}
