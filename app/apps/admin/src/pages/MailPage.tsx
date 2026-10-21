import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AdminClient } from '../api/client';
import { ApiError, type MailStatus, type MailTestResult } from '../api/types';

/**
 * Setup › Mail — is email actually going out? Shows which mail service this
 * server sends through, or a red warning when none is configured (notices are
 * then only recorded, never sent), how the outbox stands over the last seven
 * days, recent failures, and a "send a test email" form that reports what
 * happened to it. "Sent" from ZeptoMail means accepted by ZeptoMail, not
 * delivered to the inbox.
 */

const NO_TRANSPORT_MESSAGE =
  'Emails are being recorded but NOT sent — ZEPTOMAIL_API_TOKEN is not set on this server.';

/** The red "nothing is being sent" banner; renders nothing when mail works. */
export function MailServiceBanner({ client }: { client: AdminClient }): JSX.Element | null {
  const [status, setStatus] = useState<MailStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    client
      .getMailStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // The Mail page itself surfaces load failures.
      });
    return () => {
      cancelled = true;
    };
  }, [client]);
  if (!status || status.transport !== 'none') return null;
  return <NoTransportBanner recorded={status.recentLogged} />;
}

function NoTransportBanner({ recorded }: { recorded: number }): JSX.Element {
  return (
    <div className="err" role="alert" style={{ display: 'block', margin: '0 0 16px' }}>
      {NO_TRANSPORT_MESSAGE}
      {recorded > 0 && (
        <span style={{ display: 'block', fontWeight: 400, marginTop: 4 }}>
          {recorded} email{recorded === 1 ? ' was' : 's were'} recorded without being sent in the
          last 7 days.
        </span>
      )}
    </div>
  );
}

const TRANSPORT_LABEL: Record<MailStatus['transport'], string> = {
  zeptomail: 'ZeptoMail',
  smtp: 'SMTP',
  none: 'None — nothing is sent',
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function describeTest(r: MailTestResult): { cls: string; text: string } {
  switch (r.status) {
    case 'sent':
      return {
        cls: 'note',
        text:
          `Accepted by ${r.provider === 'zeptomail' ? 'ZeptoMail' : (r.provider ?? 'the mail service')}` +
          (r.providerMessageId ? ` (message id ${r.providerMessageId})` : '') +
          '. Check the inbox — ZeptoMail does not confirm arrival, only bounces.',
      };
    case 'logged':
      return {
        cls: 'err',
        text: 'Recorded but NOT sent: no mail service is configured on this server.',
      };
    case 'failed':
      return { cls: 'err', text: `The mail service refused it: ${r.error ?? 'no reason given'}.` };
    default:
      return {
        cls: 'warnbox',
        text: r.retrying
          ? `Not sent yet — the mail service refused it for now (${r.error ?? 'no reason given'}). It will be retried automatically.`
          : 'Still waiting to go after 10 seconds. The background sender may be busy or stopped.',
      };
  }
}

export function MailPage({ client }: { client: AdminClient }): JSX.Element {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [result, setResult] = useState<MailTestResult | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await client.getMailStatus());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the mail status');
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendTest(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setTestError(null);
    setResult(null);
    try {
      setResult(await client.sendTestEmail(to.trim()));
      await load();
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : 'Could not send the test email');
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  const outcome = result ? describeTest(result) : null;
  const o = status.outbox;

  return (
    <main>
      <p className="eyebrow">Setup</p>
      <h1 tabIndex={-1}>Mail</h1>
      <p className="lede">
        Whether this server is actually sending email, and what happened to the last week’s.
      </p>

      {status.transport === 'none' && <NoTransportBanner recorded={status.recentLogged} />}
      {error && <div className="err">{error}</div>}

      <dl className="kv">
        <dt>Mail service</dt>
        <dd>{TRANSPORT_LABEL[status.transport]}</dd>
        {status.apiHost && (
          <>
            <dt>Sends through</dt>
            <dd>{status.apiHost}</dd>
          </>
        )}
        <dt>Sender address</dt>
        <dd>{status.from ?? 'Not set (MAIL_FROM) — a placeholder address is used'}</dd>
        <dt>Bounce and open reports</dt>
        <dd>
          {status.webhookConfigured
            ? 'Webhook secret set — ZeptoMail can report bounces, opens and clicks'
            : 'Not set up (ZEPTOMAIL_WEBHOOK_SECRET) — bounces are not reported back'}
        </dd>
        <dt>Background sender</dt>
        <dd>{status.dispatcherRunning ? 'Running' : 'Not running on this server'}</dd>
        <dt>Oldest email waiting</dt>
        <dd>{fmt(status.oldestQueuedAt)}</dd>
      </dl>

      <h2 style={{ marginTop: 22 }}>Last 7 days</h2>
      <div className="statgrid">
        <div className="stat">
          <b>{o.sent}</b>
          <span>Accepted by the mail service</span>
        </div>
        <div className="stat">
          <b>{o.queued}</b>
          <span>Waiting to go</span>
        </div>
        <div className="stat">
          <b>{o.failed}</b>
          <span>Failed</span>
        </div>
        <div className="stat">
          <b>{o.logged}</b>
          <span>Recorded, not sent</span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Accepted means the mail service took the message. ZeptoMail does not confirm that it reached
        the inbox — only a bounce is reported back.
      </p>

      <h2 style={{ marginTop: 22 }}>Recent failures</h2>
      {status.recentFailures.length === 0 ? (
        <p>None.</p>
      ) : (
        <div className="tablewrap">
          <table className="ftbl">
            <thead>
              <tr>
                <th>When</th>
                <th>To</th>
                <th>Email</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {status.recentFailures.map((f, i) => (
                <tr key={`${f.at}-${i}`}>
                  <td>{fmt(f.at)}</td>
                  <td>{f.to}</td>
                  <td>{f.kind}</td>
                  <td>{f.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="stage" style={{ marginTop: 22 }}>
        <div className="stagehead">
          <h2>Send a test email</h2>
        </div>
        <div className="stagebody">
          <form onSubmit={sendTest}>
            <div className="field">
              <label htmlFor="mailTestTo">Send to</label>
              <input
                id="mailTestTo"
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                required
              />
            </div>
            <div className="actions">
              <button type="submit" className="btn" disabled={busy || !to.trim()}>
                {busy ? 'Sending… (up to 10 seconds)' : 'Send a test email'}
              </button>
            </div>
          </form>
          {testError && <div className="err">{testError}</div>}
          {outcome && (
            <div
              className={outcome.cls}
              role="status"
              style={outcome.cls === 'err' ? { display: 'block' } : undefined}
            >
              {outcome.text}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
