import type { FastifyInstance } from 'fastify';
import type { PlanningView } from '../shared/planning-form.js';
import { PlanningSessionError } from './planning-sessions.js';
import type { PlanningAuthenticator } from './planning-routes.js';
import type { DurableEventPlanning } from './durable-event-planning.js';

export function registerEventPlanningRoutes(app: FastifyInstance, events: DurableEventPlanning, authenticate: PlanningAuthenticator,
  onChanged?: (owner: string, view: PlanningView) => Promise<void>) {
  for (const method of ['search', 'availability', 'select', 'recheck'] as const) {
    app.post<{ Params: { id: string } }>(`/api/planning/drafts/:id/events/${method}`, { bodyLimit: 24 * 1024 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const owner = authenticate(request);
      if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      try {
        const value = await events[method](owner, request.params.id, request.body);
        if (method === 'select' || method === 'recheck') {
          try { await onChanged?.(owner, value as PlanningView); }
          catch { request.log.warn({ action: 'event_selection' }, 'Route index could not be refreshed'); }
        }
        return value;
      } catch (error) {
        if (error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
        return reply.code(500).send({ error: 'INTERNAL_ERROR' });
      }
    });
  }
}
