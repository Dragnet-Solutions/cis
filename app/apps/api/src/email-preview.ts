/**
 * Render every email the platform sends, with sample data, to HTML files you
 * can open in a browser — and, only when asked, send one of each to a mailbox.
 *
 *   pnpm --filter @cis/api email:preview                       → app/tmp/email-previews/
 *   pnpm --filter @cis/api email:preview --out <dir>
 *   pnpm --filter @cis/api email:preview --send-to you@example.com
 *
 * Sending uses the configured mail service (ZEPTOMAIL_API_TOKEN, else
 * SMTP_URL) and MAIL_FROM, read from the environment and app/.env. Nothing is
 * sent without --send-to; the outbox and the database are never touched.
 * Links in the previews use PORTAL_URL (the logos are <PORTAL_URL>/cis-logo.png and
 * <PORTAL_URL>/dragnet-logo.png).
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SAMPLE_BASE_NOTICES,
  SAMPLE_FIELDS,
  TEMPLATE_IDS,
  emailBrand,
  htmlToText,
  renderEmailHtml,
  renderTemplate,
  type EmailBrand,
  type RenderedEmail,
} from '@cis/domain';
import { selectTransport, transportKind } from './mail/select-transport';

const APP_ROOT = resolve(__dirname, '..', '..', '..');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function main(): Promise<void> {
  const envFile = join(APP_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const out = resolve(arg('--out') ?? join(APP_ROOT, 'tmp', 'email-previews'));
  const sendTo = arg('--send-to');
  if (sendTo !== undefined && !EMAIL_RE.test(sendTo)) {
    throw new Error(`--send-to must be an email address (got "${sendTo}")`);
  }

  // The files show the logos from copies beside them (the deployed ones may not
  // exist yet); the emails sent carry the real <PORTAL_URL>/… addresses.
  const render = (brand: EmailBrand): Array<{ name: string; email: RenderedEmail }> => {
    const emails: Array<{ name: string; email: RenderedEmail }> = [];
    for (const id of TEMPLATE_IDS) {
      emails.push({ name: id, email: renderTemplate(id, SAMPLE_FIELDS[id], { brand }) });
    }
    for (const n of SAMPLE_BASE_NOTICES) {
      const html = renderEmailHtml(n, { brand, edition: '2026' });
      emails.push({
        name: `BASE-${n.kind}`,
        email: { subject: n.subject, html, text: htmlToText(html) },
      });
    }
    return emails;
  };
  const files = render({
    ...emailBrand(),
    logoUrl: 'cis-logo.png',
    partnerLogoUrl: 'dragnet-logo.png',
  });

  mkdirSync(out, { recursive: true });
  for (const logo of ['cis-logo.png', 'dragnet-logo.png']) {
    copyFileSync(join(APP_ROOT, 'apps', 'admin', 'public', logo), join(out, logo));
  }
  for (const { name, email } of files) {
    writeFileSync(join(out, `${name}.html`), email.html);
    writeFileSync(join(out, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}\n`);
  }
  const rows = files
    .map(
      ({ name, email }) =>
        `<tr><td><a href="${name}.html">${name}</a></td><td>${escape(email.subject)}</td><td><a href="${name}.txt">text</a></td></tr>`,
    )
    .join('\n');
  writeFileSync(
    join(out, 'index.html'),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Email previews</title>
<style>body{font:15px/1.5 Arial,sans-serif;margin:32px;color:#1B1530}td{padding:4px 12px;border-bottom:1px solid #E6E2EE}a{color:#22006A}</style>
</head><body><h1>Email previews (${files.length})</h1>
<p>Logos: ${escape(emailBrand().logoUrl)}, ${escape(emailBrand().partnerLogoUrl)} · Support: ${escape(emailBrand().supportEmail)}</p>
<table>${rows}</table></body></html>\n`,
  );
  console.warn(`Wrote ${files.length} previews to ${out}`);

  if (sendTo === undefined) return;
  const emails = render(emailBrand());
  const transport = selectTransport();
  if (!transport) {
    throw new Error(
      'No mail service is configured (set ZEPTOMAIL_API_TOKEN or SMTP_URL in app/.env)',
    );
  }
  console.warn(`Sending ${emails.length} emails to ${sendTo} through ${transportKind()}…`);
  for (const { name, email } of emails) {
    await transport.send({
      to: sendTo,
      subject: `[Preview ${name}] ${email.subject}`,
      text: email.text,
      html: email.html,
      reference: `preview-${name}`,
    });
    console.warn(`  sent ${name}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
