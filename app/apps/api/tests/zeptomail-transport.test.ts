/**
 * The ZeptoMail transport: the request it makes (URL, Authorization header,
 * body shape), and how it reads success and failure — permanent vs transient —
 * without ever echoing the token. fetch is stubbed; nothing leaves the process.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createZeptomailTransport, zeptomailAuthorization } from '../src/mail/zeptomail';
import { MailSendError, parseAddress, replyToFromEnv } from '../src/mail/transport';
import { selectTransport } from '../src/mail/select-transport';

const TOKEN = 'wSsVR61-test-token-value-0123456789';

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init: RequestInit) => {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ZEPTOMAIL_API_TOKEN: TOKEN,
  MAIL_FROM: 'CIS Study <no-reply@mail.example.org>',
  ...extra,
});

const msg = {
  to: 'ada@firm.example',
  toName: 'Ada Obi',
  subject: 'Hello',
  text: 'Plain body',
  html: '<p>Html body</p>',
  reference: 'outbox-123',
};

async function sendError(promise: Promise<unknown>): Promise<MailSendError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MailSendError);
    return err as MailSendError;
  }
  throw new Error('expected the send to fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ZeptoMail transport — the request', () => {
  it('posts JSON to the default endpoint with the token as a Zoho-enczapikey header', async () => {
    const fetchMock = stubFetch(201, { data: [{ code: 'EM_104' }], request_id: 'req-abc' });
    const t = createZeptomailTransport(env());
    expect(t.name).toBe('zeptomail');
    const out = await t.send(msg);
    expect(out).toEqual({ messageId: 'req-abc' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.zeptomail.com/v1.1/email');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Zoho-enczapikey ${TOKEN}`);
    expect(headers['Accept']).toBe('application/json');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(JSON.parse(init.body as string)).toEqual({
      from: { address: 'no-reply@mail.example.org', name: 'CIS Study' },
      to: [{ email_address: { address: 'ada@firm.example', name: 'Ada Obi' } }],
      subject: 'Hello',
      textbody: 'Plain body',
      htmlbody: '<p>Html body</p>',
      client_reference: 'outbox-123',
      track_clicks: false,
      track_opens: false,
      // No MAIL_REPLY_TO or SUPPORT_EMAIL: replies still go to the support address.
      reply_to: [{ address: 'support@cisdragnetstudy.com', name: 'CIS Study' }],
    });
  });

  it('uses a token that already carries the prefix verbatim, and a regional URL', async () => {
    const fetchMock = stubFetch(200, { data: [], request_id: 'r1' });
    await createZeptomailTransport(
      env({
        ZEPTOMAIL_API_TOKEN: `Zoho-enczapikey ${TOKEN}`,
        ZEPTOMAIL_API_URL: 'https://api.zeptomail.eu/v1.1/email',
      }),
    ).send(msg);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.zeptomail.eu/v1.1/email');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      `Zoho-enczapikey ${TOKEN}`,
    );
    expect(zeptomailAuthorization(`  ${TOKEN} `)).toBe(`Zoho-enczapikey ${TOKEN}`);
  });

  it('omits the optional fields when absent, and adds reply_to from MAIL_REPLY_TO', async () => {
    const fetchMock = stubFetch(200, { data: [], request_id: 'r2' });
    await createZeptomailTransport(
      env({
        MAIL_FROM: 'no-reply@mail.example.org',
        MAIL_REPLY_TO: 'Help <help@mail.example.org>',
      }),
    ).send({ to: 'b@firm.example', subject: 'S', text: 'T' });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.from).toEqual({
      address: 'no-reply@mail.example.org',
      name: 'CIS - Dragnet Study',
    });
    expect(body.to).toEqual([{ email_address: { address: 'b@firm.example' } }]);
    expect(body).not.toHaveProperty('htmlbody');
    expect(body).not.toHaveProperty('client_reference');
    expect(body.reply_to).toEqual([{ address: 'help@mail.example.org', name: 'Help' }]);
  });

  it('without MAIL_REPLY_TO, replies go to SUPPORT_EMAIL', async () => {
    const fetchMock = stubFetch(200, { data: [], request_id: 'r3' });
    await createZeptomailTransport(env({ SUPPORT_EMAIL: ' help@cis.example ' })).send(msg);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.reply_to).toEqual([{ address: 'help@cis.example', name: 'CIS Study' }]);
  });
});

describe('Reply-To, for every transport', () => {
  it('is MAIL_REPLY_TO, else SUPPORT_EMAIL, else support@cisdragnetstudy.com', () => {
    const from = { address: 'noreply@idhub.ng', name: 'CIS - Dragnet Study' };
    expect(
      replyToFromEnv({ MAIL_REPLY_TO: 'a@x.example', SUPPORT_EMAIL: 'b@x.example' }, from),
    ).toEqual({ address: 'a@x.example', name: 'CIS - Dragnet Study' });
    expect(replyToFromEnv({ SUPPORT_EMAIL: 'b@x.example' }, from)).toEqual({
      address: 'b@x.example',
      name: 'CIS - Dragnet Study',
    });
    expect(replyToFromEnv({}, from)).toEqual({
      address: 'support@cisdragnetstudy.com',
      name: 'CIS - Dragnet Study',
    });
    // The sender name defaults to the study's name.
    expect(replyToFromEnv({ MAIL_FROM: 'noreply@idhub.ng' })).toEqual({
      address: 'support@cisdragnetstudy.com',
      name: 'CIS - Dragnet Study',
    });
  });
});

describe('ZeptoMail transport — failures', () => {
  it('a 400 is permanent, with a readable reason from the error details', async () => {
    stubFetch(400, {
      error: {
        code: 'TM_3201',
        message: 'Mandatory Field missing',
        details: [{ code: 'SERR_101', message: 'Invalid email address', target: 'to' }],
        request_id: 'x',
      },
    });
    const err = await sendError(createZeptomailTransport(env()).send(msg));
    expect(err.permanent).toBe(true);
    expect(err.message).toContain('ZeptoMail 400');
    expect(err.message).toContain('TM_3201 Mandatory Field missing');
    expect(err.message).toContain('SERR_101 Invalid email address (to)');
    expect(err.message).not.toContain(TOKEN);
  });

  it('reads the {data:{error_code,message}} error shape too', async () => {
    stubFetch(401, { data: { error_code: 'TM_102', message: 'Invalid API Token found' } });
    const err = await sendError(createZeptomailTransport(env()).send(msg));
    expect(err.permanent).toBe(true);
    expect(err.message).toBe('ZeptoMail 401: TM_102 Invalid API Token found');
  });

  it('503 and 429 are transient', async () => {
    stubFetch(503, 'Service Unavailable');
    const e503 = await sendError(createZeptomailTransport(env()).send(msg));
    expect(e503.permanent).toBe(false);
    expect(e503.message).toBe('ZeptoMail 503');

    stubFetch(429, { error: { code: 'TM_4001', message: 'Rate limit exceeded' } });
    const e429 = await sendError(createZeptomailTransport(env()).send(msg));
    expect(e429.permanent).toBe(false);
  });

  it('a network error or timeout is transient', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const net = await sendError(createZeptomailTransport(env()).send(msg));
    expect(net.permanent).toBe(false);
    expect(net.message).toContain('fetch failed');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );
    const slow = await sendError(createZeptomailTransport(env()).send(msg));
    expect(slow.permanent).toBe(false);
    expect(slow.message).toContain('timed out');
  });

  it('never lets the token into an error, even if the provider echoes it', async () => {
    stubFetch(400, { error: { code: 'X', message: `bad token ${TOKEN}` } });
    const err = await sendError(createZeptomailTransport(env()).send(msg));
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('[redacted]');
  });
});

describe('selectTransport and sender parsing', () => {
  it('prefers ZeptoMail, then SMTP, else none', () => {
    expect(selectTransport({ ZEPTOMAIL_API_TOKEN: TOKEN, SMTP_URL: 'smtp://x' })?.name).toBe(
      'zeptomail',
    );
    expect(selectTransport({ SMTP_URL: 'smtp://localhost:2525' })?.name).toBe('smtp');
    expect(selectTransport({})).toBeNull();
    expect(selectTransport({ ZEPTOMAIL_API_TOKEN: '  ' })).toBeNull();
  });

  it('parses "Name <addr>", quoted names and bare addresses', () => {
    expect(parseAddress('CIS - Dragnet Study <a@b.org>')).toEqual({
      address: 'a@b.org',
      name: 'CIS - Dragnet Study',
    });
    expect(parseAddress('"The Team" <a@b.org>')).toEqual({ address: 'a@b.org', name: 'The Team' });
    expect(parseAddress('a@b.org')).toEqual({ address: 'a@b.org', name: 'CIS - Dragnet Study' });
    expect(parseAddress('')).toBeNull();
  });
});
