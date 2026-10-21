import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import {
  listPeople,
  countApprovers,
  addPerson,
  updatePersonRights,
  removePerson,
  sendPasswordLink,
  peopleViewerAccess,
  CRITICAL_ACTIONS,
} from '@cis/domain';
import { kickMailDispatcher } from '../mail/dispatcher';
import { publicOrigin } from '../public-url';

/**
 * People & Access routes — UX-OPS-006. Manages who holds the seven access
 * rights. Every rule the surface shows is enforced server-side (in
 * people-access-service), never only in the form: only someone holding the
 * access-manager right ("Change the setup") may add, change or remove people
 * or send password links; nobody may change their own rights; nobody may
 * grant a right they do not hold; at least one access manager always remains;
 * plus the two-approver floor, the Dragnet-only right, self-removal, and the
 * incomplete-payload gate. The actor is the signed-in operator (JWT `sub`),
 * never a client-supplied id. Any signed-in operator may view the roster.
 */
const rightsSchema = z.object({
  send: z.boolean().optional(),
  regs: z.boolean().optional(),
  setup: z.boolean().optional(),
  request: z.boolean().optional(),
  approve: z.boolean().optional(),
  dragnet: z.boolean().optional(),
});

const personBody = z.object({
  name: z.string(),
  email: z.string(),
  organization: z.enum(['CIS', 'Dragnet']),
  rights: rightsSchema,
});

export const peopleRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/people', { preHandler: [app.authenticate] }, async (request, reply) => {
    const pool = getPool();
    const people = await listPeople(pool);
    const approvers = await countApprovers(pool);
    const viewer = await peopleViewerAccess(pool, request.session.sub);
    return reply.send({ people, approvers, criticalActions: CRITICAL_ACTIONS, viewer });
  });

  app.post(
    '/people',
    { preHandler: [app.authenticate], schema: { body: personBody } },
    async (request, reply) => {
      const person = await addPerson(
        getPool(),
        {
          name: request.body.name,
          email: request.body.email,
          organization: request.body.organization,
          rights: request.body.rights,
          actorId: request.session.sub,
        },
        { portalUrl: publicOrigin() },
      );
      kickMailDispatcher();
      return reply.status(201).send({ person });
    },
  );

  app.patch(
    '/people/:id',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid() }), body: personBody },
    },
    async (request, reply) => {
      const person = await updatePersonRights(getPool(), {
        userId: request.params.id,
        name: request.body.name,
        email: request.body.email,
        organization: request.body.organization,
        rights: request.body.rights,
        actorId: request.session.sub,
      });
      return reply.send({ person });
    },
  );

  app.delete(
    '/people/:id',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      await removePerson(getPool(), { userId: request.params.id, actorId: request.session.sub });
      return reply.send({ removed: true });
    },
  );

  // Email a fresh set-password link: an invitation link to someone who has not
  // chosen a password yet, otherwise a reset link. Never returns the link.
  app.post(
    '/people/:id/password-link',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const sent = await sendPasswordLink(
        getPool(),
        { userId: request.params.id, actorId: request.session.sub },
        { portalUrl: publicOrigin() },
      );
      kickMailDispatcher();
      return reply.send(sent);
    },
  );
};
