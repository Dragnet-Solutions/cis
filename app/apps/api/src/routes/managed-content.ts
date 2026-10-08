import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getPool } from '@cis/db';
import {
  CONTENT_AREAS,
  getContentState,
  listTemplateSubKeys,
  saveDraft,
  publishDraft,
  type ContentArea,
} from '@cis/domain';

/**
 * UX-ADM-CNT-001 managed wording routes.
 * All routes require app.authenticate (operator session) + edition:manage permission
 * (Phase 8's `setup` right). Permission is enforced in the domain service; HTTP 403
 * is returned via ManagedContentPermissionError in resolveStatusCode.
 */

const AREA_SCHEMA = z.enum(CONTENT_AREAS);
const SUB_KEY_DEFAULT = '';

export const managedContentRoutes: FastifyPluginAsyncZod = async (app) => {
  /** List all content areas and, for template areas, their sub-keys. */
  app.get('/managed-content', { preHandler: [app.authenticate] }, async (_request, reply) => {
    const pool = getPool();
    const areas: Array<{
      area: ContentArea;
      label: string;
      isTemplateArea: boolean;
      subKeys?: Array<{ name: string; subject: string }>;
    }> = [];

    const LABELS: Record<ContentArea, string> = {
      privacy_notice: 'Privacy notice',
      participant_templates: 'Participant message templates',
      firm_outreach_copy: 'Firm outreach copy',
      invitation_landing: 'Invitation landing statements',
      organisation_descriptions: 'Organisation descriptions',
      help_text: 'Help text',
      reminder_content: 'Reminder message content',
    };

    for (const area of CONTENT_AREAS) {
      const isTemplateArea = area === 'participant_templates' || area === 'firm_outreach_copy';
      const subKeys = isTemplateArea ? await listTemplateSubKeys(pool, area) : undefined;
      areas.push({ area, label: LABELS[area], isTemplateArea, subKeys });
    }

    return reply.send({ areas });
  });

  /** Get current state for a content area+subKey (live body + version history). */
  app.get(
    '/managed-content/:area/:subKey',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({
          area: AREA_SCHEMA,
          subKey: z.string().max(200),
        }),
      },
    },
    async (request, reply) => {
      const pool = getPool();
      const subKey = request.params.subKey === '_' ? SUB_KEY_DEFAULT : request.params.subKey;
      const state = await getContentState(pool, request.params.area, subKey);
      return reply.send(state);
    },
  );

  /** Save a new draft version (does not publish). */
  app.post(
    '/managed-content/:area/:subKey/drafts',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({
          area: AREA_SCHEMA,
          subKey: z.string().max(200),
        }),
        body: z.object({ body: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const pool = getPool();
      const subKey = request.params.subKey === '_' ? SUB_KEY_DEFAULT : request.params.subKey;
      const version = await saveDraft(
        pool,
        request.params.area,
        subKey,
        request.body.body,
        request.user.sub,
      );
      return reply.status(201).send({ version });
    },
  );

  /** Publish a specific saved draft to live. */
  app.post(
    '/managed-content/:area/:subKey/drafts/:versionId/publish',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({
          area: AREA_SCHEMA,
          subKey: z.string().max(200),
          versionId: z.string().uuid(),
        }),
      },
    },
    async (request, reply) => {
      const pool = getPool();
      const subKey = request.params.subKey === '_' ? SUB_KEY_DEFAULT : request.params.subKey;
      await publishDraft(
        pool,
        request.params.area,
        subKey,
        request.params.versionId,
        request.user.sub,
      );
      return reply.send({ published: true, versionId: request.params.versionId });
    },
  );
};
