import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import type { SessionPayload, CoordinatorSessionPayload } from '@cis/shared-types';

type AnySessionPayload = SessionPayload | CoordinatorSessionPayload;

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AnySessionPayload;
    user: AnySessionPayload;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionPayload;
    coordinatorSession: CoordinatorSessionPayload;
  }
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const secret = process.env['JWT_SECRET'];
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }

  await app.register(fastifyJwt, {
    secret,
    sign: { expiresIn: '8h', algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  });

  // Decorator to protect operator routes. Both token kinds are signed with
  // the same secret, so a valid signature alone isn't enough — a coordinator
  // token must never be usable as operator access, so it's rejected here
  // even though it verifies fine.
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    await request.jwtVerify();
    if (request.user.kind !== 'operator') {
      return reply
        .code(401)
        .send({ error: 'Unauthorized', message: 'Invalid session', statusCode: 401 });
    }
    request.session = request.user;
  });

  // Decorator to protect firm-coordinator routes — the portal-facing
  // counterpart to `authenticate`. Resolves to `firm_coordinators.id`, never
  // `users.id`, and rejects an operator token the same way `authenticate`
  // rejects a coordinator one.
  app.decorate('authenticateCoordinator', async (request: FastifyRequest, reply: FastifyReply) => {
    await request.jwtVerify();
    if (request.user.kind !== 'coordinator') {
      return reply
        .code(401)
        .send({ error: 'Unauthorized', message: 'Invalid session', statusCode: 401 });
    }
    request.coordinatorSession = request.user;
  });
}

// Extend Fastify instance type so routes can reference app.authenticate /
// app.authenticateCoordinator
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateCoordinator: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
