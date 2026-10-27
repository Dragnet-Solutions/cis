import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { getEditionById, getPool } from '@cis/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `/editions/:id…` and `/public/editions/:id…`: the `:id` is an edition. */
const EDITION_ID_ROUTE = /(^|\/)editions\/:id(\/|$)/;

/** The edition a route is about, by its URL pattern, if it names one. */
export function editionParamName(url: string): 'editionId' | 'id' | null {
  if (url.includes(':editionId')) return 'editionId';
  if (EDITION_ID_ROUTE.test(url)) return 'id';
  return null;
}

/**
 * An edition-scoped route answers 404 for an edition that does not exist,
 * instead of 200 with empty data (BUG-07). The check is appended to each such
 * route's own preHandlers, so it runs after sign-in: someone not signed in
 * still gets 401, never a hint whether an edition exists. A malformed id is
 * left to the route's own schema (400).
 *
 * Must be registered before the routes it covers.
 */
export function registerEditionExists(app: FastifyInstance): void {
  app.addHook('onRoute', (route: RouteOptions) => {
    const param = editionParamName(route.url);
    if (!param) return;
    const check = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const id = (request.params as Record<string, unknown> | undefined)?.[param];
      if (typeof id !== 'string' || !UUID_RE.test(id)) return;
      if (await getEditionById(getPool(), id)) return;
      await reply
        .status(404)
        .send({ error: 'NotFound', message: 'That edition was not found', statusCode: 404 });
    };
    const own = route.preHandler;
    route.preHandler = own ? [...(Array.isArray(own) ? own : [own]), check] : [check];
  });
}
