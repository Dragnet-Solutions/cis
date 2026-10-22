import type { FastifyReply } from 'fastify';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import {
  consumePasswordSetLink,
  getPasswordSetLinkInfo,
  PasswordSetError,
  requestPasswordReset,
} from '@cis/domain';
import { kickMailDispatcher } from '../mail/dispatcher';
import { publicOrigin } from '../public-url';

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

  // "Forgot password?" on the sign-in page. The answer is the same whether or
  // not the address has an account, so the form cannot be used to find out;
  // when it does, a reset link is emailed (O-02). Rate-limited per address
  // like sign-in, and capped per account in the domain.
  app.post(
    '/auth/password-reset/request',
    {
      config: {
        rateLimit: {
          max: Number(process.env['RATE_LIMIT_RESET_MAX'] ?? 5),
          timeWindow: Number(process.env['RATE_LIMIT_AUTH_WINDOW_MS'] ?? 900_000),
        },
      },
      schema: { body: z.object({ email: z.string().trim().max(320) }) },
    },
    async (request, reply) => {
      const email = request.body.email;
      const ctx = { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null };
      // Answered before any lookup, so an account and a stranger take the same
      // time: the lookup, the link and the email happen after the response.
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        track(
          new Promise<void>((resolve) => setImmediate(resolve))
            .then(async () => {
              const { queued } = await requestPasswordReset(getPool(), {
                email,
                portalUrl: publicOrigin(),
                ...ctx,
              });
              if (queued) kickMailDispatcher();
            })
            .catch((err: unknown) => request.log.error({ err }, 'Password reset request failed')),
        );
      }
      return reply.send({ requested: true, message: RESET_NEUTRAL_MESSAGE });
    },
  );
};

export const RESET_NEUTRAL_MESSAGE =
  'If that address has an account, we have emailed it a link to choose a new password. The link works once and expires in 24 hours.';

/** Reset requests still being worked on after their response (see above). */
const inFlight = new Set<Promise<void>>();
function track(job: Promise<void>): void {
  inFlight.add(job);
  void job.finally(() => inFlight.delete(job));
}

/** Resolves once every reset request answered so far has been processed (tests, shutdown). */
export async function settlePasswordResets(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}
