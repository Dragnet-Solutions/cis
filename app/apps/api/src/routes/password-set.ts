import type { FastifyReply } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import { consumePasswordSetLink, getPasswordSetLinkInfo, PasswordSetError } from '@cis/domain';

/**
 * Public set-password routes, opened from the emailed link
 * (`/set-password?token=…`). No session: the token is the credential. Both are
 * rate-limited like sign-in. The token is never logged (it travels in the path
 * of the GET only as a lookup and is hashed before any query) and never
 * returned.
 */

const rateLimit = () => ({
  max: Number(process.env['RATE_LIMIT_AUTH_MAX'] ?? 10),
  timeWindow: Number(process.env['RATE_LIMIT_AUTH_WINDOW_MS'] ?? 900_000),
});

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof PasswordSetError) {
    return reply.status(err.httpStatus).send({
      error: err.code === 'POLICY' ? 'BadRequest' : err.code === 'GONE' ? 'Gone' : 'NotFound',
      message: err.message,
      statusCode: err.httpStatus,
    });
  }
  throw err;
}

export const passwordSetRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/auth/password-set/:token',
    {
      config: { rateLimit: rateLimit() },
      schema: { params: z.object({ token: z.string().min(1).max(200) }) },
    },
    async (request, reply) => {
      try {
        return reply.send(await getPasswordSetLinkInfo(getPool(), request.params.token));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/auth/password-set',
    {
      config: { rateLimit: rateLimit() },
      schema: {
        body: z.object({ token: z.string().min(1).max(200), password: z.string().max(1000) }),
      },
    },
    async (request, reply) => {
      try {
        const { email } = await consumePasswordSetLink(getPool(), {
          token: request.body.token,
          password: request.body.password,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        return reply.send({ passwordSet: true, email });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};
