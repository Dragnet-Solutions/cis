import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminClient } from '../api/client';
import {
  ApiError,
  type Coordinator,
  type FirmImportResult,
  type FirmInvitation,
  type FirmSummary,
} from '../api/types';
import {
  INVITATION_FILTERS,
  INVITE_STATE,
  QUEUED_POLL_LIMIT,
  QUEUED_POLL_MS,
  deliveryLabel,
  hasQueuedDelivery,
  filterInvitations,
  summarizeInvitations,
  summaryLine,
  type InvitationFilter,
} from './firmInvitationsModel';
import { isValidEmail } from '../lib/email';
import { useEmailField } from '../lib/useEmailField';

type InvestorCategory = 'retail' | 'local_institutional' | 'foreign_institutional' | 'not_sure';

const INVESTOR_CATEGORY_LABEL: Record<InvestorCategory, string> = {
  retail: 'Retail investors',
  local_institutional: 'Local institutional investors',
  foreign_institutional: 'Foreign institutional investors',
  not_sure: 'Not sure / prefer to update later',
};

interface FirmDigest {
  seatCompletion: { complete: number; total: number };
  investorContribution: {
    retail: number;
    localInstitutional: number;
    foreignInstitutional: number;
    total: number;
  };
  attention: { state: string | null; label: string };
}

/**
 * UX-FRM-002 (investor categories) + UX-FRM-DIG-001 (firm digest preview).
 * Both self-service/read fields on the firm's own record — added here rather
 * than a new tab, since this is already the per-firm operator surface.
 */
function InvestorCategoriesCard({
  client,
  orgId,
}: {
  client: AdminClient;
  orgId: string;
}): JSX.Element {
  const [selected, setSelected] = useState<InvestorCategory[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSaved(false);
    void client
      .get<{ investorCategoriesServed: InvestorCategory[] }>(`/firm/${orgId}/investor-categories`)
      .then((r) => setSelected(r.investorCategoriesServed))
      .catch(() => setSelected([]));
  }, [client, orgId]);

  function toggle(cat: InvestorCategory): void {
    setSaved(false);
    setSelected((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  }

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await client.put(`/firm/${orgId}/investor-categories`, { categories: selected });
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="contact-fields">
      <legend>Investor categories served</legend>
      <p className="lede" style={{ fontSize: 13 }}>
        Optional declaration. Does not affect eligibility, scoring or published results, and can be
        edited later.
      </p>
      <div className="checks">
        {(Object.keys(INVESTOR_CATEGORY_LABEL) as InvestorCategory[]).map((cat) => (
          <label key={cat}>
            <input type="checkbox" checked={selected.includes(cat)} onChange={() => toggle(cat)} />
            {INVESTOR_CATEGORY_LABEL[cat]}
          </label>
        ))}
      </div>
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
      {saved && <p className="qstate ok">Saved. You can change this later.</p>}
    </fieldset>
  );
}

function FirmDigestCard({
  client,
  orgId,
  editionId,
}: {
  client: AdminClient;
  orgId: string;
  editionId: string;
}): JSX.Element {
  const [digest, setDigest] = useState<FirmDigest | null>(null);
  const [error, setError] = useState<string | null>(null);

  // BUG-09: while a firm's digest loads, show that it is loading — never the
  // previous firm's figures — and ignore an answer that arrives after the
  // operator has moved on to another firm.
  useEffect(() => {
    let current = true;
    setDigest(null);
    setError(null);
    client
      .get<{ digest: FirmDigest }>(`/firm/${orgId}/editions/${editionId}/digest`)
      .then((r) => {
        if (current) setDigest(r.digest);
      })
      .catch((err) => {
        if (current) setError(err instanceof ApiError ? err.message : 'Could not load digest');
      });
    return () => {
      current = false;
    };
  }, [client, orgId, editionId]);

  return (
    <fieldset className="contact-fields" aria-busy={!digest && !error}>
      <legend>Firm digest preview</legend>
      {error && <div className="err">{error}</div>}
      {!digest && !error && <p className="muted">Loading this firm’s digest…</p>}
      {digest && (
        <>
          <p>
            <b>
              {digest.seatCompletion.complete} of {digest.seatCompletion.total} complete
            </b>
          </p>
          <p className="lede" style={{ fontSize: 13 }}>
            Retail {digest.investorContribution.retail} · Local institutional{' '}
            {digest.investorContribution.localInstitutional} · Foreign institutional{' '}
            {digest.investorContribution.foreignInstitutional}. Counts only.
          </p>
          <p>{digest.attention.label}</p>
        </>
      )}
    </fieldset>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Copies an invitation's link, so an operator can pass it on when the email
 * cannot be relied on (or hand it to a test run). Falls back to a prompt the
 * operator can copy from when the clipboard is unavailable.
 */
function CopyLinkButton({ link, disabled }: { link: string; disabled?: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this invitation link', link);
    }
  }
  return (
    <button
      type="button"
      className="btn-2"
      disabled={disabled}
      title={link}
      onClick={() => void copy()}
    >
      {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

/**
 * Invite the selected firm: email its contact a personal link that opens the
 * firm portal's set-up view for this firm. The link expires (14 days unless
 * configured otherwise) and can be resent or revoked. Sending to the same
 * address again resends the open invitation rather than adding another.
 * Needs the "Write to firms, regulators and participants" right.
 */
function FirmInvitationsCard({
  client,
  orgId,
  editionId,
  firmName,
  hasLead,
  version,
  onChanged,
  onQueued,
}: {
  client: AdminClient;
  orgId: string;
  editionId: string | null;
  firmName: string;
  /** The firm already has a lead coordinator (so, in effect, a space). */
  hasLead: boolean;
  /** Bumped when an invitation changes elsewhere on the page; reloads the list. */
  version: number;
  /** Called after this card invites, resends or revokes. */
  onChanged: () => void;
  /** Called while an email shown here is still queued: re-read both tables. */
  onQueued: () => void;
}): JSX.Element {
  const [invitations, setInvitations] = useState<FirmInvitation[]>([]);
  const [claimedOnServer, setClaimed] = useState(false);
  const claimed = claimedOnServer || hasLead;
  const [email, setEmail] = useState('');
  const emailField = useEmailField('ftp-inv-email', email);
  const [contactName, setContactName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await client.listFirmInvitations(orgId);
      setInvitations(r.invitations);
      setClaimed(r.claimed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load invitations');
    }
  }, [client, orgId]);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setEmail('');
    setContactName('');
    void load();
  }, [load]);

  // Another part of the page changed an invitation: refresh the list only.
  useEffect(() => {
    if (version > 0) void load();
  }, [version, load]);

  // An email still queued: ask the page to re-read both tables shortly.
  useEffect(() => {
    if (!hasQueuedDelivery(invitations)) return;
    const t = setTimeout(onQueued, QUEUED_POLL_MS);
    return () => clearTimeout(t);
  }, [invitations, onQueued]);

  async function act(fn: () => Promise<string>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That action could not be completed');
    } finally {
      setBusy(false);
    }
  }

  async function send(): Promise<void> {
    if (!isValidEmail(email)) {
      emailField.reveal();
      return;
    }
    await act(async () => {
      const r = await client.inviteFirm(orgId, {
        email: email.trim(),
        ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
        ...(editionId ? { editionId } : {}),
      });
      setEmail('');
      setContactName('');
      return r.resent
        ? `There was already an open invitation for ${r.invitation.email}, so it was sent again with a new expiry date.`
        : `Invitation sent to ${r.invitation.email}. It expires on ${shortDate(r.invitation.expiresAt)}.`;
    });
  }

  return (
    <fieldset className="contact-fields">
      <legend>Invite this firm</legend>
      {claimed ? (
        <p className="qstate ok">
          Already claimed. {firmName} has set up its space; its coordinators sign in to the firm
          portal, so it cannot be invited again.
        </p>
      ) : (
        <>
          <p className="lede" style={{ fontSize: 13 }}>
            Email the firm a personal link to set up its space. Whoever opens it becomes the firm’s
            lead coordinator and chooses a six-digit PIN. The link expires after 14 days; you can
            resend or revoke it below.
          </p>
          <div className="field">
            <label htmlFor="ftp-inv-email">Email address</label>
            <input
              {...emailField.inputProps}
              type="email"
              value={email}
              placeholder="name@firm.com"
              onChange={(e) => setEmail(e.target.value)}
            />
            {emailField.error}
          </div>
          <div className="field">
            <label htmlFor="ftp-inv-name">Contact name (optional)</label>
            <input
              id="ftp-inv-name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy || !emailField.valid}
              onClick={() => void send()}
            >
              {busy ? 'Sending…' : 'Send invitation'}
            </button>
          </div>
        </>
      )}
      {notice && <p className="qstate ok">{notice}</p>}
      {error && <div className="err">{error}</div>}

      {invitations.length > 0 && (
        <table className="ftbl" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Sent</th>
              <th scope="col">Expires</th>
              <th scope="col">Status</th>
              <th scope="col">Email delivery</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((inv) => {
              const state = INVITE_STATE[inv.state];
              const delivery = deliveryLabel(inv.delivery);
              const open = inv.state === 'pending' || inv.state === 'expired';
              return (
                <tr key={inv.id}>
                  <td>
                    {inv.email}
                    {inv.contactName && (
                      <>
                        {' '}
                        <br />
                        <small>{inv.contactName}</small>
                      </>
                    )}
                  </td>
                  <td>
                    {shortDate(inv.lastSentAt)}
                    {inv.sendCount > 1 && <small> ({inv.sendCount} sends)</small>}
                  </td>
                  <td>{inv.state === 'accepted' ? '—' : shortDate(inv.expiresAt)}</td>
                  <td>
                    <span className={state.cls}>{state.label}</span>
                  </td>
                  <td>
                    {delivery.cls ? (
                      <span className={delivery.cls}>{delivery.text}</span>
                    ) : (
                      delivery.text
                    )}
                  </td>
                  <td className="actions">
                    {inv.link && <CopyLinkButton link={inv.link} disabled={busy} />}
                    {open && !claimed && (
                      <button
                        type="button"
                        className="btn-2"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const r = await client.resendFirmInvitation(inv.id);
                            return `Sent again to ${r.invitation.email}. It now expires on ${shortDate(r.invitation.expiresAt)}.`;
                          })
                        }
                      >
                        Resend
                      </button>
                    )}
                    {open && (
                      <button
                        type="button"
                        className="btn-2"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Revoke the invitation to ${inv.email}? Its link stops working straight away.`,
                            )
                          )
                            return;
                          void act(async () => {
                            await client.revokeFirmInvitation(inv.id);
                            return `Invitation to ${inv.email} revoked. Its link no longer works.`;
                          });
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </fieldset>
  );
}

/**
 * Every firm invitation in this edition at a glance: who was invited, when it
 * expires, whether it was accepted and whether the email got out — with the
 * same Copy link/Resend/Revoke actions as the per-firm box, a CSV of the open
 * links (firm,email,link,expires), and a bulk "invite all unclaimed firms".
 */
function EditionInvitationsCard({
  client,
  editionId,
  version,
  onChanged,
  onQueued,
}: {
  client: AdminClient;
  editionId: string;
  /** Bumped when the per-firm box changes an invitation; reloads the list. */
  version: number;
  /** Called after a resend or revoke here. */
  onChanged: () => void;
  /** Called while an email shown here is still queued: re-read both tables. */
  onQueued: () => void;
}): JSX.Element {
  const [invitations, setInvitations] = useState<FirmInvitation[]>([]);
  const [filter, setFilter] = useState<InvitationFilter>('all');
  const [bulkPrefix, setBulkPrefix] = useState('');
  const [bulkEmail, setBulkEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInvitations((await client.listEditionFirmInvitations(editionId)).invitations);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load invitations');
    }
  }, [client, editionId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // An email still queued: ask the page to re-read both tables shortly.
  useEffect(() => {
    if (!hasQueuedDelivery(invitations)) return;
    const t = setTimeout(onQueued, QUEUED_POLL_MS);
    return () => clearTimeout(t);
  }, [invitations, onQueued]);

  async function act(fn: () => Promise<string>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That action could not be completed');
    } finally {
      setBusy(false);
    }
  }

  const shown = filterInvitations(invitations, filter);

  async function downloadCsv(): Promise<void> {
    setError(null);
    try {
      const blob = await client.downloadFirmInvitationsCsv(editionId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'firm-invitations.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not download the links');
    }
  }

  async function inviteAll(): Promise<void> {
    const pattern = bulkEmail.trim();
    const prefix = bulkPrefix.trim();
    if (
      !window.confirm(
        `Invite every firm in this edition${prefix ? ` whose name starts with “${prefix}”` : ''} that has no space and no open invitation, ${pattern ? `at ${pattern}` : 'at the contact on file'}?`,
      )
    )
      return;
    await act(async () => {
      const r = await client.bulkInviteFirms(editionId, {
        ...(pattern ? { emailTemplate: pattern } : {}),
        ...(prefix ? { namePrefix: prefix } : {}),
      });
      const parts = [
        `${firmCount(r.invited)} invited`,
        r.skippedClaimed ? `${firmCount(r.skippedClaimed)} already set up` : null,
        r.skippedPending ? `${firmCount(r.skippedPending)} already had an open invitation` : null,
        r.skippedNoContact
          ? `${firmCount(r.skippedNoContact)} have no contact email on file`
          : null,
        r.failed.length
          ? `${firmCount(r.failed.length)} not invited (${r.failed.map((f) => `${f.firmName}: ${f.message}`).join('; ')})`
          : null,
      ].filter(Boolean);
      return `${parts.join(', ')}.`;
    });
  }

  return (
    <fieldset className="contact-fields">
      <legend>Firm invitations this edition</legend>
      <p className="lede" style={{ fontSize: 13 }}>
        {summaryLine(summarizeInvitations(invitations))}
      </p>
      <div className="field">
        <label htmlFor="ftp-inv-filter">Show</label>
        <select
          id="ftp-inv-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value as InvitationFilter)}
        >
          {INVITATION_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <div className="actions">
        <button type="button" className="btn-2" disabled={busy} onClick={() => void downloadCsv()}>
          Download open links (CSV)
        </button>
      </div>
      <details style={{ marginTop: 8 }}>
        <summary>Invite all unclaimed firms</summary>
        <p className="lede" style={{ fontSize: 13 }}>
          Invites every firm taking part in this edition that has not set up its space and has no
          open invitation, at the contact imported with the firm directory. To send to a pattern
          instead (e.g. for testing), give one: <code>{'{slug}'}</code> in the address becomes the
          firm’s short name, e.g. <code>{'coordinator+{slug}@yourdomain.com'}</code>.
        </p>
        <div className="field">
          <label htmlFor="ftp-bulk-prefix">Only firms whose name starts with (optional)</label>
          <input
            id="ftp-bulk-prefix"
            value={bulkPrefix}
            placeholder="[Test]"
            onChange={(e) => setBulkPrefix(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ftp-bulk-email">
            Email address pattern (optional — leave empty to use each firm’s contact)
          </label>
          <input
            id="ftp-bulk-email"
            value={bulkEmail}
            placeholder="coordinator+{slug}@yourdomain.com"
            onChange={(e) => setBulkEmail(e.target.value)}
          />
        </div>
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void inviteAll()}>
            {busy ? 'Inviting…' : 'Invite all unclaimed firms'}
          </button>
        </div>
      </details>
      {notice && <p className="qstate ok">{notice}</p>}
      {error && <div className="err">{error}</div>}
      <table className="ftbl" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th scope="col">Firm</th>
            <th scope="col">Email</th>
            <th scope="col">Sent</th>
            <th scope="col">Expires</th>
            <th scope="col">Status</th>
            <th scope="col">Email delivery</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td colSpan={7}>
                {invitations.length === 0
                  ? 'No firm has been invited in this edition yet.'
                  : 'No invitations match this filter.'}
              </td>
            </tr>
          ) : (
            shown.map((inv) => {
              const state = INVITE_STATE[inv.state];
              const delivery = deliveryLabel(inv.delivery);
              const open = inv.state === 'pending' || inv.state === 'expired';
              return (
                <tr key={inv.id}>
                  <td>{inv.firmName}</td>
                  <td>
                    {inv.email}
                    {inv.contactName && (
                      <>
                        {' '}
                        <br />
                        <small>{inv.contactName}</small>
                      </>
                    )}
                  </td>
                  <td>
                    {shortDate(inv.lastSentAt)}
                    {inv.sendCount > 1 && <small> ({inv.sendCount} sends)</small>}
                  </td>
                  <td>{inv.state === 'accepted' ? '—' : shortDate(inv.expiresAt)}</td>
                  <td>
                    <span className={state.cls}>{state.label}</span>
                  </td>
                  <td>
                    {delivery.cls ? (
                      <span className={delivery.cls}>{delivery.text}</span>
                    ) : (
                      delivery.text
                    )}
                  </td>
                  <td className="actions">
                    {inv.link && <CopyLinkButton link={inv.link} disabled={busy} />}
                    {open && (
                      <button
                        type="button"
                        className="btn-2"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const r = await client.resendFirmInvitation(inv.id);
                            return `Sent again to ${r.invitation.email} (${inv.firmName}). It now expires on ${shortDate(r.invitation.expiresAt)}.`;
                          })
                        }
                      >
                        Resend
                      </button>
                    )}
                    {open && (
                      <button
                        type="button"
                        className="btn-2"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Revoke the invitation to ${inv.email} (${inv.firmName})? Its link stops working straight away.`,
                            )
                          )
                            return;
                          void act(async () => {
                            await client.revokeFirmInvitation(inv.id);
                            return `Invitation to ${inv.email} revoked. Its link no longer works.`;
                          });
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </fieldset>
  );
}

/** "1 firm", "3 firms". */
function firmCount(n: number): string {
  return `${n} ${n === 1 ? 'firm' : 'firms'}`;
}

/**
 * Loading the firm directory before launch: upload a CSV (a header row with a
 * `name` column, and optionally `slug`), preview exactly what would happen —
 * nothing is written — then import. Firms already in the directory, or
 * repeated in the file, are skipped, never added twice. A file with any line
 * that cannot be read is not imported at all. Needs the "Change the setup"
 * right; every firm added is recorded in the audit log.
 */
function FirmDirectoryImport({
  client,
  onImported,
  editionId,
}: {
  client: AdminClient;
  onImported: () => Promise<void>;
  /** The edition new firms are enrolled in, so they appear in its surveys. */
  editionId: string | null;
}): JSX.Element {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<FirmImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function choose(file: File | undefined): Promise<void> {
    setPreview(null);
    setDone(null);
    setError(null);
    if (!file) return;
    setFileName(file.name);
    const text = await file.text();
    setCsv(text);
    setBusy(true);
    try {
      setPreview(await client.importFirms(text, true, editionId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that file');
    } finally {
      setBusy(false);
    }
  }

  async function importNow(): Promise<void> {
    if (!csv) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.importFirms(csv, false, editionId);
      setDone(
        `${firmCount(result.added)} added to the directory.${
          result.duplicates.length ? ` ${result.duplicates.length} already listed, skipped.` : ''
        }${
          result.enrolled !== null && result.enrolled > 0
            ? ` ${firmCount(result.enrolled)} enrolled in this edition, so they appear in the surveys.`
            : ''
        }${
          result.contactsSaved > 0
            ? ` Contacts saved for ${firmCount(result.contactsSaved)}; invite them from “Invite all unclaimed firms” below.`
            : ''
        }`,
      );
      setPreview(null);
      setCsv(null);
      await onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import did not complete');
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="contact-fields">
      <legend>Import the firm directory</legend>
      <p className="lede" style={{ fontSize: 13 }}>
        Load the participating firms from a CSV file before launch — one file for the firms and
        their contacts. The first line is a header. <b>name</b> (the firm) is required; optional
        columns are <b>contact name</b>, <b>email</b>, <b>phone</b> and <b>registration number</b>{' '}
        (headers are matched ignoring case, e.g. “Firm name”, “E-mail”, “Mobile”, “RC number”), and{' '}
        <b>slug</b>, a short permanent identifier made from the name if left out. You see what would
        be added before anything changes. Firms already listed are not added twice, but are enrolled
        and take the contact the file gives them. A firm with an email can then be invited from
        “Invite all unclaimed firms” with no address pattern.
      </p>
      <div className="field">
        <label htmlFor="ftp-import">CSV file</label>
        <input
          id="ftp-import"
          type="file"
          accept=".csv,text/csv"
          disabled={busy || !editionId}
          onChange={(e) => void choose(e.target.files?.[0])}
        />
      </div>
      {/* An imported firm is enrolled in the edition, or its clients cannot pick it
          (QA E01): with no edition chosen there is nothing to enrol it in. */}
      {!editionId && (
        <div className="warnbox">
          Choose the edition in the header first. Imported firms are enrolled in that edition so
          they appear in its surveys.
        </div>
      )}

      {preview && (
        <div className="note">
          <p>
            <b>{fileName}</b>: {preview.totalRows} {preview.totalRows === 1 ? 'line' : 'lines'}{' '}
            read. {firmCount(preview.toAdd.length)} would be added
            {preview.duplicates.length > 0 && `, ${preview.duplicates.length} already listed`}
            {preview.errors.length > 0 &&
              `, ${preview.errors.length} ${preview.errors.length === 1 ? 'line' : 'lines'} cannot be read`}
            .
          </p>
          {preview.errors.length > 0 && (
            <>
              <p className="err">
                Nothing can be imported until these lines are corrected in the file.
              </p>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {preview.errors.map((e) => (
                  <li key={`e${e.line}`}>
                    Line {e.line}: {e.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          {preview.toAdd.length > 0 && (
            <table className="ftbl" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th scope="col">Line</th>
                  <th scope="col">Firm to add</th>
                  <th scope="col">Slug</th>
                  {preview.withContact > 0 && <th scope="col">Contact</th>}
                </tr>
              </thead>
              <tbody>
                {preview.toAdd.map((r) => (
                  <tr key={`a${r.line}`}>
                    <td>{r.line}</td>
                    <td>{r.name}</td>
                    <td>{r.slug}</td>
                    {preview.withContact > 0 && (
                      <td>
                        {[r.contactName, r.email, r.phone].filter(Boolean).join(' · ') || '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.duplicates.length > 0 && (
            <>
              <p style={{ marginTop: 8 }}>Skipped:</p>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {preview.duplicates.map((d) => (
                  <li key={`d${d.line}`}>
                    Line {d.line}, {d.name}: {d.reason}
                    {d.email ? ` Its contact will be set to ${d.email}.` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={
                busy ||
                preview.errors.length > 0 ||
                (preview.toAdd.length === 0 && preview.duplicates.length === 0)
              }
              onClick={() => void importNow()}
            >
              {preview.toAdd.length > 0
                ? `Import ${firmCount(preview.toAdd.length)}`
                : `Update ${firmCount(preview.duplicates.length)} already listed`}
            </button>
          </div>
        </div>
      )}
      {done && <p className="qstate ok">{done}</p>}
      {error && <div className="err">{error}</div>}
    </fieldset>
  );
}

/**
 * UX-FRM-007 firm coordinator team administration. Ordinary account admin — NOT
 * maker-checker. The rules the UI surfaces (all enforced server-side):
 *  - a sole coordinator is the lead; handover is immediate and can only be
 *    reversed by the new lead (never the outgoing one);
 *  - the outgoing lead keeps ordinary coordinator access;
 *  - a PIN change needs the current PIN;
 *  - removing a coordinator is immediate; a re-add issues a NEW access code.
 */
export function FirmTeamPage({
  client,
  editionId,
}: {
  client: AdminClient;
  editionId: string | null;
}): JSX.Element {
  const [firms, setFirms] = useState<FirmSummary[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [coordinators, setCoordinators] = useState<Coordinator[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', role: '' });
  const coordEmail = useEmailField('ftp-email', form.email);
  // Keep the per-firm invitation box and the edition-wide list in step: one
  // version, so whatever changes an invitation (an action in either table, or
  // a queued email the mail service has since accepted) re-reads both, and
  // the same invitation never shows two different states (D-25).
  const [invitesVersion, setInvitesVersion] = useState(0);
  const queuedPolls = useRef(0);
  const invitationsChanged = useCallback(() => {
    queuedPolls.current = 0;
    setInvitesVersion((v) => v + 1);
  }, []);
  const invitationsQueued = useCallback(() => {
    if (queuedPolls.current >= QUEUED_POLL_LIMIT) return;
    queuedPolls.current += 1;
    setInvitesVersion((v) => v + 1);
  }, []);

  const loadFirms = useCallback(async () => {
    try {
      const fs = await client.listFirms();
      setFirms(fs);
      setOrgId((current) => current ?? fs[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load firms');
    }
  }, [client]);

  useEffect(() => {
    void loadFirms();
  }, [loadFirms]);

  const reload = useCallback(
    async (id: string) => {
      setError(null);
      try {
        setCoordinators(await client.listCoordinators(id));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load coordinators');
      }
    },
    [client],
  );

  useEffect(() => {
    if (orgId) void reload(orgId);
  }, [orgId, reload]);

  const lead = coordinators.find((c) => c.isLead) ?? null;

  async function guarded(fn: () => Promise<void>): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (orgId) await reload(orgId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That action could not be completed');
    }
  }

  async function addOne(asLead: boolean): Promise<void> {
    if (!orgId || !form.name.trim() || !form.email.trim()) {
      setError('Name and email are required.');
      return;
    }
    if (!isValidEmail(form.email)) {
      coordEmail.reveal();
      return;
    }
    const body = {
      name: form.name.trim(),
      email: form.email.trim(),
      ...(form.role.trim() ? { role: form.role.trim() } : {}),
    };
    await guarded(async () => {
      const created = asLead
        ? await client.createLeadCoordinator(orgId, body)
        : await client.addCoordinator(orgId, body);
      setForm({ name: '', email: '', role: '' });
      setNotice(`Added ${created.name}. Access code: ${created.accessCode}`);
    });
  }

  async function handover(newLeadId: string): Promise<void> {
    if (!orgId || !lead) return;
    await guarded(() =>
      client
        .handoverLead(orgId, { actingCoordinatorId: lead.id, newLeadCoordinatorId: newLeadId })
        .then(() => setNotice('Lead handed over. This cannot be reversed by the outgoing lead.')),
    );
  }

  async function changePin(c: Coordinator): Promise<void> {
    if (!orgId) return;
    const newPin = window.prompt(`New PIN for ${c.name} (min 4 digits)`);
    if (!newPin) return;
    const currentPin = window.prompt('Current PIN (leave blank if none set yet)') ?? '';
    await guarded(() =>
      client
        .setCoordinatorPin(orgId, c.id, currentPin ? { newPin, currentPin } : { newPin })
        .then(() => setNotice(`PIN updated for ${c.name}.`)),
    );
  }

  async function remove(c: Coordinator): Promise<void> {
    if (!orgId) return;
    await guarded(() =>
      client.removeCoordinator(orgId, c.id).then(() => setNotice(`Removed ${c.name}.`)),
    );
  }

  return (
    <main>
      <p className="eyebrow">Firm account</p>
      <h1 tabIndex={-1}>Coordinator team</h1>
      <p className="lede">
        Manage a firm’s coordinators. This is ordinary account administration — it does not go
        through maker-checker.
      </p>

      <div className="field">
        <label htmlFor="ftp-firm">Firm</label>
        <select
          id="ftp-firm"
          value={orgId ?? ''}
          onChange={(e) => setOrgId(e.target.value || null)}
        >
          {firms.length === 0 && <option value="">No firms</option>}
          {firms.map((f) => (
            <option key={f.id} value={f.id}>
              {f.displayName}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="err">{error}</div>}
      {notice && <p className="qstate ok">{notice}</p>}

      <table className="ftbl">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Lead</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {coordinators.length === 0 ? (
            <tr>
              <td colSpan={5}>
                No coordinators yet. The first one you add becomes the lead (sole coordinator).
              </td>
            </tr>
          ) : (
            coordinators.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.email}</td>
                <td>{c.role ?? '—'}</td>
                <td>{c.isLead ? 'Lead' : ''}</td>
                <td className="actions">
                  <button type="button" className="btn-2" onClick={() => void changePin(c)}>
                    PIN
                  </button>
                  {!c.isLead && (
                    <button type="button" className="btn-2" onClick={() => void handover(c.id)}>
                      Make lead
                    </button>
                  )}
                  {!c.isLead && (
                    <button type="button" className="btn-2" onClick={() => void remove(c)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <fieldset className="contact-fields">
        <legend>Add a coordinator</legend>
        <div className="field">
          <label htmlFor="ftp-name">Name</label>
          <input
            id="ftp-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="ftp-email">Email</label>
          <input
            {...coordEmail.inputProps}
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          {coordEmail.error}
        </div>
        <div className="field">
          <label htmlFor="ftp-role">Role (optional)</label>
          <input
            id="ftp-role"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          />
        </div>
        <div className="actions">
          {!lead ? (
            <button
              type="button"
              className="btn"
              disabled={!form.name.trim() || !coordEmail.valid}
              onClick={() => void addOne(true)}
            >
              Add as lead
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={!form.name.trim() || !coordEmail.valid}
              onClick={() => void addOne(false)}
            >
              Add coordinator
            </button>
          )}
        </div>
        {!lead && (
          <p className="lede" style={{ fontSize: 13 }}>
            This firm has no lead yet — the first coordinator you add becomes the lead.
          </p>
        )}
      </fieldset>

      {orgId && (
        <FirmInvitationsCard
          client={client}
          orgId={orgId}
          editionId={editionId}
          firmName={firms.find((f) => f.id === orgId)?.displayName ?? 'This firm'}
          hasLead={!!lead}
          version={invitesVersion}
          onChanged={invitationsChanged}
          onQueued={invitationsQueued}
        />
      )}
      {editionId && (
        <EditionInvitationsCard
          client={client}
          editionId={editionId}
          version={invitesVersion}
          onChanged={invitationsChanged}
          onQueued={invitationsQueued}
        />
      )}
      {orgId && <InvestorCategoriesCard client={client} orgId={orgId} />}
      <FirmDirectoryImport client={client} onImported={loadFirms} editionId={editionId} />
      {orgId && editionId && <FirmDigestCard client={client} orgId={orgId} editionId={editionId} />}
    </main>
  );
}
