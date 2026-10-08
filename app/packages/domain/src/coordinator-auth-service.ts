import { Pool } from 'pg';
import { getActiveCoordinatorsByEmail, getCoordinatorPinHash } from '@cis/db';
import { verifyPassword } from '@cis/auth';
import type { FirmCoordinator } from '@cis/shared-types';
import { DomainError } from './errors';

/**
 * Coordinator authentication — the engineering requirement `UX-FRM-007` itself
 * leaves open ("Any six digits are accepted as a PIN. Verification, lockout
 * and reuse rules are engineering concerns."). The one fixed design decision
 * is not reinvented here: email plus PIN, never a username/password account.
 *
 * A coordinator token is issued by the API layer with a distinct claim
 * (`kind: 'coordinator'`) from an operator session, resolving to
 * `firm_coordinators.id` — never to `users.id`. Coordinators are a
 * structurally separate identity space from operators on this platform, the
 * same way a respondent is; this keeps that separation true for sign-in too.
 */
export class CoordinatorAuthError extends DomainError {
  constructor(message: string, code = 'COORDINATOR_AUTH') {
    super(message, code);
  }
}

/** Invalid email/PIN combination, or the coordinator has been revoked. Never
 *  distinguishes "no such email" from "wrong PIN" — the same anti-enumeration
 *  discipline as operator login. */
export class InvalidCoordinatorCredentialsError extends CoordinatorAuthError {
  constructor() {
    super('Invalid email or PIN', 'INVALID_CREDENTIALS');
  }
}

/** A valid-shaped argon2id hash to verify against when no coordinator matches
 *  the email, so the response takes the same shape of work either way — the
 *  same anti-enumeration technique operator login already uses by always
 *  calling verifyPassword regardless of whether a user was found. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo';

/**
 * Verify a coordinator's email + PIN. Returns the coordinator on success.
 * Revoked coordinators can never sign in, even with the correct PIN — a
 * removed coordinator's access ends immediately (`UX-FRM-007`), and a
 * coordinator with no PIN set yet (claim in progress) cannot sign in either.
 *
 * An email is unique per organization, not globally (`uniq_active_
 * coordinator_email`), so more than one active coordinator can share an
 * email across different firms. Every candidate is checked against the
 * supplied PIN — the first (and, in practice, only) one it actually matches
 * signs in, never just whichever row the lookup happened to return first.
 */
export async function coordinatorLogin(
  pool: Pool,
  input: { email: string; pin: string },
): Promise<FirmCoordinator> {
  const candidates = await getActiveCoordinatorsByEmail(pool, input.email);
  for (const candidate of candidates) {
    const pinHash = await getCoordinatorPinHash(pool, candidate.id);
    if (pinHash && (await verifyPassword(input.pin, pinHash))) {
      return candidate;
    }
  }
  // Uniform work even when no candidate exists, or none has a PIN set yet —
  // the same anti-enumeration technique as operator login.
  await verifyPassword(input.pin, DUMMY_HASH);
  throw new InvalidCoordinatorCredentialsError();
}
