import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool, getActiveCoordinatorsByEmail, getCoordinatorPinHash } from '@cis/db';
import { coordinatorLogin, setCoordinatorPin } from '@cis/domain';

const LoginBody = z.object({
  email: z.string().email(),
  pin: z.string().min(1),
});

const LoginResponse = z.object({
  token: z.string(),
  coordinator: z.object({
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    email: z.string(),
    isLead: z.boolean(),
  }),
});

/**
 * Firm coordinator sign-in — UX-FRM-007. Email + PIN only, never a
 * username/password account. Issues a session token carrying a distinct
 * `kind: 'coordinator'` claim resolving to `firm_coordinators.id`, never
 * `users.id`, so it can never be mistaken for, or misused as, operator
 * access — see `apps/api/src/plugins/auth-plugin.ts`.
 */
export const firmCoordinatorAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  // Which of the two real next steps applies to this email — sign in, or the
  // address isn't a live coordinator's. The firm itself is never disclosed
  // here (only the PIN screen confirms who they are signing in as).
  app.get(
    '/portal/auth/lookup',
    { schema: { querystring: z.object({ email: z.string().email() }) } },
    async (request, reply) => {
      const candidates = await getActiveCoordinatorsByEmail(getPool(), request.query.email);
      let hasPin = false;
      for (const candidate of candidates) {
        if (await getCoordinatorPinHash(getPool(), candidate.id)) {
          hasPin = true;
          break;
        }
      }
      return reply.send({ branch: hasPin ? 'signin' : 'unclaimed' });
    },
  );

  app.post(
    '/portal/auth/login',
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
      const pool = getPool();
      const coordinator = await coordinatorLogin(pool, request.body);

      const token = await reply.jwtSign({
        sub: coordinator.id,
        organizationId: coordinator.organizationId,
        email: coordinator.email,
        kind: 'coordinator',
      });

      return reply.send({
        token,
        coordinator: {
          id: coordinator.id,
          organizationId: coordinator.organizationId,
          name: coordinator.name,
          email: coordinator.email,
          isLead: coordinator.isLead,
        },
      });
    },
  );

  // Change the signed-in coordinator's own PIN — requires the current PIN
  // once one is set (UX-FRM-007). Always acts on the coordinator identified
  // by the session token, never a client-supplied id.
  app.post(
    '/portal/auth/pin',
    {
      preHandler: [app.authenticateCoordinator],
      schema: {
        body: z.object({ newPin: z.string().min(4), currentPin: z.string().optional() }),
      },
    },
    async (request, reply) => {
      await setCoordinatorPin(getPool(), request.coordinatorSession.sub, {
        newPin: request.body.newPin,
        ...(request.body.currentPin !== undefined ? { currentPin: request.body.currentPin } : {}),
      });
      return reply.send({ ok: true });
    },
  );
};
