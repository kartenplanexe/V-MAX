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
    // Yandex Serverless Containers strips Authorization before forwarding HTTP requests.
    const initData = request.headers['x-max-init-data'];
    if (!botToken || typeof initData !== 'string') {
      if (request.url === '/api/planning/bootstrap') {
        request.log.info({ reason: !botToken ? 'bot_token_unconfigured' : 'missing_launch_header' },
          'MAX planner launch validation failed');
      }
      return null;
    }
    const result = validateMaxInitData(initData, botToken, { maxAgeSeconds, nowSeconds: nowSeconds?.() });
    if (!result.ok && request.url === '/api/planning/bootstrap') {
      // A fixed reason enum is enough to diagnose failures; never log initData or its hash.
      request.log.warn({ reason: result.reason }, 'MAX planner launch validation failed');
    }
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
