import { useCallback, useEffect, useState } from 'react';
import type { AdminClient } from '../api/client';
import {
  ApiError,
  type RegulatorContact,
  type RegulatorFamilyCode,
  type RegulatorView,
} from '../api/types';

/**
 * UX-OPS-007 — Regulators, live-wired to the regulator-engagement service
 * (`@cis/domain`, via `apps/api/src/routes/regulators.ts`). One page per
 * (institution, family) role — CSCS holding both Family C and Family D is two
 * independent rows — with two sections in fixed order (contact, then survey)
 * plus an append-only free-text history.
 *
 * Every rule lives server-side and this screen only reflects it: a contact
 * before a link, cancel-and-restart when the contact changes after a link went
 * out, declined as terminal (reopen is `access:regs`-gated), and a lead time
 * the study team chooses — never a default. A role moves to confirmed on its
 * own when the regulator submits through the link.
 *
 * Previously this page ran on a hard-coded SEED in local state: nothing it
 * showed or recorded reached the database, so every engagement was lost on
 * reload and Institutional Perspectives could never be generated.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A calendar date ('YYYY-MM-DD') as "17 August". */
function fmtDate(d: string | null): string {
  if (!d) return '—';
  const p = d.slice(0, 10).split('-');
  return `${parseInt(p[2]!, 10)} ${MONTHS[parseInt(p[1]!, 10) - 1]}`;
}

/** A history timestamp as "30 Sep". */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]!.slice(0, 3)}`;
}

/** The server stores the API resume path; the person needs the survey URL. */
export function respondentLink(surveyLink: string | null, origin: string): string | null {
  const token = surveyLink?.match(/\/journeys\/resume\/([^/?#]+)/)?.[1];
  return token ? `${origin}/survey?resume=${token}` : null;
}

const PILL: Record<RegulatorView['state'], { cls: string; label: string }> = {
  confirmed: { cls: 'confirmed', label: 'Confirmed' },
  declined: { cls: 'declined', label: 'Declined' },
  no_contact: { cls: 'nocontact', label: 'No contact' },
  contact_added: { cls: 'ready', label: 'Contact added' },
  invited: { cls: 'progress', label: 'Invited' },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function phoneDigits(v: string): number {
  return v.replace(/[^0-9]/g, '').length;
}

const EMPTY_DRAFT: RegulatorContact = { who: '', role: '', email: '', phone: '', how: '' };

/**
 * What a contact still needs before it can be saved. Every detail is required,
 * the mobile included: the survey link and every reminder go by email AND text,
 * and a text-only reminder exists for when email goes unread. The server applies
 * the same rules (regulator-engagement-service `validateContact`).
 */
export function contactGaps(c: RegulatorContact): string[] {
  const gaps: string[] = [];
  if (!c.who.trim()) gaps.push('a name');
  if (!c.role.trim()) gaps.push('a role');
  if (!EMAIL_RE.test(c.email.trim())) gaps.push('a working email address');
  if (phoneDigits(c.phone) < 10) gaps.push('a mobile number');
  if (!c.how.trim()) gaps.push('how we got to them');
  return gaps;
}

type Key = { institutionId: string; familyCode: RegulatorFamilyCode };

export function RegulatorsPage({
  client,
  editionId,
}: {
  client: AdminClient;
  editionId: string;
}): JSX.Element {
  const [regs, setRegs] = useState<RegulatorView[] | null>(null);
  const [open, setOpen] = useState<Key | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      setRegs((await client.getRegulators(editionId)).regulators);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the regulators');
    }
  }, [client, editionId]);

  useEffect(() => {
    if (!open) void loadList();
  }, [open, loadList]);

  if (open) {
    return (
      <RegulatorDetail
        client={client}
        editionId={editionId}
        which={open}
        onBack={() => setOpen(null)}
      />
    );
  }

  if (regs === null) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  return (
    <main>
      <h1 tabIndex={-1}>Regulators</h1>
      <p className="lede">
        Each institutional role contributes the Institutional Perspectives section and is approached
        separately, answering once — including an institution holding more than one role, which
        appears once per role below.
      </p>
      {error && <div className="err">{error}</div>}
      {regs.length === 0 ? (
        <p>No institutional roles are set up for this edition.</p>
      ) : (
        <div>
          {regs.map((r) => {
            const pill = PILL[r.state];
            return (
              <button
                key={`${r.institutionId}-${r.familyCode}`}
                type="button"
                className={`regrow${r.overdue ? ' late' : ''}`}
                onClick={() =>
                  setOpen({ institutionId: r.institutionId, familyCode: r.familyCode })
                }
              >
                <span className="who">
                  <b>{r.name}</b>
                  <span>{r.mandate}</span>
                </span>
                <span className="next">
                  {r.overdue ? `Overdue since ${fmtDate(r.targetBy)}` : r.nextStep}
                </span>
                <span className={`pill ${pill.cls}`}>{pill.label}</span>
              </button>
            );
          })}
        </div>
      )}
      <p className="owner">
        The section cannot be written without every role above, so each is a single point of failure
        for a promised output. That is why each holds its own lead time rather than a shared
        deadline.
      </p>
    </main>
  );
}

function RegulatorDetail({
  client,
  editionId,
  which,
  onBack,
}: {
  client: AdminClient;
  editionId: string;
  which: Key;
  onBack: () => void;
}): JSX.Element {
  const { institutionId, familyCode } = which;
  const [r, setR] = useState<RegulatorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RegulatorContact>(EMPTY_DRAFT);

  useEffect(() => {
    let cancelled = false;
    client
      .getRegulator(editionId, institutionId, familyCode)
      .then((res) => {
        if (!cancelled) setR(res.regulator);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load this regulator');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, editionId, institutionId, familyCode]);

  // Every action returns the fresh record, history included — the screen shows
  // exactly what the server now holds, never an optimistic guess.
  const act = useCallback(
    async (fn: () => Promise<{ regulator: RegulatorView }>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        setR((await fn()).regulator);
        return true;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (!r) {
    return (
      <main>
        <button type="button" className="back" onClick={onBack}>
          ← All regulators
        </button>
        {error ? <div className="err">{error}</div> : <p>Loading…</p>}
      </main>
    );
  }

  const okMail = EMAIL_RE.test(draft.email.trim());
  const okPhone = phoneDigits(draft.phone) >= 10;
  const draftGaps = contactGaps(draft);
  const draftValid = draftGaps.length === 0;
  const draftError =
    draft.email.length && !okMail
      ? 'That is not a working email address.'
      : draft.phone.length && !okPhone
        ? 'That number is too short to send a text to.'
        : '';

  return (
    <main>
      <button type="button" className="back" onClick={onBack}>
        ← All regulators
      </button>
      <p className="eyebrow">{r.mandate}</p>
      <h1 tabIndex={-1}>{r.name}</h1>
      {r.overdue && (
        <div className="lateline">
          Expected back by {fmtDate(r.targetBy)}. Overdue, and raising a card on the operations
          board.
        </div>
      )}
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}

      {/* 1. the contact */}
      <ContactSection
        r={r}
        busy={busy}
        editing={editing}
        draft={draft}
        setDraft={setDraft}
        startEdit={() => {
          setDraft(r.contact ? { ...r.contact } : EMPTY_DRAFT);
          setEditing(true);
        }}
        cancelEdit={() => setEditing(false)}
        save={async () => {
          const ok = await act(() =>
            client.saveRegulatorContact(editionId, institutionId, familyCode, draft),
          );
          if (ok) setEditing(false);
        }}
        valid={draftValid}
        gaps={draftGaps}
        validationError={draftError}
      />

      {/* 2. the survey */}
      <SurveySection
        r={r}
        busy={busy}
        issueLink={(targetBy) =>
          act(() => client.issueRegulatorLink(editionId, institutionId, familyCode, targetBy))
        }
        remind={(textOnly) =>
          act(() => client.remindRegulator(editionId, institutionId, familyCode, textOnly))
        }
        decline={() => act(() => client.declineRegulator(editionId, institutionId, familyCode))}
        reopen={() => act(() => client.reopenRegulator(editionId, institutionId, familyCode))}
      />

      {/* 3. what has happened */}
      <HistorySection
        r={r}
        busy={busy}
        onAdd={(entry) =>
          act(() => client.addRegulatorHistory(editionId, institutionId, familyCode, entry))
        }
      />
    </main>
  );
}

function ContactSection(props: {
  r: RegulatorView;
  busy: boolean;
  editing: boolean;
  draft: RegulatorContact;
  setDraft: (d: RegulatorContact) => void;
  startEdit: () => void;
  cancelEdit: () => void;
  save: () => void;
  valid: boolean;
  gaps: string[];
  validationError: string;
}): JSX.Element {
  const { r, editing, draft, setDraft } = props;
  const invited = r.state === 'invited';
  const field = (key: keyof RegulatorContact, label: string, hint?: string): JSX.Element => (
    <div className="field">
      <label htmlFor={`f-${key}`}>{label}</label>
      {hint ? <p className="hint">{hint}</p> : null}
      <input
        id={`f-${key}`}
        type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </div>
  );

  return (
    <section className={`stage${!r.contact || editing ? ' now' : ' done'}`}>
      <div className="stagehead">
        <h2>Their contact</h2>
        <span className={`pill ${r.contact ? 'confirmed' : 'nocontact'}`}>
          {r.contact ? 'Held' : 'None yet'}
        </span>
      </div>
      <div className="stagebody">
        {editing ? (
          <>
            {invited && (
              <div className="warnbox">
                <b>The link already sent stops working.</b> Anything they had started is lost, and a
                fresh link goes to whoever you name below.
              </div>
            )}
            <div className="two">
              {field('who', 'Name')}
              {field('role', 'Role')}
            </div>
            <p className="hint">
              Every detail is needed. The survey link and reminders go by email and by text, so the
              mobile number is required too.
            </p>
            <div className="two">
              {field('email', 'Email')}
              {field(
                'phone',
                'Mobile',
                'Needed for the text that goes with every link and reminder.',
              )}
            </div>
            {field('how', 'How we got to them', 'A note for whoever picks this up next.')}
            {props.validationError ? (
              <div className="err" role="alert">
                {props.validationError}
              </div>
            ) : null}
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={!props.valid || props.busy}
                onClick={props.save}
              >
                {props.busy ? 'Saving…' : 'Save the contact'}
              </button>
              <button type="button" className="btn-2" onClick={props.cancelEdit}>
                Cancel
              </button>
            </div>
            {!props.valid && !props.validationError && (
              <p className="hint">Still needed before saving: {props.gaps.join(', ')}.</p>
            )}
          </>
        ) : r.contact ? (
          <>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{r.contact.who}</dd>
              <dt>Role</dt>
              <dd>{r.contact.role}</dd>
              <dt>Email</dt>
              <dd>{r.contact.email}</dd>
              <dt>Mobile</dt>
              <dd>{r.contact.phone || '—'}</dd>
              <dt>How reached</dt>
              <dd>{r.contact.how}</dd>
            </dl>
            {r.state !== 'declined' && r.state !== 'confirmed' && (
              <button type="button" className="textlink" onClick={props.startEdit}>
                {invited ? 'Cancel and start again with someone else' : 'Change this contact'}
              </button>
            )}
          </>
        ) : (
          <>
            <p>Nobody is named for this regulator yet.</p>
            <div className="actions">
              <button type="button" className="btn" onClick={props.startEdit}>
                Add a contact
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function SurveySection(props: {
  r: RegulatorView;
  busy: boolean;
  issueLink: (targetBy: string) => Promise<boolean>;
  remind: (textOnly: boolean) => Promise<boolean>;
  decline: () => Promise<boolean>;
  reopen: () => Promise<boolean>;
}): JSX.Element {
  const { r, busy } = props;
  // The lead time is the study team's decision — never computed or defaulted.
  const [targetBy, setTargetBy] = useState('');

  let body: JSX.Element;
  let pill: { cls: string; text: string };
  let stageCls = 'stage';

  if (r.state === 'confirmed') {
    stageCls = 'stage done';
    pill = { cls: 'confirmed', text: 'Submitted' };
    body = (
      <p>
        <span className="tick">✓</span> Submitted. Their answers form part of the Institutional
        Perspectives section.
      </p>
    );
  } else if (r.state === 'declined') {
    pill = { cls: 'declined', text: 'Declined' };
    body = (
      <>
        <p>
          Declined to take part. The Institutional Perspectives section must be replanned rather
          than chased.
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn-2"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  'Reopen this role? Use this only if the decline was recorded by mistake.',
                )
              ) {
                void props.reopen();
              }
            }}
          >
            Reopen — this was recorded by mistake
          </button>
        </div>
      </>
    );
  } else if (!r.contact) {
    pill = { cls: 'nocontact', text: 'Not yet' };
    body = <p>Nothing can be sent until there is someone to send it to.</p>;
  } else if (r.state === 'contact_added') {
    stageCls = 'stage now';
    pill = { cls: 'ready', text: 'Ready to send' };
    body = (
      <>
        <p>
          One link, one response. {r.contact.who} can pass it to anyone at the organisation whose
          input is needed — it stays a single submission.
        </p>
        <p className="chan">
          Goes by email and text: {r.contact.email} · {r.contact.phone}
        </p>
        <div className="field">
          <label htmlFor="targetBy">Expected back by</label>
          <p className="hint">
            This role’s own lead time. Past it, the operations board raises a card.
          </p>
          <input
            id="targetBy"
            type="date"
            value={targetBy}
            onChange={(e) => setTargetBy(e.target.value)}
          />
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={busy || !targetBy}
            onClick={() => void props.issueLink(targetBy)}
          >
            Issue the link to {r.contact.who}
          </button>
        </div>
      </>
    );
  } else {
    const link = respondentLink(r.surveyLink, window.location.origin);
    stageCls = 'stage now';
    pill = { cls: 'progress', text: 'Sent, awaiting response' };
    body = (
      <>
        {link && <p className="linkline">{link}</p>}
        <dl className="kv">
          <dt>Sent to</dt>
          <dd>{r.contact.who}</dd>
          <dt>By</dt>
          <dd>
            {r.contact.email} and text to {r.contact.phone}
          </dd>
          <dt>Expected by</dt>
          <dd>{fmtDate(r.targetBy)}</dd>
        </dl>
        <div className="actions">
          <button
            type="button"
            className="btn-2"
            disabled={busy}
            onClick={() => void props.remind(false)}
          >
            Send a reminder
          </button>
          <button
            type="button"
            className="btn-2"
            disabled={busy}
            onClick={() => void props.remind(true)}
          >
            Text only
          </button>
          <button
            type="button"
            className="btn-2"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Record that ${r.name} declined for this edition?`)) {
                void props.decline();
              }
            }}
          >
            They declined
          </button>
        </div>
        <p className="owner">
          Reminders go by email and text. Text only is there for the case where the inbox has
          clearly not been read. Anything said on a call goes in the history below. When they submit
          through the link, this role is confirmed on its own.
        </p>
      </>
    );
  }

  return (
    <section className={stageCls}>
      <div className="stagehead">
        <h2>Their survey</h2>
        <span className={`pill ${pill.cls}`}>{pill.text}</span>
      </div>
      <div className="stagebody">{body}</div>
    </section>
  );
}

function HistorySection(props: {
  r: RegulatorView;
  busy: boolean;
  onAdd: (entry: string) => Promise<boolean>;
}): JSX.Element {
  const [text, setText] = useState('');
  return (
    <section className="stage">
      <div className="stagehead">
        <h2>What has happened</h2>
      </div>
      <div className="stagebody">
        <div>
          {props.r.history.length === 0 ? (
            <p>Nothing recorded yet.</p>
          ) : (
            props.r.history.map((x) => (
              <div
                className="hitem"
                key={x.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '64px minmax(0, 1fr)',
                  gap: 12,
                  padding: '6px 0',
                  borderBottom: '1px solid var(--line, #d9d9d9)',
                }}
              >
                <span className="when" style={{ color: 'var(--fg-3, #6a6a6a)' }}>
                  {fmtWhen(x.createdAt)}
                </span>
                <span>{x.entry}</span>
              </div>
            ))
          )}
        </div>
        <div style={{ marginTop: 14 }}>
          <div className="field">
            <label htmlFor="hWhat">Add to the history</label>
            <p className="hint">
              Engagement runs over weeks across several people. What was said and when is how the
              next person picks it up.
            </p>
            <textarea id="hWhat" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn-2"
              disabled={props.busy || text.trim().length < 4}
              onClick={async () => {
                if (await props.onAdd(text.trim())) setText('');
              }}
            >
              Record it
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
