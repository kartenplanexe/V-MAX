import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PlanningSessionError } from './planning-sessions.js';
import type { PlanningView } from '../shared/planning-form.js';
export interface PlanningService {
  get(owner: string, id: string): PlanningView | Promise<PlanningView>;
  edit(owner: string, id: string, input: unknown): PlanningView | Promise<PlanningView>;
  confirm(owner: string, id: string, input: unknown): PlanningView | Promise<PlanningView>;
  calculate(owner: string, id: string, input: unknown): Promise<PlanningView>;
}
import { validateMaxInitData } from './max-init-data.js';

export type PlanningAuthenticator = (request: FastifyRequest) => string | null;

/** Derive ownership from verified initData, never from a client user_id. */
export function maxPlanningAuthenticator(botToken: string, maxAgeSeconds: number,
  nowSeconds?: () => number): PlanningAuthenticator {
  return request => {
    const auth = request.headers.authorization;
    if (!botToken || !auth?.startsWith('max ')) return null;
    const result = validateMaxInitData(auth.slice(4), botToken, { maxAgeSeconds, nowSeconds: nowSeconds?.() });
    return result.ok ? `max:${result.user.id}` : null;
  };
}

/** Production injects the PostgreSQL-backed coordinator; ownership is always checked server-side. */
export function registerPlanningRoutes(app: FastifyInstance, sessions: PlanningService,
  authenticate: PlanningAuthenticator) {
  for (const [method, suffix, action] of [
    ['GET', '', 'get'], ['PATCH', '', 'edit'], ['POST', '/confirm', 'confirm'], ['POST', '/plan', 'calculate'],
  ] as const) {
    app.route<{ Params: { id: string } }>({ method, url: `/api/planning/drafts/:id${suffix}`, bodyLimit: 32 * 1024,
      async handler(request, reply) {
        reply.header('Cache-Control', 'no-store');
        const owner = authenticate(request);
        if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
        try {
          // Check ownership before inspecting the action body, even for malformed actions.
          await sessions.get(owner, request.params.id);
          return action === 'get' ? await sessions.get(owner, request.params.id)
            : await sessions[action](owner, request.params.id, request.body);
        } catch (error) {
          if (error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
          return reply.code(500).send({ error: 'INTERNAL_ERROR' });
        }
      },
    });
  }
}
