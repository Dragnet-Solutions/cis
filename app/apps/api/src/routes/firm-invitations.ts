import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import {
  inviteFirm,
  sendInvitationAgain,
  revokeInvitation,
  listInvitations,
  lookupInvitation,
  isFirmClaimed,
  FirmInvitationError,
} from '@cis/domain';
import { loadRbacContext } from '@cis/auth';
import { kickMailDispatcher } from '../mail/dispatcher';
import { publicOrigin } from '../public-url';

/**
 * Inviting a firm to claim its space. The operator routes need a signed-in
 * operator with the "Write to firms, regulators and participants" right
 * (checked in the domain); the operator is always the session's user. The
 * public lookup lets the firm portal open the claim view for an invitation
 * link, and says plainly why a link cannot be used.
 */
export const firmInvitationRoutes: FastifyPluginAsyncZod = async (app) => {
  const actor = (request: {
    ip: string;
    headers: Record<string, string | string[] | undefined>;
    session: { sub: string };
  }) => ({
    actorId: request.session.sub,
    ipAddress: request.ip,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
  });

  app.post(
    '/firms/:orgId/invitations',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ orgId: z.string().uuid() }),
        body: z.object({
          email: z.string().min(3).max(320),
          contactName: z.string().max(200).optional(),
          editionId: z.string().uuid().optional(),
        }),
      },
    },
    async (request, reply) => {
      const pool = getPool();
      const rbac = await loadRbacContext(pool, request.session.sub);
      const result = await inviteFirm(
        pool,
        rbac,
        {
          organizationId: request.params.orgId,
          email: request.body.email,
          contactName: request.body.contactName ?? null,
          editionId: request.body.editionId ?? null,
        },
        { ...actor(request), portalUrl: publicOrigin() },
      );
      kickMailDispatcher();
      return reply.status(result.resent ? 200 : 201).send(result);
    },
  );

  app.get(
    '/firms/:orgId/invitations',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ orgId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const pool = getPool();
      const rbac = await loadRbacContext(pool, request.session.sub);
      const invitations = await listInvitations(pool, rbac, {
        organizationId: request.params.orgId,
      });
      const claimed = await isFirmClaimed(pool, request.params.orgId);
      return reply.send({ invitations, claimed });
    },
  );

  app.get(
    '/editions/:id/firm-invitations',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const pool = getPool();
      const rbac = await loadRbacContext(pool, request.session.sub);
      const invitations = await listInvitations(pool, rbac, { editionId: request.params.id });
      return reply.send({ invitations });
    },
  );

  app.post(
    '/firm-invitations/:id/resend',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const pool = getPool();
      const rbac = await loadRbacContext(pool, request.session.sub);
      const invitation = await sendInvitationAgain(pool, rbac, request.params.id, {
        ...actor(request),
        portalUrl: publicOrigin(),
      });
      kickMailDispatcher();
      return reply.send({ invitation });
    },
  );

  app.post(
    '/firm-invitations/:id/revoke',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const pool = getPool();
      const rbac = await loadRbacContext(pool, request.session.sub);
      const invitation = await revokeInvitation(pool, rbac, request.params.id, actor(request));
      return reply.send({ invitation });
    },
  );

  // Public: what an invitation link is for. 404 for an unknown link, 410 for
  // one that was used, withdrawn or has expired — each with a plain message
  // and a `code` the portal can branch on.
  app.get(
    '/firm/invitations/:token',
    {
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
      schema: { params: z.object({ token: z.string().min(1).max(100) }) },
    },
    async (request, reply) => {
      try {
        const found = await lookupInvitation(getPool(), request.params.token);
        return reply.send({ invitation: found });
      } catch (err) {
        if (err instanceof FirmInvitationError) {
          const statusCode = err.reason === 'NOT_FOUND' ? 404 : 410;
          return reply.status(statusCode).send({
            error: 'FirmInvitationError',
            code: err.reason,
            message: err.message,
            statusCode,
          });
        }
        throw err;
      }
    },
  );
};
