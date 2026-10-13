import { useCallback, useEffect, useState } from 'react';
import type { AdminClient } from '../api/client';
import {
  ApiError,
  type AccessOrg,
  type AccessRightKey,
  type AuthUser,
  type PersonAccess,
} from '../api/types';

/**
 * UX-OPS-006 — People & Access (RBAC admin), live-wired to the real evaluator
 * (`@cis/domain` people-access-service, via `apps/api/src/routes/people.ts`).
 * This surface manages WHO holds the seven access rights, including the
 * request/approve rights that gate the critical actions — it adds no
 * seventh action and changes none of the six's own logic.
 *
 * Every rule this UI hints at is enforced server-side, which is the actual
 * source of truth (this is UX convenience, not the gate):
 *   - The two-approver floor is ENFORCED, not warned — on both breach routes
 *     (removal, and un-ticking `approve`).
 *   - The Dragnet analysis right is refused server-side for a CIS person.
 *   - A person cannot remove their own access (checked against the real,
 *     signed-in actor from the JWT — never a client-supplied id).
 *   - Zero people is a distinct, non-recoverable-from-here state.
 */

type RightKey = AccessRightKey;
type Org = AccessOrg;

const RIGHTS: Array<{ k: RightKey; label: string; sub: string; dragnetOnly?: boolean }> = [
  {
    k: 'view',
    label: 'See the study',
    sub: 'The mission board, coverage, unfinished, regulators. Everyone has this.',
  },
  {
    k: 'send',
    label: 'Write to firms, regulators and participants',
    sub: 'Send invitations, reminders and report notices.',
  },
  {
    k: 'regs',
    label: 'Manage regulator engagement',
    sub: 'Add contacts, issue survey links, record what happened.',
  },
  {
    k: 'setup',
    label: 'Change the setup',
    sub: 'Edition dates, sample floors, instruments, wording.',
  },
  {
    k: 'request',
    label: 'Request a critical action',
    sub: 'Ask for one of the six. It does not happen until someone else approves.',
  },
  {
    k: 'approve',
    label: 'Approve a critical action',
    sub: 'Approve someone else’s request. Never your own.',
  },
  {
    k: 'dragnet',
    label: 'See the Dragnet analysis',
    sub: 'Firm maturity and operational friction. Dragnet only.',
    dragnetOnly: true,
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FLOOR = 2;

function summarise(p: PersonAccess): string {
  const on = RIGHTS.filter((x) => p.rights[x.k] && x.k !== 'request' && x.k !== 'approve');
  return on.map((x) => x.label).join(', ') || 'See the study only';
}

type ViewName = 'main' | 'add' | 'person';

export function PeopleAccessPage({
  client,
  viewer,
}: {
  client: AdminClient;
  viewer: AuthUser;
}): JSX.Element {
  const [people, setPeople] = useState<PersonAccess[] | null>(null);
  const [approvers, setApprovers] = useState(0);
  const [criticalActions, setCriticalActions] = useState<
    Array<{ action: string; where: string; why: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewName>('main');
  const [editUserId, setEditUserId] = useState<string | null>(null); // null = adding
  const [detailUserId, setDetailUserId] = useState<string | null>(null);

  // Draft form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [org, setOrg] = useState<Org>('CIS');
  const [draft, setDraft] = useState<Record<RightKey, boolean>>({
    view: true,
    send: false,
    regs: false,
    setup: false,
    request: false,
    approve: false,
    dragnet: false,
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await client.getPeople();
      setPeople(res.people);
      setApprovers(res.approvers);
      setCriticalActions(res.criticalActions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load people & access');
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const doRun = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
        goMain();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (people === null) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  function goMain() {
    setView('main');
    setDetailUserId(null);
    setEditUserId(null);
  }

  function openAdd(userId: string | null) {
    setEditUserId(userId);
    const p = userId === null ? null : (people!.find((x) => x.userId === userId) ?? null);
    setName(p ? p.name : '');
    setEmail(p ? p.email : '');
    setOrg(p ? p.organization : 'CIS');
    setDraft(
      p
        ? { ...p.rights }
        : {
            view: true,
            send: false,
            regs: false,
            setup: false,
            request: false,
            approve: false,
            dragnet: false,
          },
    );
    setError(null);
    setView('add');
  }

  // Changing org away from Dragnet clears the dragnet right (not left inconsistent).
  function changeOrg(next: Org) {
    setOrg(next);
    if (next !== 'Dragnet') setDraft((d) => ({ ...d, dragnet: false }));
  }

  const validation: string = (() => {
    const e = email.trim();
    if (e.length && !EMAIL_RE.test(e)) return 'That is not a working email address.';
    if (e && people.some((p) => p.email === e && p.userId !== editUserId))
      return 'Somebody with that address already has access.';
    if (draft.dragnet && org !== 'Dragnet') return 'The Dragnet analysis is Dragnet only.';
    return '';
  })();

  const canSave = !!name.trim() && EMAIL_RE.test(email.trim()) && !validation;

  // The second-to-last approver's approve right cannot be un-ticked — same
  // floor, second door. Disabled here (UX hint) AND refused server-side (the
  // real gate).
  const editingPerson =
    editUserId === null ? null : (people.find((p) => p.userId === editUserId) ?? null);
  const lockApprove = !!editingPerson && editingPerson.rights.approve && approvers <= FLOOR;

  function save() {
    if (!canSave) return;
    const input = {
      name: name.trim(),
      email: email.trim(),
      organization: org,
      rights: {
        send: draft.send,
        regs: draft.regs,
        setup: draft.setup,
        request: draft.request,
        approve: draft.approve,
        dragnet: org === 'Dragnet' ? draft.dragnet : false,
      },
    };
    void doRun(() =>
      editUserId === null ? client.addPerson(input) : client.updatePersonRights(editUserId, input),
    );
  }

  function openPerson(userId: string) {
    setDetailUserId(userId);
    setView('person');
  }

  function removePerson(userId: string) {
    void doRun(() => client.removePerson(userId));
  }

  return (
    <main>
      {view === 'main' && (
        <MainView
          people={people}
          approvers={approvers}
          criticalActions={criticalActions}
          error={error}
          onOpenPerson={openPerson}
          onAdd={() => openAdd(null)}
        />
      )}

      {view === 'add' && (
        <AddView
          editing={editUserId !== null}
          name={name}
          email={email}
          org={org}
          draft={draft}
          validation={validation}
          canSave={canSave}
          lockApprove={lockApprove}
          busy={busy}
          error={error}
          setName={setName}
          setEmail={setEmail}
          onOrg={changeOrg}
          setDraft={setDraft}
          onSave={save}
          onCancel={goMain}
        />
      )}

      {view === 'person' && detailUserId !== null && (
        <PersonView
          person={people.find((p) => p.userId === detailUserId)!}
          approvers={approvers}
          isSelf={people.find((p) => p.userId === detailUserId)!.email === viewer.email}
          busy={busy}
          error={error}
          onEdit={() => openAdd(detailUserId)}
          onRemove={() => removePerson(detailUserId)}
          onBack={goMain}
        />
      )}
    </main>
  );
}

function ApproverBar({
  people,
  approvers,
}: {
  people: PersonAccess[];
  approvers: number;
}): JSX.Element | null {
  if (people.length === 0) {
    return (
      <div className="warnbox">
        <b>Nobody can sign in to study operations.</b>
        <p style={{ margin: '6px 0 0' }}>
          The study cannot be run at all. Access can’t be restored from this screen — contact the
          platform administrator to have an account reinstated.
        </p>
      </div>
    );
  }
  if (approvers >= FLOOR) return null;
  return (
    <div className="warnbox">
      <b>{approvers === 0 ? 'Nobody' : 'Only one person'} can approve a critical action.</b>
      <p style={{ margin: '6px 0 0' }}>
        {approvers === 1
          ? 'A maker can never approve their own request, so with one approver no critical action can ever complete. Collection cannot open, results cannot be locked, nothing can be published.'
          : 'No critical action can complete. Collection cannot open and nothing can be published.'}{' '}
        This is recoverable from here — give someone else the approval right.
      </p>
    </div>
  );
}

function MainView({
  people,
  approvers,
  criticalActions,
  error,
  onOpenPerson,
  onAdd,
}: {
  people: PersonAccess[];
  approvers: number;
  criticalActions: Array<{ action: string; where: string; why: string }>;
  error: string | null;
  onOpenPerson: (userId: string) => void;
  onAdd: () => void;
}): JSX.Element {
  return (
    <>
      <p className="eyebrow">Setup</p>
      <h1 tabIndex={-1}>People and access</h1>
      <p className="lede">
        Who can sign in to study operations, what each of them can do, and who can approve the six
        actions that cannot be undone.
      </p>

      {error && <div className="err">{error}</div>}

      <ApproverBar people={people} approvers={approvers} />

      <div className="tablewrap">
        <table className="ftbl">
          <thead>
            <tr>
              <th>Person</th>
              <th>Organisation</th>
              <th>Can do</th>
              <th>Critical actions</th>
            </tr>
          </thead>
          <tbody>
            {people.length === 0 ? (
              <tr>
                <td colSpan={4}>Nobody has access.</td>
              </tr>
            ) : (
              people.map((p) => {
                const can =
                  (p.rights.request ? 'Request' : '') +
                  (p.rights.request && p.rights.approve ? ' and ' : '') +
                  (p.rights.approve ? 'approve' : '');
                return (
                  <tr key={p.userId}>
                    <td>
                      <button
                        type="button"
                        className="back"
                        style={{ minHeight: 'auto' }}
                        onClick={() => onOpenPerson(p.userId)}
                      >
                        {p.name}
                      </button>
                    </td>
                    <td>{p.organization}</td>
                    <td>{summarise(p)}</td>
                    <td>
                      <span className={`tag ${can ? 'ok' : 'soft'}`}>{can || 'Neither'}</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="actions">
        <button type="button" className="btn" onClick={onAdd}>
          Add someone
        </button>
      </div>

      <section className="stage" style={{ marginTop: 22 }}>
        <div className="stagehead">
          <h2>The critical actions</h2>
        </div>
        <div className="stagebody">
          <p>
            Each is irreversible, lands outside the study team, and would not be obviously wrong at
            the moment it happened. That is the test.
          </p>
          <div className="tablewrap">
            <table className="ftbl">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Where</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {criticalActions.map((r) => (
                  <tr key={r.action}>
                    <td>
                      <b>{r.action}</b>
                    </td>
                    <td>{r.where}</td>
                    <td>{r.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <div className="note">
        <h3>Requesting and approving are separate rights</h3>
        <p>
          A person may hold both.{' '}
          <b>The constraint is a different person per request, not a different person in general</b>{' '}
          — someone who can request and approve still cannot approve their own. The approver may be
          from either organisation; CIS and Dragnet share one pool, and the organisation is recorded
          on every request and decision regardless.
        </p>
      </div>
    </>
  );
}

function AddView({
  editing,
  name,
  email,
  org,
  draft,
  validation,
  canSave,
  lockApprove,
  busy,
  error,
  setName,
  setEmail,
  onOrg,
  setDraft,
  onSave,
  onCancel,
}: {
  editing: boolean;
  name: string;
  email: string;
  org: Org;
  draft: Record<RightKey, boolean>;
  validation: string;
  canSave: boolean;
  lockApprove: boolean;
  busy: boolean;
  error: string | null;
  setName: (v: string) => void;
  setEmail: (v: string) => void;
  onOrg: (v: Org) => void;
  setDraft: (fn: (d: Record<RightKey, boolean>) => Record<RightKey, boolean>) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <>
      <button type="button" className="back" onClick={onCancel}>
        ← Back
      </button>
      <p className="eyebrow">Study operations</p>
      <h1 tabIndex={-1}>{editing ? `What ${name || 'they'} can do.` : 'Add someone.'}</h1>
      <p className="lede">They sign in with their own credentials. Nothing here is shared.</p>

      <div className="field">
        <label htmlFor="pName">Name</label>
        <input id="pName" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pOrg">Organisation</label>
        <select id="pOrg" value={org} onChange={(e) => onOrg(e.target.value as Org)}>
          <option value="CIS">CIS</option>
          <option value="Dragnet">Dragnet</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="pEmail">Work email</label>
        <input id="pEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>

      <h2 style={{ marginTop: 20 }}>What they can do</h2>
      <div>
        {RIGHTS.map((x) => {
          // The Dragnet right does not render at all for a CIS person.
          if (x.dragnetOnly && org !== 'Dragnet') return null;
          const disabled = x.k === 'view' || (x.k === 'approve' && lockApprove);
          return (
            <label
              key={x.k}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                padding: '13px 15px',
                marginBottom: 9,
                border: '1px solid var(--line-2, #bbb)',
                borderRadius: 8,
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                style={{ width: 22, height: 22, marginTop: 2 }}
                checked={!!draft[x.k]}
                disabled={disabled}
                onChange={(e) => setDraft((d) => ({ ...d, [x.k]: e.target.checked }))}
              />
              <span>
                <b style={{ display: 'block' }}>{x.label}</b>
                <span
                  style={{
                    display: 'block',
                    marginTop: 2,
                    fontSize: 13,
                    color: 'var(--fg-3, #6a6a6a)',
                  }}
                >
                  {x.k === 'approve' && lockApprove
                    ? 'Cannot be taken away — two approvers is the floor and removing this one would leave fewer.'
                    : x.sub}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {validation && <div className="err">{validation}</div>}
      {error && <div className="err">{error}</div>}
      <div className="actions">
        <button type="button" className="btn" disabled={!canSave || busy} onClick={onSave}>
          {editing ? 'Save' : 'Send them access'}
        </button>
        <button type="button" className="btn-2" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function PersonView({
  person,
  approvers,
  isSelf,
  busy,
  error,
  onEdit,
  onRemove,
  onBack,
}: {
  person: PersonAccess;
  approvers: number;
  isSelf: boolean;
  busy: boolean;
  error: string | null;
  onEdit: () => void;
  onRemove: () => void;
  onBack: () => void;
}): JSX.Element {
  const wouldBreach = person.rights.approve && approvers <= FLOOR;
  const on = RIGHTS.filter((x) => person.rights[x.k]);
  return (
    <>
      <button type="button" className="back" onClick={onBack}>
        ← Back
      </button>
      <p className="eyebrow">{person.organization}</p>
      <h1 tabIndex={-1}>{person.name}</h1>
      <dl className="kv">
        <dt>Email</dt>
        <dd>{person.email}</dd>
        <dt>Organisation</dt>
        <dd>{person.organization}</dd>
        <dt>Rights</dt>
        <dd>{on.map((x) => x.label).join('; ')}</dd>
      </dl>

      {error && <div className="err">{error}</div>}

      {wouldBreach && (
        <div className="warnbox">
          <b>This person cannot be removed, and their approval right cannot be taken away.</b>
          <p style={{ margin: '6px 0 0' }}>
            Two approvers is the floor. Below it a maker cannot get their own request approved, so
            no critical action could ever complete — collection could not open and nothing could be
            published.
          </p>
          <p style={{ margin: '6px 0 0' }}>
            Give somebody else the approval right first, then come back.
          </p>
        </div>
      )}

      <div className="actions">
        <button type="button" className="btn-2" onClick={onEdit}>
          Change what they can do
        </button>
        {/* Self-removal is never offered for the signed-in user's own row —
            the real check is server-side, against the real signed-in actor. */}
        {!isSelf && (
          <button type="button" className="btn-2" disabled={wouldBreach || busy} onClick={onRemove}>
            Remove their access
          </button>
        )}
      </div>
    </>
  );
}
