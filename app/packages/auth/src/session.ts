import jwt from 'jsonwebtoken';
import type { SessionPayload } from '@cis/shared-types';

const ALGORITHM = 'HS256' as const;
const EXPIRES_IN = '8h';

function getSecret(): string {
  const secret = process.env['JWT_SECRET'];
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }
  return secret;
}

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, getSecret(), { algorithm: ALGORITHM, expiresIn: EXPIRES_IN });
}

export function verifySession(token: string): SessionPayload {
  const decoded = jwt.verify(token, getSecret(), { algorithms: [ALGORITHM] });
  if (typeof decoded === 'string' || !decoded['sub']) {
    throw new Error('Invalid token payload');
  }
  return {
    sub: decoded['sub'] as string,
    email: decoded['email'] as string,
    displayName: decoded['displayName'] as string,
    org: (decoded['org'] as string | null | undefined) ?? null,
    kind: 'operator',
  };
}
