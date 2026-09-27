import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PlanningSessionError } from './planning-sessions.js';
import type { PlanningView } from '../shared/planning-form.js';
import type { SavedConditionsView } from '../shared/saved-conditions.js';
import type { AlternativePreview } from '../shared/route-alternatives.js';
import type { ManualChoices } from '../shared/manual-planning.js';
export interface PlanningService {
  get(owner: string, id: string): PlanningView | Promise<PlanningView>;
  activityOptions?(owner: string, id: string): ManualChoices | Promise<ManualChoices>;
  edit(owner: string, id: string, input: unknown): PlanningView | Promise<PlanningView>;
  confirm(owner: string, id: string, input: unknown): PlanningView | Promise<PlanningView>;
  calculate(owner: string, id: string, input: unknown): Promise<PlanningView>;
  getSaved?(owner: string, id: string): SavedConditionsView | Promise<SavedConditionsView>;
  restore?(owner: string, id: string, input: unknown): Promise<PlanningView>;
  previewAlternative?(owner: string, id: string, input: unknown): Promise<AlternativePreview>;
  applyAlternative?(owner: string, id: string, input: unknown): PlanningView | Promise<PlanningView>;
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
  authenticate: PlanningAuthenticator, onChanged?: (owner: string, view: PlanningView) => Promise<void>) {
  if (sessions.activityOptions) app.get<{ Params: { id: string } }>('/api/planning/drafts/:id/activity-options', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = authenticate(request);
    if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    try { return await sessions.activityOptions!(owner, request.params.id); }
    catch (error) {
      if (error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
      return reply.code(500).send({ error: 'INTERNAL_ERROR' });
    }
  });
  if (sessions.previewAlternative && sessions.applyAlternative) {
    for (const action of ['previewAlternative', 'applyAlternative'] as const) {
      app.post<{ Params: { id: string } }>(`/api/planning/drafts/:id/alternatives/${action === 'previewAlternative' ? 'preview' : 'apply'}`,
        { bodyLimit: 32 * 1024 }, async (request, reply) => {
          reply.header('Cache-Control', 'no-store');
          const owner = authenticate(request);
          if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
          try {
            await sessions.get(owner, request.params.id);
            if (action === 'previewAlternative') return await sessions.previewAlternative!(owner, request.params.id, request.body);
            const view = await sessions.applyAlternative!(owner, request.params.id, request.body);
            try { await onChanged?.(owner, view); }
            catch { request.log.warn({ action }, 'Bot route index could not be refreshed'); }
            return view;
          } catch (error) {
            if (error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
            return reply.code(500).send({ error: 'INTERNAL_ERROR' });
          }
        });
    }
  }
  if (sessions.getSaved && sessions.restore) for (const [method, suffix] of [['GET', ''], ['POST', '/restore']] as const) {
    app.route<{ Params: { id: string } }>({ method, url: `/api/planning/saved/:id${suffix}`, bodyLimit: 32 * 1024,
      async handler(request, reply) {
        reply.header('Cache-Control', 'no-store');
        const owner = authenticate(request);
        if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
        try {
          const saved = await sessions.getSaved!(owner, request.params.id);
          if (method === 'GET') return saved;
          const view = await sessions.restore!(owner, request.params.id, request.body);
          try { await onChanged?.(owner, view); }
          catch { request.log.warn({ action: 'restore' }, 'Bot route index could not be refreshed'); }
          return view;
        } catch (error) {
          if (error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
          return reply.code(500).send({ error: 'INTERNAL_ERROR' });
        }
      },
    });
  }
  for (const [method, suffix, action] of [
    ['GET', '', 'get'], ['PATCH', '', 'edit'], ['POST', '/confirm', 'confirm'], ['POST', '/plan', 'calculate'],
  ] as const) {
    app.route<{ Params: { id: string } }>({ method, url: `/api/planning/drafts/:id${suffix}`, bodyLimit: 64 * 1024,
      async handler(request, reply) {
        reply.header('Cache-Control', 'no-store');
        const owner = authenticate(request);
        if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
        try {
          // Check ownership before inspecting the action body, even for malformed actions.
          await sessions.get(owner, request.params.id);
          const view = action === 'get' ? await sessions.get(owner, request.params.id)
            : await sessions[action](owner, request.params.id, request.body);
          if (action === 'edit' || action === 'calculate') {
            try { await onChanged?.(owner, view); }
            catch { request.log.warn({ action }, 'Bot route index could not be refreshed'); }
          }
          return view;
        } catch (error) {
          if (error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
          return reply.code(500).send({ error: 'INTERNAL_ERROR' });
        }
      },
    });
  }
}
