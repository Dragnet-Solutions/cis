/**
 * The SMTP fallback sends with the same sender and Reply-To as ZeptoMail:
 * replies go to the support address unless MAIL_REPLY_TO says otherwise.
 * nodemailer is stubbed; nothing leaves the process.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMail = vi.fn(async (_opts: Record<string, unknown>) => ({ messageId: '<m1@smtp>' }));
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));

import { createSmtpTransport } from '../src/mail/smtp';

beforeEach(() => sendMail.mockClear());

describe('SMTP transport — sender and Reply-To', () => {
  it('replies go to the support address by default', async () => {
    const t = createSmtpTransport({
      SMTP_URL: 'smtp://localhost:2525',
      MAIL_FROM: 'noreply@idhub.ng',
    });
    const out = await t.send({ to: 'ada@firm.example', subject: 'S', text: 'T' });
    expect(out).toEqual({ messageId: '<m1@smtp>' });
    const opts = sendMail.mock.calls[0]![0];
    expect(opts['from']).toEqual({ name: 'CIS - Dragnet Study', address: 'noreply@idhub.ng' });
    expect(opts['replyTo']).toEqual({
      name: 'CIS - Dragnet Study',
      address: 'support@cisdragnetstudy.com',
    });
  });

  it('follows SUPPORT_EMAIL, and MAIL_REPLY_TO over it', async () => {
    await createSmtpTransport({
      SMTP_URL: 'smtp://localhost:2525',
      SUPPORT_EMAIL: 'help@cis.example',
    }).send({ to: 'a@firm.example', subject: 'S', text: 'T' });
    expect(sendMail.mock.calls[0]![0]['replyTo']).toMatchObject({ address: 'help@cis.example' });

    await createSmtpTransport({
      SMTP_URL: 'smtp://localhost:2525',
      SUPPORT_EMAIL: 'help@cis.example',
      MAIL_REPLY_TO: 'Desk <desk@cis.example>',
    }).send({ to: 'a@firm.example', subject: 'S', text: 'T' });
    expect(sendMail.mock.calls[1]![0]['replyTo']).toEqual({
      name: 'Desk',
      address: 'desk@cis.example',
    });
  });
});
