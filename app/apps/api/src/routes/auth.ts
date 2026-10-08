import type { FastifyReply } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getPool,
  getUserByEmail,
  getUserById,
  updateLastLogin,
  getDirectPermissionCodes,
} from '@cis/db';
import { verifyPassword } from '@cis/auth';
import { writeAudit } from '@cis/audit';

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const LoginResponse = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    org: z.string().nullable(),
    hasDragnetRight: z.boolean(),
  }),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: Number(process.env['RATE_LIMIT_AUTH_MAX'] ?? 10),
          timeWindow: Number(process.env['RATE_LIMIT_AUTH_WINDOW_MS'] ?? 900_000),
        },
      },
      schema: {
        body: LoginBody,
        response: { 200: LoginResponse },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const pool = getPool();

      const user = await getUserByEmail(pool, email);

      // Always verify to avoid timing-based user enumeration
      const passwordValid = user ? await verifyPassword(password, user.passwordHash) : false;

      if (!user || !passwordValid) {
        return (reply as FastifyReply).status(401).send({
          error: 'Unauthorized',
          message: 'Invalid credentials',
          statusCode: 401,
        });
      }

      await updateLastLogin(pool, user.id);

      const permCodes = await getDirectPermissionCodes(pool, user.id);
      const hasDragnetRight = permCodes.includes('access:dragnet');

      await writeAudit(pool, {
        actorId: user.id,
        actionType: 'user.login',
        entityType: 'user',
        entityId: user.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      const token = await reply.jwtSign({
        sub: user.id,
        email: user.email,
        displayName: user.displayName,
        org: user.organization,
        kind: 'operator',
      });

      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          org: user.organization,
          hasDragnetRight,
        },
      });
    },
  );

  // Sliding session: an active operator swaps a still-valid token for a fresh
  // one, so a working session is not cut off at a fixed 8h from sign-in. The
  // user is re-read, so a deactivated account cannot keep itself alive.
  app.post('/auth/refresh', { preHandler: [app.authenticate] }, async (request, reply) => {
    const user = await getUserById(getPool(), request.session.sub);
    if (!user) {
      return (reply as FastifyReply)
        .status(401)
        .send({ error: 'Unauthorized', message: 'Invalid session', statusCode: 401 });
    }
    const token = await reply.jwtSign({
      sub: user.id,
      email: user.email,
      displayName: user.displayName,
      org: user.organization,
      kind: 'operator',
    });
    return reply.send({ token });
  });
};
