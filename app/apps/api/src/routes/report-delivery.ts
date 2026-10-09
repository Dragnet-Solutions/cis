import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getCoordinatorById, getPool, listPublishedIndustryReports } from '@cis/db';
import {
  getPublishedIndustryReport,
  getReleasedFirmReport,
  getIndustryNarrative,
} from '@cis/domain';
import { renderReportPdf } from '../pdf/report-pdf';

/**
 * Where a report goes once it leaves CIS.
 *
 * - A firm's coordinators read their OWN released report in the firm portal and
 *   download it as a PDF. The firm comes from the coordinator's session, never
 *   from the request: there is no parameter here that could name another firm.
 *   Before release there is nothing to see.
 * - Anyone can read the published Industry report and download its PDF. No
 *   session; the PDF is rendered once per published narrative and kept.
 *
 * What leaves carries only the narrative's passed sentences — never the
 * held-back ones, never who drafted it (report-publication-service.ts).
 */

const filename = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const reportDeliveryRoutes: FastifyPluginAsyncZod = async (app) => {
  // ── The firm portal ────────────────────────────────────────────────────────
  const activeCoordinator = async (sub: string) => {
    const c = await getCoordinatorById(getPool(), sub);
    return c && c.revokedAt === null ? c : null;
  };
  const revoked = {
    error: 'Unauthorized',
    message: 'Your portal access has been withdrawn.',
    statusCode: 401,
  };

  app.get(
    '/portal/editions/:editionId/report',
    {
      preHandler: [app.authenticateCoordinator],
      schema: { params: z.object({ editionId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const session = request.coordinatorSession;
      if (!(await activeCoordinator(session.sub))) return reply.status(401).send(revoked);
      const report = await getReleasedFirmReport(
        getPool(),
        request.params.editionId,
        session.organizationId,
      );
      return reply.send(report ? { released: true, report } : { released: false, report: null });
    },
  );

  app.get(
    '/portal/editions/:editionId/report/pdf',
    {
      preHandler: [app.authenticateCoordinator],
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: { params: z.object({ editionId: z.string().uuid() }) },
    },
    async (request, reply) => {
      const session = request.coordinatorSession;
      const coordinator = await activeCoordinator(session.sub);
      if (!coordinator) return reply.status(401).send(revoked);
      const { editionId } = request.params;
      const firmId = session.organizationId;
      const report = await getReleasedFirmReport(getPool(), editionId, firmId);
      if (!report) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Your firm report has not been released yet.',
          statusCode: 404,
        });
      }
      const pdf = await renderReportPdf(
        `/print/firm?edition=${editionId}&firm=${firmId}&audience=firm`,
        {
          storageKey: 'cis.portal.session',
          value: {
            token: (request.headers.authorization ?? '').replace(/^Bearer\s+/i, ''),
            coordinator: {
              id: coordinator.id,
              organizationId: coordinator.organizationId,
              name: coordinator.name,
              email: coordinator.email,
              isLead: coordinator.isLead,
            },
          },
        },
      );
      return reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `attachment; filename="CIS-Dragnet-Firm-Report-${filename(report.firm.name)}-${report.edition.label}.pdf"`,
        )
        .send(pdf);
    },
  );

  // ── The public Industry report ─────────────────────────────────────────────
  app.get('/public/industry-reports', async (_request, reply) => {
    const reports = await listPublishedIndustryReports(getPool());
    return reply.send({ reports });
  });

  app.get(
    '/public/editions/:id/industry-report',
    {
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const report = await getPublishedIndustryReport(getPool(), request.params.id);
      return reply.send(report);
    },
  );

  // Rendered once per published narrative, then served from memory: a public
  // download never starts a browser per request.
  const pdfCache = new Map<string, Promise<Buffer>>();
  const publicPdf = async (editionId: string, document: 'industry' | 'institutional') => {
    const pool = getPool();
    const report = await getPublishedIndustryReport(pool, editionId);
    const narrative = await getIndustryNarrative(pool, editionId);
    const key = `${document}:${editionId}:${narrative?.id ?? 'none'}`;
    let pdf = pdfCache.get(key);
    if (!pdf) {
      pdf = renderReportPdf(`/print/${document}?edition=${editionId}&audience=public`, null);
      pdfCache.set(key, pdf);
      pdf.catch(() => pdfCache.delete(key));
    }
    return { label: report.edition.label, pdf: await pdf };
  };

  app.get(
    '/public/editions/:id/institutional-report/pdf',
    {
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const { label, pdf } = await publicPdf(request.params.id, 'institutional');
      return reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `attachment; filename="CIS-Dragnet-Institutional-Perspectives-${label}.pdf"`,
        )
        .send(pdf);
    },
  );

  app.get(
    '/public/editions/:id/industry-report/pdf',
    {
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (request, reply) => {
      const { label, pdf } = await publicPdf(request.params.id, 'industry');
      return reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `attachment; filename="CIS-Dragnet-Industry-Report-${label}.pdf"`,
        )
        .send(pdf);
    },
  );
};
