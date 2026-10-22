/**
 * Email content: the HTML a notice is sent with (escaped, links, action
 * button, in the shared CIS layout), the plain-text body derived from it, and
 * queueNotice storing both in the outbox.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { queueNotice, renderEmailHtml, renderEmailText, textToHtml } from '../src/email-content';
import { getTestPool, runMigrations, truncateAllTables, closeTestPool } from '../../db/tests/setup';

describe('renderEmailHtml', () => {
  it('escapes every piece of text', () => {
    const html = renderEmailHtml({
      heading: 'Results <b>& more</b>',
      paragraphs: [`Dear O'Neil <script>alert(1)</script> & "co"`],
      action: { label: 'Open <it>', url: 'https://x.example/a?b=1&c="2"' },
      footer: 'Private <i>footer</i>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>footer');
    expect(html).toContain('Results &lt;b&gt;&amp; more&lt;/b&gt;');
    expect(html).toContain(
      'Dear O&#39;Neil &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;',
    );
    expect(html).toContain('href="https://x.example/a?b=1&amp;c=&quot;2&quot;"');
    expect(html).toContain('>Open &lt;it&gt;&nbsp;&nbsp;&rarr;</a>');
    expect(html).toContain('Private &lt;i&gt;footer&lt;/i&gt;');
  });

  it('linkifies bare URLs, leaving trailing punctuation outside the link', () => {
    const html = renderEmailHtml({
      paragraphs: [
        'Sign in at https://cis.example/firm. Or (see https://cis.example/help?x=1&y=2).',
      ],
    });
    expect(html).toContain('<a href="https://cis.example/firm"');
    expect(html).toContain('>https://cis.example/firm</a>.');
    expect(html).toContain('href="https://cis.example/help?x=1&amp;y=2"');
    expect(html).toContain('>https://cis.example/help?x=1&amp;y=2</a>).');
  });

  it('sets the notice in the shared CIS layout, with the action as the design’s button', () => {
    const html = renderEmailHtml(
      {
        paragraphs: ['One', 'Two\nlines'],
        action: { label: 'Go', url: 'https://cis.example/go' },
      },
      { brand: { logoUrl: 'https://cis.example/cis-logo.png', supportEmail: 'help@cis.example' } },
    );
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<img src="https://cis.example/cis-logo.png"');
    expect(html).toContain('max-width:600px');
    expect(html).toContain('mailto:help@cis.example');
    expect(html).toContain('>Two<br>lines</p>');
    expect(html).toMatch(
      /<a href="https:\/\/cis\.example\/go" style="display:inline-block;[^"]*">Go&nbsp;&nbsp;&rarr;<\/a>/,
    );
    // The Outlook button and the copy-this-link fallback.
    expect(html).toContain('<v:roundrect');
    expect(html).toContain('Button not working? Copy this link into your browser');
    expect(html).not.toMatch(/\{\{/);
  });

  it('does not make a link of an unsafe action URL', () => {
    const html = renderEmailHtml({
      paragraphs: [],
      action: { label: 'X', url: 'javascript:alert(1)' },
    });
    expect(html).not.toContain('href="javascript');
  });
});

describe('textToHtml and renderEmailText', () => {
  it('turns blank-line paragraphs of a plain body into escaped HTML paragraphs', () => {
    const html = textToHtml('Hello <you>,\n\nRead it: https://a.example/r\n\nThanks');
    expect(html).toContain('>Hello &lt;you&gt;,</p>');
    expect(html).toContain('<a href="https://a.example/r"');
    expect(html).toContain('>Thanks</p>');
  });

  it('derives the text from the HTML: paragraphs, the action as label and URL, the footer', () => {
    const text = renderEmailText(
      {
        paragraphs: ['Dear Ada,', 'Your report is ready.'],
        action: { label: 'Open', url: 'https://cis.example/firm' },
        footer: 'Private.',
      },
      { brand: { logoUrl: 'https://cis.example/cis-logo.png', supportEmail: 'help@cis.example' } },
    );
    expect(text).toContain(
      'Dear Ada,\n\nYour report is ready.\n\nOpen:\nhttps://cis.example/firm\n\nPrivate.',
    );
    expect(text).toContain('Kind regards,\nThe CIS × Dragnet Study Team');
    expect(text).toContain('Questions? Contact help@cis.example.');
    expect(text).not.toMatch(/<|Button not working/);
  });
});

describe('queueNotice', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = getTestPool();
    await runMigrations();
  });
  beforeEach(async () => {
    await truncateAllTables(pool);
  });
  afterAll(async () => {
    await closeTestPool();
  });

  it('queues text and HTML bodies with the recipient name, inside a transaction too', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const e = await queueNotice(client, {
        kind: 'test-notice',
        refId: null,
        to: 'ada@firm.example',
        toName: 'Ada',
        subject: 'Hello',
        paragraphs: ['Dear Ada,'],
        action: { label: 'Open', url: 'https://cis.example/firm' },
      });
      await client.query('COMMIT');
      expect(e).toMatchObject({
        kind: 'test-notice',
        toAddress: 'ada@firm.example',
        toName: 'Ada',
        status: 'queued',
        attempts: 0,
      });
      expect(e.bodyText).toContain('Dear Ada,\n\nOpen:\nhttps://cis.example/firm');
      expect(e.bodyHtml).toContain('>Open&nbsp;&nbsp;&rarr;</a>');
    } finally {
      client.release();
    }
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM email_outbox');
    expect(rows[0].n).toBe(1);
  });
});
