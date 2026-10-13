import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { registerSecurity } from './plugins/security';
import { registerAuth } from './plugins/auth-plugin';
import { parseTrustProxy } from './plugins/trust-proxy';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { editionRoutes } from './routes/editions';
import { instrumentRoutes } from './routes/instruments';
import { journeyRoutes } from './routes/journeys';
import { firmTeamRoutes } from './routes/firm-team';
import { firmCoordinatorAuthRoutes } from './routes/firm-coordinator-auth';
import { firmCoordinatorPortalRoutes } from './routes/firm-coordinator-portal';
import { firmSeatEntryRoutes } from './routes/firm-seat-entry';
import { outreachEntryRoutes } from './routes/outreach-entry';
import { governedContentRoutes } from './routes/governed-content';
import { firmPortalRoutes } from './routes/firm-portal';
import { reportingRoutes } from './routes/reporting';
import { scoringRoutes } from './routes/scoring';
import { peopleRoutes } from './routes/people';
import { invitationsRoutes } from './routes/invitations';
import { missionBoardRoutes } from './routes/mission-board';
import { regulatorRoutes } from './routes/regulators';
import { institutionRoutes } from './routes/institutions';
import { monitoringRoutes } from './routes/monitoring';
import { firmResultsRoutes } from './routes/firm-results';
import { managedContentRoutes } from './routes/managed-content';
import { dragnetRoutes } from './routes/dragnet';
import { firmDigestRoutes } from './routes/firm-digest';
import { publicContentRoutes } from './routes/public-content';
import { reportDeliveryRoutes } from './routes/report-delivery';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
        ],
        censor: '[REDACTED]',
      },
    },
    disableRequestLogging: process.env['NODE_ENV'] === 'test',
    // Behind a reverse proxy, request.ip — and so every per-IP rate limit —
    // must come from X-Forwarded-For, or all clients share the proxy's IP.
    trustProxy: parseTrustProxy(process.env['TRUST_PROXY']),
  });

  // Register Zod as the schema compiler for the entire server
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Fastify resolves each route's error handler from its own plugin
  // encapsulation context at REGISTRATION time, not dynamically per request —
  // a handler set on the root instance after a child plugin has already
  // registered its routes never applies to those routes. This must be set
  // before any `app.register(...routes)` call below, or every route falls
  // back to Fastify's built-in default error response instead of this one.
  app.setErrorHandler<Error>((error, request, reply) => {
    const statusCode = resolveStatusCode(error);
    const message = statusCode < 500 ? error.message : 'Internal server error';
    if (statusCode >= 500) {
      request.log.error(error);
    }
    void reply.status(statusCode).send({
      error: error.name ?? 'Error',
      message,
      statusCode,
    });
  });

  await registerSecurity(app);
  await registerAuth(app);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(editionRoutes);
  await app.register(instrumentRoutes);
  await app.register(journeyRoutes);
  await app.register(firmTeamRoutes);
  await app.register(firmCoordinatorAuthRoutes);
  await app.register(firmCoordinatorPortalRoutes);
  await app.register(firmSeatEntryRoutes);
  await app.register(outreachEntryRoutes);
  await app.register(governedContentRoutes);
  await app.register(firmPortalRoutes);
  await app.register(reportingRoutes);
  await app.register(scoringRoutes);
  await app.register(peopleRoutes);
  await app.register(invitationsRoutes);
  await app.register(missionBoardRoutes);
  await app.register(regulatorRoutes);
  await app.register(institutionRoutes);
  await app.register(monitoringRoutes);
  await app.register(firmResultsRoutes);
  await app.register(managedContentRoutes);
  await app.register(dragnetRoutes);
  await app.register(firmDigestRoutes);
  await app.register(publicContentRoutes);
  await app.register(reportDeliveryRoutes);

  return app;
}

/**
 * Map known error types to HTTP status codes. Domain rule violations and
 * auth/maker-checker errors become 4xx; everything unrecognized is 500. The
 * name switch runs FIRST: Fastify assigns every thrown error a default
 * `statusCode` of 500 before this handler ever sees it, so checking
 * `error.statusCode` first would always short-circuit to 500 for a thrown
 * domain error and never reach the switch below. `error.statusCode` is
 * checked only as a fallback, for errors Fastify itself classifies with a
 * genuine non-default code (e.g. a schema validation failure, 400) that
 * carry no name this switch recognizes.
 */
function resolveStatusCode(error: Error & { statusCode?: number }): number {
  switch (error.name) {
    // The AI model or the PDF renderer failed — a dependency, not the caller. Not
    // a 5xx: the handler hides 5xx messages, and these say what to fix.
    case 'ReportNarrativeError':
    case 'ReportPdfError':
      return 424;
    case 'InvalidCoordinatorCredentialsError':
      return 401;
    case 'SeatLinkNotFoundError':
    case 'ReportContentError':
    case 'OutreachLinkNotFoundError':
      return 404;
    case 'PermissionDeniedError':
    case 'MakerCheckerViolationError':
      return 403;
    case 'InvalidReasonError':
    case 'ResponseScopeError':
    case 'ReviewGapError':
    case 'FirmPortalError':
    case 'SignoffPayloadError':
      return 400;
    case 'ConsentRequiredError':
    case 'PinVerificationError':
    case 'PrivacyConsentRequiredError':
    case 'FirmResultsAccessError':
    case 'ManagedContentPermissionError':
    case 'DragnetPermissionError':
    case 'ParticipationClosedError':
    case 'CollectionClosedError':
    case 'RegulatorLinkRequiredError':
      return 403;
    case 'EditionStateError':
    case 'InstrumentsNotFrozenError':
    case 'CriticalActionStateError':
    case 'CandidateScoringError':
    case 'FirmTeamError':
    case 'AlreadyClaimedError':
    case 'SeatConflictError':
    case 'NationalReportError':
    case 'FirmReportError':
    case 'ScoringSignoffError':
    case 'ScoringBlockedError':
    case 'PeopleAccessError':
    case 'InvitationsError':
    case 'RegulatorEngagementError':
    case 'ReminderTimingError':
    case 'FirmResultsError':
    case 'ManagedContentError':
    case 'InvestorCategoriesError':
    case 'FirmDigestError':
    case 'ReportPublicationError':
    case 'DomainError':
      return 409;
    default:
      return typeof error.statusCode === 'number' ? error.statusCode : 500;
  }
}
