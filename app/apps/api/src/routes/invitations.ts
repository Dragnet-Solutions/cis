import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import {
  listAudiences,
  listMessageTemplates,
  saveTemplate,
  validateUploadFile,
  sendBatch,
  getBatches,
  getBatchReport,
  getInvitationRequests,
  resolveInvitationRequest,
  resolveFirmNamesToOrgs,
  getBouncedRecipients,
} from '@cis/domain';

/**
 * Invitations routes — UX-OPS-002. Operator-authenticated. The sending provider
 * is not chosen here (a config decision, README open item), so send() uses the
 * default recording service; delivery/bounce/open/click state arrives later via
 * a provider callback (not part of this surface).
 */
export const invitationsRoutes: FastifyPluginAsyncZod = async (app) => {
  const editionParam = z.object({ id: z.string().uuid() });

  app.get(
    '/editions/:id/invitations/audiences',
    { preHandler: [app.authenticate], schema: { params: editionParam } },
    async (request, reply) => {
      const audiences = await listAudiences(getPool(), request.params.id);
      return reply.send({ audiences });
    },
  );

  app.get(
    '/editions/:id/invitations/templates',
    { preHandler: [app.authenticate], schema: { params: editionParam } },
    async (request, reply) => {
      const templates = await listMessageTemplates(getPool(), request.params.id);
      return reply.send({ templates });
    },
  );

  app.post(
    '/editions/:id/invitations/templates',
    {
      preHandler: [app.authenticate],
      schema: {
        params: editionParam,
        body: z.object({
          name: z.string(),
          subject: z.string(),
          body: z.string(),
          audienceKind: z.enum(['firm', 'participant', 'regulator', 'upload']),
          requiresCode: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const template = await saveTemplate(getPool(), {
        editionId: request.params.id,
        name: request.body.name,
        subject: request.body.subject,
        body: request.body.body,
        audienceKind: request.body.audienceKind,
        ...(request.body.requiresCode !== undefined
          ? { requiresCode: request.body.requiresCode }
          : {}),
        createdBy: request.user.sub,
      });
      return reply.status(201).send({ template });
    },
  );

  // Resolves uploaded rows' firm names against the register, once, so the
  // upload flow can carry a real organizationId into validate-upload/send —
  // the same exact, case-insensitive match the register already uses
  // elsewhere (resolveFirmNameToOrg), batched to one fetch instead of one per
  // row. This is NOT a register-match validation check (no fifth check was
  // added); it only supplies the id the already-existing fourth check
  // (already sent this template) needs to fire for an upload.
  app.post(
    '/editions/:id/invitations/resolve-firm-names',
    {
      preHandler: [app.authenticate],
      schema: {
        params: editionParam,
        body: z.object({ firmNames: z.array(z.string()) }),
      },
    },
    async (request, reply) => {
      const resolved = await resolveFirmNamesToOrgs(getPool(), request.body.firmNames);
      return reply.send({ resolved });
    },
  );

  app.post(
    '/editions/:id/invitations/validate-upload',
    {
      preHandler: [app.authenticate],
      schema: {
        params: editionParam,
        body: z.object({
          templateId: z.string().uuid(),
          rows: z.array(
            z.object({
              firmName: z.string(),
              email: z.string(),
              organizationId: z.string().uuid().nullable().optional(),
            }),
          ),
        }),
      },
    },
    async (request, reply) => {
      const result = await validateUploadFile(getPool(), {
        editionId: request.params.id,
        templateId: request.body.templateId,
        rows: request.body.rows,
      });
      return reply.send(result);
    },
  );

  app.post(
    '/editions/:id/invitations/send',
    {
      preHandler: [app.authenticate],
      schema: {
        params: editionParam,
        body: z.object({
          templateId: z.string().uuid(),
          audienceId: z.string(),
          uploadRows: z
            .array(
              z.object({
                firmName: z.string(),
                email: z.string(),
                organizationId: z.string().uuid().nullable().optional(),
              }),
            )
            .optional(),
        }),
      },
    },
    async (request, reply) => {
      const result = await sendBatch(getPool(), {
        editionId: request.params.id,
        templateId: request.body.templateId,
        audienceId: request.body.audienceId,
        ...(request.body.uploadRows ? { uploadRows: request.body.uploadRows } : {}),
        sentBy: request.user.sub,
      });
      return reply.status(201).send({
        batchId: result.batch.id,
        attempted: result.attempted,
        sent: result.sent,
        skippedDuplicates: result.skippedDuplicates,
      });
    },
  );

  app.get(
    '/editions/:id/invitations/batches',
    { preHandler: [app.authenticate], schema: { params: editionParam } },
    async (request, reply) => {
      const batches = await getBatches(getPool(), request.params.id);
      return reply.send({ batches });
    },
  );

  app.get(
    '/invitations/batches/:batchId/report',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ batchId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const report = await getBatchReport(getPool(), request.params.batchId);
      return reply.send({ report });
    },
  );

  // Listing only — no resend action exists anywhere in this API.
  app.get(
    '/invitations/batches/:batchId/bounced',
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ batchId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const bounced = await getBouncedRecipients(getPool(), request.params.batchId);
      return reply.send({ bounced });
    },
  );

  app.get(
    '/editions/:id/invitations/requests',
    {
      preHandler: [app.authenticate],
      schema: {
        params: editionParam,
        querystring: z.object({ includeResolved: z.coerce.boolean().optional() }),
      },
    },
    async (request, reply) => {
      const requests = await getInvitationRequests(
        getPool(),
        request.params.id,
        request.query.includeResolved ?? false,
      );
      return reply.send({ requests });
    },
  );

  app.post(
    '/invitations/requests/:requestId/resolve',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ requestId: z.string().uuid() }),
        body: z.object({
          resolution: z.enum(['code_issued', 'marked_done']),
          reissueTemplateId: z.string().uuid().optional(),
        }),
      },
    },
    async (request, reply) => {
      const resolved = await resolveInvitationRequest(getPool(), {
        requestId: request.params.requestId,
        resolution: request.body.resolution,
        ...(request.body.reissueTemplateId
          ? { reissueTemplateId: request.body.reissueTemplateId }
          : {}),
        resolvedBy: request.user.sub,
      });
      return reply.send({ request: resolved });
    },
  );
};
