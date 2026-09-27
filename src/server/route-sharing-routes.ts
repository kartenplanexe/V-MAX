import type { FastifyInstance } from 'fastify';
import type { PlanningView } from '../shared/planning-form.js';
import { PlanningSessionError } from './planning-sessions.js';
import type { PlanningAuthenticator } from './planning-routes.js';
import type { RouteSharing } from './route-sharing.js';

export function registerSharingRoutes(app: FastifyInstance, sharing: RouteSharing, authenticate: PlanningAuthenticator,
  onImported?: (owner: string, view: PlanningView) => Promise<void>) {
  for (const [suffix, method] of [['', 'create'], ['/resolve', 'resolve'], ['/import', 'import'], ['/revoke', 'revoke']] as const) {
    app.post(`/api/planning/shares${suffix}`, { bodyLimit: 24 * 1024 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const owner = authenticate(request);
      if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      try {
        const value = await sharing[method](owner, request.body);
        if (method === 'import') {
          try { await onImported?.(owner, value as PlanningView); }
          catch { request.log.warn({ action: 'shared_import' }, 'Imported route index could not be refreshed'); }
        }
        return value;
      } catch (error) {
        if (error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
        return reply.code(500).send({ error: 'INTERNAL_ERROR' });
      }
    });
  }
}
