import { Pool } from 'pg';
import {
  ACCESS_RIGHTS,
  listActiveUsers,
  getUserById,
  getUserPermissions,
  getPermissionByCode,
  createUser,
  updateUserProfile,
  deactivateUser,
  grantPermissionToUser,
  revokePermissionFromUser,
  emailInUse,
  countActiveUsersWithPermission,
  usersWhoSetPasswordByLink,
  withTransaction,
} from '@cis/db';
import { randomBytes } from 'node:crypto';
import { hashPassword, loadRbacContext, requirePermission, hasPermission } from '@cis/auth';
import { writeAudit } from '@cis/audit';
import type { PersonAccess, AccessRightKey, AccessOrg } from '@cis/shared-types';
import { DomainError } from './errors';
import { issuePasswordSetLink } from './password-set-service';

/**
 * UX-OPS-006 — People & Access. Manages WHO holds the seven access rights,
 * including the `request`/`approve` rights that gate the critical actions.
 * It adds no new critical action and changes none of the six's own logic — it
 * only manages access to them.
 *
 * The corrected historical defects this encodes as hard server-side rules:
 *   - The two-approver floor is ENFORCED on both breach routes (removal and
 *     un-ticking `approve`), not warned. Below two approvers, a maker can never
 *     get their own request approved, so NO critical action of any kind could
 *     ever complete — a genuine platform-wide deadlock, not a preference.
 *   - The Dragnet analysis right does not exist for a CIS person (rejected
 *     server-side; the form omits it entirely rather than showing-and-refusing).
 *   - A person cannot remove their own access, even via a direct API call.
 */

export class PeopleAccessError extends DomainError {
  constructor(message: string, code = 'PEOPLE_ACCESS') {
    super(message, code);
  }
}

/** A change to someone's access the actor is not allowed to make (HTTP 403). */
export class PeopleAccessForbiddenError extends DomainError {
  constructor(message: string, code: 'SELF_CHANGE' | 'GRANT_NOT_HELD') {
    super(message, code);
  }
}

/**
 * The right that gates managing people (adding, changing rights, removing,
 * sending password links). There is no dedicated "manage access" right among
 * the seven, so it is `setup` ("Change the setup" — `edition:manage`), the
 * administrative right. On top of it: nobody may change their own rights, and
 * nobody may grant a right they do not hold themselves.
 */
export const ACCESS_MANAGER_RIGHT: AccessRightKey = 'setup';
export const ACCESS_MANAGER_PERMISSION = 'edition:manage';

/** The right whose floor guards the whole platform. */
const APPROVE_RIGHT: AccessRightKey = 'approve';
export const APPROVER_FLOOR = 2;

const CODE_BY_KEY = new Map<AccessRightKey, string>(
  ACCESS_RIGHTS.map((r) => [r.key as AccessRightKey, r.code]),
);
const KEY_BY_CODE = new Map<string, AccessRightKey>(
  ACCESS_RIGHTS.map((r) => [r.code, r.key as AccessRightKey]),
);

const RIGHT_LABEL: Record<AccessRightKey, string> = {
  view: 'See the study',
  send: 'Write to firms, regulators and participants',
  regs: 'Manage regulator engagement',
  setup: 'Change the setup',
  request: 'Request a critical action',
  approve: 'Approve a critical action',
  dragnet: 'See the Dragnet analysis',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EDITABLE_ORGS: AccessOrg[] = ['CIS', 'Dragnet'];

function emptyRights(): Record<AccessRightKey, boolean> {
  return {
    view: true, // universal, never editable
    send: false,
    regs: false,
    setup: false,
    request: false,
    approve: false,
    dragnet: false,
  };
}

/** The rights a person holds, named as People & access names them. */
function rightLabels(rights: Record<AccessRightKey, boolean>): string[] {
  return (Object.keys(RIGHT_LABEL) as AccessRightKey[])
    .filter((k) => rights[k])
    .map((k) => RIGHT_LABEL[k]);
}

/** Resolve a person's rights from the permission codes they hold. */
function rightsFromCodes(codes: string[]): Record<AccessRightKey, boolean> {
  const rights = emptyRights();
  for (const code of codes) {
    const key = KEY_BY_CODE.get(code);
    if (key) rights[key] = true;
  }
  rights.view = true;
  return rights;
}

function toPerson(
  user: {
    id: string;
    displayName: string;
    email: string;
    organization: string | null;
    lastLoginAt: Date | null;
  },
  codes: string[],
  setByLink = false,
): PersonAccess {
  const rights = rightsFromCodes(codes);
  return {
    userId: user.id,
    name: user.displayName,
    email: user.email,
    organization: (user.organization as AccessOrg) ?? 'CIS',
    rights,
    canRequest: rights.request,
    canApprove: rights.approve,
    // Never signed in and never used a set-password link: still waiting to
    // choose a password (they get an invitation link, not a reset link).
    awaitingPassword: user.lastLoginAt === null && !setByLink,
  };
}

/** Everyone who can sign in, with their resolved rights. Empty array is the
 *  distinct "nobody has access" state — a valid, if severe, outcome. */
export async function listPeople(pool: Pool): Promise<PersonAccess[]> {
  const users = await listActiveUsers(pool);
  const setByLink = await usersWhoSetPasswordByLink(
    pool,
    users.map((u) => u.id),
  );
  const people: PersonAccess[] = [];
  for (const u of users) {
    const perms = await getUserPermissions(pool, u.id);
    people.push(
      toPerson(
        u,
        perms.map((p) => p.code),
        setByLink.has(u.id),
      ),
    );
  }
  return people;
}

/**
 * Refuse unless the actor may manage people: an active person holding the
 * access-manager right. Identity is always the signed-in session's.
 */
export async function assertCanManagePeople(pool: Pool, actorId: string): Promise<void> {
  const actor = await getUserById(pool, actorId);
  const ctx = await loadRbacContext(pool, actorId);
  if (!actor || !actor.isActive) ctx.permissions = [];
  requirePermission(ctx, ACCESS_MANAGER_PERMISSION);
}

/** What the signed-in operator may do on People & access (for the surface). */
export async function peopleViewerAccess(
  pool: Pool,
  actorId: string,
): Promise<{ canManage: boolean; grantable: AccessRightKey[] }> {
  const actor = await getUserById(pool, actorId);
  const ctx = await loadRbacContext(pool, actorId);
  const canManage = !!actor?.isActive && hasPermission(ctx, ACCESS_MANAGER_PERMISSION);
  const held = rightsFromCodes(ctx.permissions.map((p) => p.code));
  return {
    canManage,
    grantable: canManage
      ? (Object.keys(held) as AccessRightKey[]).filter((k) => k !== 'view' && held[k])
      : [],
  };
}

/** Nobody may grant a right they do not hold themselves. */
async function assertGrantsHeld(
  pool: Pool,
  actorId: string,
  before: Record<AccessRightKey, boolean>,
  after: Record<AccessRightKey, boolean>,
): Promise<void> {
  const held = rightsFromCodes((await getUserPermissions(pool, actorId)).map((p) => p.code));
  for (const r of ACCESS_RIGHTS) {
    const key = r.key as AccessRightKey;
    if (key === 'view') continue;
    if (after[key] && !before[key] && !held[key]) {
      throw new PeopleAccessForbiddenError(
        `You cannot give the “${RIGHT_LABEL[key]}” right — you do not hold it yourself.`,
        'GRANT_NOT_HELD',
      );
    }
  }
}

/** Inside a change's transaction: at least one active person must still be
 *  able to manage access, or the change is rolled back. */
async function assertManagerRemains(c: Pool): Promise<void> {
  if ((await countActiveUsersWithPermission(c, ACCESS_MANAGER_PERMISSION)) < 1) {
    throw new PeopleAccessError(
      'Nobody would be left who can manage access. Give somebody else the ' +
        `“${RIGHT_LABEL[ACCESS_MANAGER_RIGHT]}” right first.`,
      'LAST_MANAGER',
    );
  }
}

export async function countApprovers(pool: Pool): Promise<number> {
  return countActiveUsersWithPermission(pool, CODE_BY_KEY.get(APPROVE_RIGHT) as string);
}

interface RightsInput {
  name: string;
  email: string;
  organization: AccessOrg;
  rights: Partial<Record<AccessRightKey, boolean>>;
}

/** Shared validation for add and edit. Mirrors the surface's gate at the API
 *  layer so an incomplete or invalid payload is refused server-side, never
 *  relying on the form alone. Returns the normalized right set. */
async function validate(
  pool: Pool,
  input: RightsInput,
  excludeUserId: string | null,
): Promise<Record<AccessRightKey, boolean>> {
  const name = input.name.trim();
  if (!name) throw new PeopleAccessError('A name is required', 'NAME_REQUIRED');

  const email = input.email.trim();
  if (!EMAIL_RE.test(email)) {
    throw new PeopleAccessError('That is not a working email address', 'EMAIL_INVALID');
  }
  if (await emailInUse(pool, email, excludeUserId)) {
    throw new PeopleAccessError('Somebody with that address already has access', 'EMAIL_DUPLICATE');
  }
  if (!EDITABLE_ORGS.includes(input.organization)) {
    throw new PeopleAccessError('Organisation must be CIS or Dragnet', 'ORG_INVALID');
  }

  // The Dragnet analysis right is Dragnet-only — a CIS person cannot hold it.
  // Rejected outright, not silently cleared, so an explicit attempt is an error.
  if (input.rights.dragnet && input.organization !== 'Dragnet') {
    throw new PeopleAccessError('The Dragnet analysis is Dragnet only', 'DRAGNET_CIS');
  }

  const rights = emptyRights();
  for (const r of ACCESS_RIGHTS) {
    const key = r.key as AccessRightKey;
    if (key === 'view') continue; // always true, not editable
    rights[key] = !!input.rights[key];
  }
  return rights;
}

/** Apply a right set to a user's DIRECT grants (add/remove to match), auditing
 *  the change. `view` is a no-op grant tracked for completeness. */
async function applyRights(
  pool: Pool,
  userId: string,
  rights: Record<AccessRightKey, boolean>,
  actorId: string,
): Promise<void> {
  for (const r of ACCESS_RIGHTS) {
    const key = r.key as AccessRightKey;
    const perm = await getPermissionByCode(pool, r.code);
    if (!perm) continue;
    if (key === 'view' || rights[key]) {
      await grantPermissionToUser(pool, userId, perm.id, actorId);
    } else {
      await revokePermissionFromUser(pool, userId, perm.id);
    }
  }
}

/**
 * Add a person. The account is created with an unusable random password hash
 * and the person is emailed a single-use link to choose their own password
 * (72 hours). Nobody is ever emailed a password.
 *
 * Only someone who may manage people can add one, and only with rights the
 * adder holds themselves.
 */
export async function addPerson(
  pool: Pool,
  input: RightsInput & { actorId: string },
  opts: { portalUrl?: string } = {},
): Promise<PersonAccess> {
  await assertCanManagePeople(pool, input.actorId);
  const rights = await validate(pool, input, null);
  await assertGrantsHeld(pool, input.actorId, emptyRights(), rights);
  // Random and discarded: nobody knows it, so the account cannot sign in until
  // its owner sets a password with the emailed link.
  const placeholder = await hashPassword(randomBytes(32).toString('base64url'));
  return withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    const user = await createUser(c, {
      email: input.email.trim(),
      passwordHash: placeholder,
      displayName: input.name.trim(),
      organization: input.organization,
    });
    await applyRights(c, user.id, rights, input.actorId);
    await writeAudit(c, {
      actorId: input.actorId,
      actionType: 'access.person.added',
      entityType: 'user',
      entityId: user.id,
      newValue: { email: user.email, organization: input.organization, rights },
    });
    // Tell them they have access, with a link to choose their own password.
    await issuePasswordSetLink(c, user.id, {
      purpose: 'invite',
      createdBy: input.actorId,
      portalUrl: opts.portalUrl ?? null,
      rights: rightLabels(rights),
    });
    const perms = await getUserPermissions(c, user.id);
    return toPerson(
      user,
      perms.map((p) => p.code),
    );
  });
}

/**
 * Change what a person can do. Enforces the two-approver floor on the
 * un-tick-`approve` route: if this person currently holds `approve` and is one
 * of exactly the floor's worth of approvers (or fewer), their `approve` right
 * cannot be removed. Changing organisation away from Dragnet clears `dragnet`.
 */
export async function updatePersonRights(
  pool: Pool,
  input: RightsInput & { userId: string; actorId: string },
): Promise<PersonAccess> {
  await assertCanManagePeople(pool, input.actorId);
  if (input.userId === input.actorId) {
    throw new PeopleAccessForbiddenError('You cannot change your own access', 'SELF_CHANGE');
  }
  const existing = await getUserById(pool, input.userId);
  if (!existing || !existing.isActive) {
    throw new PeopleAccessError('Person not found', 'NOT_FOUND');
  }

  const currentCodes = (await getUserPermissions(pool, input.userId)).map((p) => p.code);
  const currentlyApproves = currentCodes.includes(CODE_BY_KEY.get(APPROVE_RIGHT) as string);

  const rights = await validate(pool, input, input.userId);
  await assertGrantsHeld(pool, input.actorId, rightsFromCodes(currentCodes), rights);

  // Two-approver floor: removing the approve right from one of the last two
  // approvers is refused, not warned — it would make every critical action
  // impossible to complete.
  if (currentlyApproves && !rights.approve) {
    const approvers = await countApprovers(pool);
    if (approvers <= APPROVER_FLOOR) {
      throw new PeopleAccessError(
        'This person is one of the last two approvers, so their approval right cannot be ' +
          'taken away. Give somebody else the approval right first, then come back.',
        'APPROVER_FLOOR',
      );
    }
  }

  return withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    await updateUserProfile(c, input.userId, {
      displayName: input.name.trim(),
      email: input.email.trim(),
      organization: input.organization,
    });
    await applyRights(c, input.userId, rights, input.actorId);
    await assertManagerRemains(c);
    await writeAudit(c, {
      actorId: input.actorId,
      actionType: 'access.person.rights_changed',
      entityType: 'user',
      entityId: input.userId,
      oldValue: { rights: rightsFromCodes(currentCodes) },
      newValue: { organization: input.organization, rights },
    });
    const perms = await getUserPermissions(c, input.userId);
    const updated = await getUserById(c, input.userId);
    const setByLink = await usersWhoSetPasswordByLink(c, [input.userId]);
    return toPerson(
      updated as NonNullable<typeof updated>,
      perms.map((p) => p.code),
      setByLink.has(input.userId),
    );
  });
}

/**
 * Remove a person's access. Two hard refusals, both server-side:
 *   - A person can never remove THEIR OWN access.
 *   - One of the last two approvers cannot be removed (the two-approver floor).
 */
export async function removePerson(
  pool: Pool,
  input: { userId: string; actorId: string },
): Promise<void> {
  if (input.userId === input.actorId) {
    throw new PeopleAccessError('You cannot remove your own access', 'SELF_REMOVAL');
  }
  await assertCanManagePeople(pool, input.actorId);
  const user = await getUserById(pool, input.userId);
  if (!user) throw new PeopleAccessError('Person not found', 'NOT_FOUND');

  const codes = (await getUserPermissions(pool, input.userId)).map((p) => p.code);
  const isApprover = codes.includes(CODE_BY_KEY.get(APPROVE_RIGHT) as string);
  if (isApprover) {
    const approvers = await countApprovers(pool);
    if (approvers <= APPROVER_FLOOR) {
      throw new PeopleAccessError(
        'This person is one of the last two approvers and cannot be removed. Give somebody ' +
          'else the approval right first, then come back.',
        'APPROVER_FLOOR',
      );
    }
  }

  await withTransaction(pool, async (client) => {
    const c = client as unknown as Pool;
    await deactivateUser(c, input.userId);
    await assertManagerRemains(c);
    await writeAudit(c, {
      actorId: input.actorId,
      actionType: 'access.person.removed',
      entityType: 'user',
      entityId: input.userId,
      oldValue: { email: user.email },
    });
  });
}

/** The critical actions and the seven rights, for the surface to render. */
export const CRITICAL_ACTIONS: ReadonlyArray<{ action: string; where: string; why: string }> = [
  {
    action: 'Freeze the instruments',
    where: 'Surveys',
    why: 'No question, option or order changes afterwards.',
  },
  {
    action: 'Lock the results',
    where: 'Edition',
    why: 'Collection ends. Surveys in progress are lost.',
  },
  {
    action: 'Approve the scoring methodology',
    where: 'Scoring',
    why: 'Until it is approved, no run is official and no report shows an index score.',
  },
  {
    action: 'Sign off a scoring run',
    where: 'Scoring',
    why: 'Every published figure comes from the signed run.',
  },
  {
    action: 'Approve the national report',
    where: 'National report',
    why: 'It goes to the market.',
  },
  {
    action: 'Release the firm reports',
    where: 'Firm reports',
    why: 'Every firm sees its report at once.',
  },
  {
    action: 'Change a sample floor after collection opens',
    where: 'Edition',
    why: 'Prevented outright rather than gated — it would mean choosing what is reportable while knowing what the data says.',
  },
];

export const ACCESS_RIGHT_META = ACCESS_RIGHTS.map((r) => ({
  key: r.key as AccessRightKey,
  dragnetOnly: r.key === 'dragnet',
}));

/**
 * Email a person a fresh set-password link: an invitation link if they have
 * not chosen a password yet, otherwise a reset link. Requires the same right as
 * adding a person. Returns which kind was sent and when it expires — never the
 * link itself.
 */
export async function sendPasswordLink(
  pool: Pool,
  input: { userId: string; actorId: string },
  opts: { portalUrl?: string } = {},
): Promise<{ purpose: 'invite' | 'reset'; expiresAt: Date }> {
  await assertCanManagePeople(pool, input.actorId);
  const user = await getUserById(pool, input.userId);
  if (!user || !user.isActive) throw new PeopleAccessError('Person not found', 'NOT_FOUND');
  const setByLink = await usersWhoSetPasswordByLink(pool, [user.id]);
  const purpose = user.lastLoginAt === null && !setByLink.has(user.id) ? 'invite' : 'reset';
  const codes = (await getUserPermissions(pool, user.id)).map((p) => p.code);
  const { expiresAt } = await withTransaction(pool, async (client) =>
    issuePasswordSetLink(client as unknown as Pool, user.id, {
      purpose,
      createdBy: input.actorId,
      portalUrl: opts.portalUrl ?? null,
      rights: rightLabels(rightsFromCodes(codes)),
    }),
  );
  return { purpose, expiresAt };
}
