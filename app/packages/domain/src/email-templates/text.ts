/**
 * The plain-text alternative of a rendered email, derived from its HTML. The
 * templates share one markup vocabulary (eyebrow label, heading, paragraphs,
 * label/value rows, a code box, a button with a copy-the-link fallback, a dark
 * footer), so each piece has a fixed text form:
 *
 *   button             → "Label:" then the URL on its own line
 *   label/value row    → "Label: value"
 *   code box           → "Your invitation code:" then the code
 *   other links        → "text (url)", or just the url when they are the same
 *   "Button not working?" fallback, logo, preheader, Outlook-only VML → dropped
 *
 * Merge values arrive HTML-escaped and are decoded here, so the text part
 * carries them exactly as given.
 */

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rarr: '→',
  times: '×',
  middot: '·',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  mdash: '—',
  ndash: '–',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1));
      // Zero-width / figure-space padding used in preheaders carries no text.
      if ([847, 8199, 65279, 8203].includes(code)) return '';
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');
/** One line of text, still entity-encoded: entities are decoded once, at the
 *  very end, so a value that decodes to "<…>" is never mistaken for a tag. */
const inline = (s: string) =>
  stripTags(s.replace(/<br\s*\/?>/gi, ' '))
    .replace(/\s+/g, ' ')
    .trim();

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
  // Preheader, Outlook-only blocks and conditional-comment markers.
  s = s.replace(/<div style="display:none;[^"]*">[\s\S]*?<\/div>/i, '');
  s = s.replace(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/g, '');
  s = s.replace(/<!--\[if !mso\]><!-->|<!--<!\[endif\]-->/g, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Header: the crest and the "2026 Benchmark Study" tag.
  s = s.replace(/<td[^>]*class="hdr-right"[^>]*>[\s\S]*?<\/td>/g, '');
  s = s.replace(/<img[^>]*>/g, '');
  // The eyebrow label above the heading.
  s = s.replace(/<div style="[^"]*color:#86692C;margin:0 0 10px;">[\s\S]*?<\/div>/g, '');
  // The copy-this-link fallback: the button line already carries the URL.
  s = s.replace(/<p[^>]*>Button not working\?[\s\S]*?<\/p>/g, '');
  // The button.
  s = s.replace(
    /<a href="([^"]*)" style="display:inline-block[^"]*">([\s\S]*?)<\/a>/g,
    (_m, href: string, label: string) =>
      `\n\n${inline(label.replace(/(&nbsp;)*&rarr;/g, ''))}:\n${href}\n\n`,
  );
  // The invitation-code box: its label, then the code.
  s = s.replace(
    /<div[^>]*margin-bottom:8px;">([\s\S]*?)<\/div>\s*<div[^>]*monospace[^>]*>([\s\S]*?)<\/div>/g,
    (_m, label: string, code: string) => `\n\n${inline(label)}:\n${inline(code)}\n\n`,
  );
  // Label / value rows.
  s = s.replace(
    /<tr>\s*<td[^>]*width:38%[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g,
    (_m, label: string, value: string) => `${inline(label)}: ${inline(value)}\n`,
  );
  // Any other link.
  s = s.replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, href: string, text: string) => {
    const label = inline(text);
    if (href.startsWith('mailto:')) return label || href.slice('mailto:'.length);
    return !label || label === href ? href : `${label} (${href})`;
  });
  // The dark footer starts after a separator.
  s = s.replace(/<tr><td class="px" style="background:#1B1530;/g, '\n\n--\n\n$&');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|h1|div|table)>/gi, '\n\n');
  s = s.replace(/<\/tr>/gi, '\n');
  s = decodeEntities(stripTags(s));
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
