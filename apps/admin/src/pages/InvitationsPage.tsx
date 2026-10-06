import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdminClient } from '../api/client';
import {
  ApiError,
  type AudienceCategory,
  type BatchReport,
  type InvitationRequestItem,
  type MessageAudienceKind,
  type MessageBatch,
  type MessageRecipient,
  type MessageTemplate,
  type UploadCheckKind,
} from '../api/types';

/**
 * UX-OPS-002 — Study Operations: Invitations, live-wired to the real evaluator
 * (`@cis/domain` invitations-service, via `apps/api/src/routes/invitations.ts`):
 *   - Audience counts are live queries against Phase 4's firm/seat state and
 *     Phase 3's contact-consent records — never hardcoded.
 *   - Deduplication is per TEMPLATE, not per batch, across all earlier batches.
 *   - File validation is exactly four checks; there is no fifth register check
 *     (removed in the artefact's own v3.16 — a row that resolves to nothing
 *     still sends and shows in the delivery report, not blocked before).
 *   - An open is a floor, never a reader count (null ≠ 0 — rendered absent when
 *     the provider didn't report it); a click is a real event.
 *   - No resend-to-bounced action exists anywhere in this UI or the API path
 *     underneath it.
 *   - No respondent-in-progress audience.
 */

type Tab = 'messages' | 'templates' | 'requests';
type MsgView = 'list' | 'batch' | 'wizard';

const PROBLEM_LABEL: Record<UploadCheckKind, string> = {
  no_address: 'No address',
  malformed_address: 'Malformed address',
  in_file_duplicate: 'Duplicated within the file',
  already_sent: 'Already sent this template',
};

/** Minimal CSV parsing (firmName,email columns, optional header row) — the
 *  four real validation checks happen server-side in validateUploadFile;
 *  this only turns file text into rows to send it. */
function parseCsv(text: string): Array<{ firmName: string; email: string }> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows = lines.map((line) => {
    const [firmName = '', email = ''] = line.split(',').map((c) => c.trim());
    return { firmName, email };
  });
  if (rows.length && /email/i.test(rows[0]!.email) && /firm/i.test(rows[0]!.firmName)) {
    rows.shift(); // header row
  }
  return rows;
}

export function InvitationsPage({
  client,
  editionId,
}: {
  client: AdminClient;
  editionId: string;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('messages');
  const [msgView, setMsgView] = useState<MsgView>('list');
  const [batchId, setBatchId] = useState<string | null>(null);

  const [audiences, setAudiences] = useState<AudienceCategory[] | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [batches, setBatches] = useState<MessageBatch[]>([]);
  const [batchReports, setBatchReports] = useState<Record<string, BatchReport>>({});
  const [requests, setRequests] = useState<InvitationRequestItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [aud, tpl, bat, req] = await Promise.all([
        client.listAudiences(editionId),
        client.listMessageTemplates(editionId),
        client.listInvitationBatches(editionId),
        client.listInvitationRequests(editionId, true),
      ]);
      setAudiences(aud.audiences);
      setTemplates(tpl.templates);
      setBatches(bat.batches);
      setRequests(req.requests);
      const reports = await Promise.all(
        bat.batches.map((b) => client.getInvitationBatchReport(b.id)),
      );
      setBatchReports(Object.fromEntries(bat.batches.map((b, i) => [b.id, reports[i]!.report])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load invitations');
    }
  }, [client, editionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const waiting = requests.filter((r) => !r.resolved).length;
  // Distinct firms, not a sum over messages — a firm sent two templates is still
  // one firm written to. The server's own audience counts give it directly.
  const firmAudience = (id: string): number | null =>
    audiences?.find((c) => c.key === 'firms')?.audiences.find((a) => a.id === id)?.count ?? null;
  const allFirms = firmAudience('all');
  const neverWritten = firmAudience('newaddr2');
  const totalFirmsWrittenTo =
    allFirms !== null && neverWritten !== null
      ? allFirms - neverWritten
      : Object.values(batchReports).reduce((s, r) => s + r.firms, 0);
  const totalBounced = Object.values(batchReports).reduce((s, r) => s + r.bounced, 0);

  if (audiences === null) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  return (
    <main>
      <p className="eyebrow">Study operations · current edition</p>
      <h1 tabIndex={-1}>Invitations</h1>

      {error && <div className="err">{error}</div>}

      <div className="statgrid">
        <div className="stat">
          <b>{batches.length}</b>
          <span>Messages sent</span>
        </div>
        <div className="stat">
          <b>{totalFirmsWrittenTo}</b>
          <span>Firms written to</span>
        </div>
        <div className="stat">
          <b>{totalBounced}</b>
          <span>Needing a new address</span>
        </div>
        <div className="stat">
          <b>{waiting}</b>
          <span>Requests waiting</span>
        </div>
      </div>

      <div className="actions" style={{ marginBottom: 12 }}>
        {(['messages', 'templates', 'requests'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className="btn-2"
            aria-pressed={t === tab}
            style={t === tab ? { borderColor: 'var(--dragnet-black)' } : undefined}
            onClick={() => {
              setTab(t);
              setMsgView('list');
            }}
          >
            {t === 'messages'
              ? 'Messages'
              : t === 'templates'
                ? 'Templates'
                : `Requests${waiting ? ` (${waiting})` : ''}`}
          </button>
        ))}
      </div>

      {tab === 'messages' && msgView === 'list' && (
        <MessagesList
          batches={batches}
          batchReports={batchReports}
          onOpen={(id) => {
            setBatchId(id);
            setMsgView('batch');
          }}
          onNew={() => setMsgView('wizard')}
        />
      )}
      {tab === 'messages' && msgView === 'batch' && batchId && batchReports[batchId] && (
        <BatchReportView
          client={client}
          report={batchReports[batchId]}
          onBack={() => setMsgView('list')}
        />
      )}
      {tab === 'messages' && msgView === 'wizard' && (
        <NewMessageWizard
          client={client}
          editionId={editionId}
          templates={templates}
          audiences={audiences}
          onSent={() => void load()}
          onDone={() => {
            setMsgView('list');
            void load();
          }}
        />
      )}
      {tab === 'templates' && (
        <TemplatesView client={client} editionId={editionId} templates={templates} onSaved={load} />
      )}
      {tab === 'requests' && (
        <RequestsView client={client} templates={templates} requests={requests} onResolved={load} />
      )}
    </main>
  );
}

function MessagesList({
  batches,
  batchReports,
  onOpen,
  onNew,
}: {
  batches: MessageBatch[];
  batchReports: Record<string, BatchReport>;
  onOpen: (id: string) => void;
  onNew: () => void;
}): JSX.Element {
  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button type="button" className="btn" onClick={onNew}>
          New message
        </button>
      </div>
      <div className="tablewrap">
        <table className="ftbl">
          <thead>
            <tr>
              <th>Message</th>
              <th>Sent</th>
              <th>Firms</th>
              <th>Delivered</th>
              <th>Opened</th>
              <th>Clicked</th>
              <th>Bounced</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 && (
              <tr>
                <td colSpan={8}>No messages sent yet.</td>
              </tr>
            )}
            {batches.map((b) => {
              const r = batchReports[b.id];
              return (
                <tr key={b.id}>
                  <td>
                    {r?.templateName ?? '—'}
                    <span className="tag soft" style={{ marginLeft: 6 }}>
                      {b.audienceLabel}
                    </span>
                  </td>
                  <td>{new Date(b.sentAt).toLocaleDateString()}</td>
                  <td>{r?.firms ?? '—'}</td>
                  <td>{r?.delivered ?? '—'}</td>
                  <td>
                    {!r || !r.opensReported ? (
                      <span className="tag soft">not reported</span>
                    ) : (
                      r.opened
                    )}
                  </td>
                  <td>
                    {!r || !r.clicksReported ? (
                      <span className="tag soft">not reported</span>
                    ) : (
                      r.clicked
                    )}
                  </td>
                  <td>{r?.bounced ? <span className="tag risk">{r.bounced}</span> : 0}</td>
                  <td>
                    <button type="button" className="btn-2" onClick={() => onOpen(b.id)}>
                      Open
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BatchReportView({
  client,
  report,
  onBack,
}: {
  client: AdminClient;
  report: BatchReport;
  onBack: () => void;
}): JSX.Element {
  const [bounced, setBounced] = useState<MessageRecipient[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function showBounced(): Promise<void> {
    setError(null);
    try {
      const r = await client.getBouncedRecipients(report.batch.id);
      setBounced(r.bounced);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the bounced addresses');
    }
  }

  return (
    <>
      <button type="button" className="back" onClick={onBack}>
        ← All messages
      </button>
      <h2>{report.templateName}</h2>
      <p className="lede">
        Sent {new Date(report.batch.sentAt).toLocaleString()} · {report.batch.audienceLabel}
      </p>
      <div className="statgrid">
        <div className="stat">
          <b>{report.firms}</b>
          <span>Sent to</span>
        </div>
        <div className="stat">
          <b>{report.delivered}</b>
          <span>Delivered</span>
        </div>
        <div className="stat">
          <b>{report.opensReported ? report.opened : '—'}</b>
          <span>Opened {report.opensReported && <em>indicative</em>}</span>
        </div>
        <div className="stat">
          <b>{report.clicksReported ? report.clicked : '—'}</b>
          <span>Clicked the link</span>
        </div>
        <div className="stat">
          <b>{report.bounced}</b>
          <span>Bounced</span>
        </div>
      </div>

      {report.opensReported ? (
        <div className="note">
          <p>
            <b>A click is a real event. An open is not, quite.</b> Blocked images and privacy
            proxies mean some people who read a message are never counted as opening it, so the open
            figure is a floor rather than a count. Useful for comparing one message against another,
            and <b>never quoted as a number of readers</b>.
            {report.deliveredNeverOpened > 0 && (
              <> {report.deliveredNeverOpened} delivered but never opened.</>
            )}
            {report.openedNotClicked > 0 && (
              <> {report.openedNotClicked} opened but never clicked.</>
            )}
          </p>
        </div>
      ) : (
        <div className="note">
          <p>
            The sending service did not report opens or clicks for this batch, so those columns are
            shown as <b>not reported</b> — never as zero. Delivery and bounce reporting stand
            regardless of the provider.
          </p>
        </div>
      )}

      {report.bounced > 0 && (
        <div className="warnbox" style={{ marginTop: 12 }}>
          <b>
            {report.bounced} address{report.bounced > 1 ? 'es' : ''} bounced.
          </b>
          <p style={{ margin: '6px 0 0' }}>
            Nothing can be sent to a bounced address until a working one exists — either CIS
            supplies a replacement, or the firm requests an invitation itself. There is deliberately
            no "resend to the bounced address" action anywhere on this surface.
          </p>
          {error && <div className="err">{error}</div>}
          {bounced === null ? (
            <div className="actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn-2" onClick={() => void showBounced()}>
                List the addresses that bounced
              </button>
            </div>
          ) : (
            <ul style={{ margin: '10px 0 0', paddingLeft: 20 }}>
              {bounced.map((r) => (
                <li key={r.id}>{r.recipientEmail ?? r.firmName ?? '—'}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

function NewMessageWizard({
  client,
  editionId,
  templates,
  audiences,
  onSent,
  onDone,
}: {
  client: AdminClient;
  editionId: string;
  templates: MessageTemplate[];
  audiences: AudienceCategory[];
  onSent: () => void;
  onDone: () => void;
}): JSX.Element {
  const [step, setStep] = useState(1);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [audienceId, setAudienceId] = useState<string | null>(null);
  const [uploadRows, setUploadRows] = useState<
    Array<{ firmName: string; email: string; organizationId: string | null }>
  >([]);
  const [uploadCheck, setUploadCheck] = useState<{
    validRows: Array<{ firmName: string; email: string }>;
    problems: Array<{ kind: UploadCheckKind; row: number; value: string }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    attempted: number;
    sent: number;
    skippedDuplicates: number;
  } | null>(null);

  const template = templates.find((t) => t.id === templateId) ?? null;
  const category = audiences.find((a) => a.key === cat) ?? null;
  const audience = category?.audiences.find((a) => a.id === audienceId) ?? null;

  const canContinue =
    (step === 1 && templateId) ||
    (step === 2 && audienceId && (audienceId !== 'upload' || uploadCheck)) ||
    step === 3;

  async function handleFile(file: File): Promise<void> {
    setError(null);
    const text = await file.text();
    const parsed = parseCsv(text);
    if (!templateId) return;
    try {
      // Resolve each row's firm name to a real organization id, once, so the
      // fourth validation check (already sent this template) can fire for an
      // upload the same way it already does for a firm-audience send — a
      // name with no register match resolves to null and is simply unmatched,
      // never blocked (no fifth "register match" check was added).
      const { resolved } = await client.resolveFirmNames(
        editionId,
        parsed.map((r) => r.firmName),
      );
      const rows = parsed.map((r) => ({ ...r, organizationId: resolved[r.firmName] ?? null }));
      setUploadRows(rows);
      const check = await client.validateUpload(editionId, templateId, rows);
      setUploadCheck(check);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not validate the file');
    }
  }

  async function send(): Promise<void> {
    if (!templateId || !audienceId) return;
    setBusy(true);
    setError(null);
    try {
      const byEmail = new Map(uploadRows.map((r) => [r.email.toLowerCase(), r.organizationId]));
      const r = await client.sendInvitationBatch(editionId, {
        templateId,
        audienceId,
        ...(audienceId === 'upload' && uploadCheck
          ? {
              uploadRows: uploadCheck.validRows.map((row) => ({
                ...row,
                organizationId: byEmail.get(row.email.toLowerCase()) ?? null,
              })),
            }
          : {}),
      });
      setResult(r);
      // Refresh the page header's counts now, not only when "Done" is pressed.
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the message');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <>
        <h2>Sent.</h2>
        <div className="note">
          <p>
            {result.sent} of {result.attempted} sent.
            {result.skippedDuplicates > 0 &&
              ` ${result.skippedDuplicates} skipped — already received this template.`}
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onDone}>
            Done
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <button type="button" className="back" onClick={onDone}>
        ← Cancel
      </button>
      <p className="eyebrow">Step {step} of 4</p>
      {error && <div className="err">{error}</div>}

      {step === 1 && (
        <>
          <h2>Choose a template.</h2>
          <div className="tablewrap">
            <table className="ftbl">
              <tbody>
                {templates.map((t) => (
                  <tr
                    key={t.id}
                    style={
                      templateId === t.id
                        ? { outline: '2px solid var(--dragnet-black)' }
                        : undefined
                    }
                  >
                    <td>
                      <b>{t.name}</b>
                      <br />
                      <span className="tag soft">{t.subject}</span>
                    </td>
                    <td>
                      <button type="button" className="btn-2" onClick={() => setTemplateId(t.id)}>
                        {templateId === t.id ? 'Chosen' : 'Choose'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h2>Who is it going to?</h2>
          <p className="lede">Pick a group, or upload your own list.</p>
          {!cat ? (
            <div className="statgrid">
              {audiences.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="stat"
                  style={{ cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => setCat(c.key)}
                >
                  <b>{c.label}</b>
                  <span>
                    {c.audiences.length} option{c.audiences.length === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <button
                type="button"
                className="back"
                onClick={() => {
                  setCat(null);
                  setAudienceId(null);
                  setUploadCheck(null);
                }}
              >
                ← All categories
              </button>
              {category?.audiences.map((a) => (
                <label
                  key={a.id}
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: '12px 14px',
                    marginBottom: 8,
                    border: '1px solid var(--polish-line-strong, #c8c8c8)',
                    borderRadius: 8,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="aud"
                    checked={audienceId === a.id}
                    onChange={() => {
                      setAudienceId(a.id);
                      setUploadCheck(null);
                    }}
                  />
                  <span>
                    <b>{a.label}</b> {a.count !== null && <span className="tag ok">{a.count}</span>}
                    <br />
                    <span className="tag soft">{a.sub}</span>
                  </span>
                </label>
              ))}
              {audienceId === 'upload' && (
                <div className="note">
                  <b>Upload a CSV</b>
                  <p>
                    One row per firm: firm name and email address. The file is checked for four
                    things — missing address, malformed address, in-file duplicate, and a firm
                    already sent this template. Anything else is answered by the delivery report
                    after sending.
                  </p>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleFile(file);
                    }}
                  />
                  {uploadCheck && (
                    <div style={{ marginTop: 10 }}>
                      <p>
                        <b>{uploadCheck.validRows.length}</b> of <b>{uploadRows.length}</b> rows
                        will send.
                      </p>
                      {uploadCheck.problems.length > 0 && (
                        <div className="tablewrap">
                          <table className="ftbl">
                            <thead>
                              <tr>
                                <th>Row</th>
                                <th>Value</th>
                                <th>Problem</th>
                              </tr>
                            </thead>
                            <tbody>
                              {uploadCheck.problems.map((p, i) => (
                                <tr key={i}>
                                  <td>{p.row}</td>
                                  <td>{p.value}</td>
                                  <td>
                                    <span className="tag risk">{PROBLEM_LABEL[p.kind]}</span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {step === 3 && (
        <>
          <h2>Check</h2>
          <div className="note">
            <p>
              <b>Template:</b> {template?.name}
            </p>
            <p>
              <b>Audience:</b> {audience?.label}
              {audienceId === 'upload'
                ? ` (${uploadCheck?.validRows.length ?? 0} will send)`
                : audience?.count !== null && audience
                  ? ` (${audience.count})`
                  : ''}
            </p>
            <p style={{ marginBottom: 0 }}>
              A firm that already received <b>this template</b> in an earlier batch is skipped
              automatically — deduplication is per template, not per batch, so a firm can still
              receive a different template.
            </p>
          </div>
        </>
      )}

      {step === 4 && (
        <>
          <h2>Ready to send.</h2>
          <div className="actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void send()}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </>
      )}

      {step < 4 && (
        <div className="actions" style={{ marginTop: 14 }}>
          {step > 1 && (
            <button type="button" className="btn-2" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={!canContinue}
            onClick={() => setStep(step + 1)}
          >
            Continue
          </button>
        </div>
      )}
    </>
  );
}

function TemplatesView({
  client,
  editionId,
  templates,
  onSaved,
}: {
  client: AdminClient;
  editionId: string;
  templates: MessageTemplate[];
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState<MessageTemplate | 'new' | null>(null);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [audienceKind, setAudienceKind] = useState<MessageAudienceKind>('firm');
  const [requiresCode, setRequiresCode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Presence check, not correctness — a code-bearing firm template must carry {{code}}.
  const clientErr = useMemo(() => {
    if (editing === null) return '';
    if (!name.trim()) return 'A template name is required.';
    if (audienceKind === 'firm' && requiresCode && !body.includes('{{code}}'))
      return 'A firm invitation template must include {{code}} — a code-less invitation is unusable.';
    return '';
  }, [editing, name, body, audienceKind, requiresCode]);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await client.saveMessageTemplate(editionId, {
        name,
        subject,
        body,
        audienceKind,
        requiresCode: audienceKind === 'firm' ? requiresCode : false,
      });
      setEditing(null);
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the template');
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <>
        <button type="button" className="back" onClick={() => setEditing(null)}>
          ← All templates
        </button>
        <h2>{name || 'New template'}</h2>
        {error && <div className="err">{error}</div>}
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="field">
          <label>Audience kind</label>
          <select
            value={audienceKind}
            onChange={(e) => setAudienceKind(e.target.value as MessageAudienceKind)}
          >
            <option value="firm">Firm</option>
            <option value="participant">Participant</option>
            <option value="regulator">Regulator</option>
            <option value="upload">Uploaded list</option>
          </select>
        </div>
        <div className="field">
          <label>Message</label>
          <p className="hint">
            Write {'{{firm}}'} where the firm name goes and {'{{code}}'} where the invitation code
            goes.
          </p>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
        </div>
        {audienceKind === 'firm' && (
          <label style={{ display: 'block', margin: '6px 0' }}>
            <input
              type="checkbox"
              checked={requiresCode}
              onChange={(e) => setRequiresCode(e.target.checked)}
            />{' '}
            This is a firm invitation that carries a code
          </label>
        )}
        {clientErr && <div className="err">{clientErr}</div>}
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={!!clientErr || !name.trim() || busy}
            onClick={() => void save()}
          >
            Save template
          </button>
          <button type="button" className="btn-2" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="actions" style={{ marginBottom: 10 }}>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setEditing('new');
            setName('');
            setSubject('');
            setBody('');
            setAudienceKind('firm');
            setRequiresCode(true);
          }}
        >
          New template
        </button>
      </div>
      <div className="tablewrap">
        <table className="ftbl">
          <thead>
            <tr>
              <th>Template</th>
              <th>Audience</th>
              <th>Last edited</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>
                  <b>{t.name}</b>
                  {t.requiresCode && (
                    <span className="tag ok" style={{ marginLeft: 6 }}>
                      carries a code
                    </span>
                  )}
                </td>
                <td>{t.audienceKind}</td>
                <td>{new Date(t.updatedAt).toLocaleDateString()}</td>
                <td>
                  <button
                    type="button"
                    className="btn-2"
                    onClick={() => {
                      setEditing(t);
                      setName(t.name);
                      setSubject(t.subject);
                      setBody(t.body);
                      setAudienceKind(t.audienceKind);
                      setRequiresCode(t.requiresCode);
                    }}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RequestsView({
  client,
  templates,
  requests,
  onResolved,
}: {
  client: AdminClient;
  templates: MessageTemplate[];
  requests: InvitationRequestItem[];
  onResolved: () => Promise<void>;
}): JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reissueTemplate = templates.find((t) => t.audienceKind === 'firm' && t.requiresCode);

  async function resolve(id: string, resolution: 'code_issued' | 'marked_done'): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await client.resolveInvitationRequest(
        id,
        resolution,
        resolution === 'code_issued' ? reissueTemplate?.id : undefined,
      );
      await onResolved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not resolve the request');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <h2>Firms asking for an invitation</h2>
      <p className="lede">
        Firms that asked for an invitation code through the firm portal. Issue a code, or close the
        request without one.
      </p>
      {error && <div className="err">{error}</div>}
      {requests.every((r) => r.resolved) && <p>Nothing waiting.</p>}
      {requests.map((r) => (
        <section
          key={r.id}
          className={`stage${r.resolved ? '' : ' now'}`}
          style={{ marginBottom: 12 }}
        >
          <div className="stagehead">
            <h3 style={{ margin: 0 }}>{r.firmName}</h3>
            <span className={`pill ${r.resolved ? 'ok' : 'wait'}`}>
              {r.resolved
                ? r.resolution === 'code_issued'
                  ? 'Code issued'
                  : 'Marked done'
                : new Date(r.createdAt).toLocaleDateString()}
            </span>
          </div>
          <div className="stagebody">
            <p>
              {r.requesterName} · {r.role} · {r.email} · {r.phone}
            </p>
            {r.flag && (
              <div className="note">
                <p style={{ margin: 0 }}>{r.flag}</p>
              </div>
            )}
            {!r.resolved && (
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busyId === r.id}
                  onClick={() => void resolve(r.id, 'code_issued')}
                >
                  Issue a code
                </button>
                <button
                  type="button"
                  className="btn-2"
                  disabled={busyId === r.id}
                  onClick={() => void resolve(r.id, 'marked_done')}
                >
                  Mark done without issuing
                </button>
              </div>
            )}
          </div>
        </section>
      ))}
    </>
  );
}
