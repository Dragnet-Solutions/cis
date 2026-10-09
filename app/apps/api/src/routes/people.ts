import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import {
  listPeople,
  countApprovers,
  addPerson,
  updatePersonRights,
  removePerson,
  CRITICAL_ACTIONS,
} from '@cis/domain';

/**
 * People & Access routes — UX-OPS-006. Manages who holds the seven access
 * rights. Every rule the surface shows is enforced here server-side, never only
 * in the form: the two-approver floor, the Dragnet-only right, self-removal, and
 * the incomplete-payload gate. The actor is the signed-in operator (JWT `sub`),
 * so self-removal is detected against the real caller, not a client-supplied id.
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
  app.get('/people', { preHandler: [app.authenticate] }, async (_request, reply) => {
    const pool = getPool();
    const people = await listPeople(pool);
    const approvers = await countApprovers(pool);
    return reply.send({ people, approvers, criticalActions: CRITICAL_ACTIONS });
  });

  app.post(
    '/people',
    { preHandler: [app.authenticate], schema: { body: personBody } },
    async (request, reply) => {
      const person = await addPerson(getPool(), {
        name: request.body.name,
        email: request.body.email,
        organization: request.body.organization,
        rights: request.body.rights,
        actorId: request.user.sub,
      });
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
        actorId: request.user.sub,
      });
      return reply.send({ person });
    },
  );

  app.delete(
    '/people/:id',
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (request, reply) => {
      await removePerson(getPool(), { userId: request.params.id, actorId: request.user.sub });
      return reply.send({ removed: true });
    },
  );
};
