import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ManualOptionsInput, ManualRequestInput, type ManualRequest } from '../shared/manual-planning.js';
import { FormDraft, type PlanningView } from '../shared/planning-form.js';
import { InitialIntentError, type InitialContext } from './intent-start.js';
import { PlanningSessions, PlanningSessionError, type PlanningContext } from './planning-sessions.js';
import { PlanningDatabase } from './planning-database.js';
import { projectSavedConditions } from './saved-conditions.js';
import { catalogActivity, choicesFromCatalog } from './activity-choices.js';
import type { PlanningAuthenticator } from './planning-routes.js';

type Context = InitialContext & { planning: PlanningContext };
function reject(code: string, status = 422): never { throw new PlanningSessionError(code, status); }
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value); if (!result.success) reject('INVALID_MANUAL_REQUEST', 400); return result.data;
}
const noPlan = async (): Promise<never> => reject('MANUAL_CANNOT_CALCULATE', 500);
export function manualOptions(context: Context) {
  if (!context.catalog.complete || context.catalog.region_id !== context.locality.region_id ||
      context.planning.catalog.region_id !== context.locality.region_id || context.catalog.version !== context.planning.catalog.version)
    reject('CATALOG_UNAVAILABLE', 503);
  return choicesFromCatalog({ ...context.planning, catalog: { ...context.planning.catalog,
    category_names: Object.fromEntries(context.catalog.rows.map(([id, name]) => [id, name])) } }, context.locality.name);
}
export function manualSeed(raw: unknown, context: Context) {
  const input = parse(ManualRequestInput, raw), options = manualOptions(context);
  if (input.catalog_version !== options.catalog_version) reject('MANUAL_CATALOG_CHANGED');
  if (!options.modes.includes(input.mobility)) reject('TRANSPORT_REQUIRED');
  const provenance: Record<string, string> = { locality: 'user_form', 'shared.mobility': 'user_form' };
  const days = input.days.map((day, dayIndex) => {
    const day_id = `day-${dayIndex + 1}`;
    for (const field of ['date', 'window.start', 'window.end', 'activities', 'order']) provenance[`days.${day_id}.${field}`] = 'user_form';
    const activities = day.activities.map((activity, activityIndex) => {
      if (activity.kind === 'walk' && input.mobility !== 'walking') reject('WALK_ROUTE_REQUIRES_WALKING');
      return catalogActivity(activity, `${day_id}-activity-${activityIndex + 1}`, context.planning, options, reject);
    });
    return { day_id, date: day.date, window: { start: day.start, end: day.end }, activities,
      order: day.ordered ? activities.slice(1).map((activity, index) => [activities[index]!.id, activity.id]) : [] };
  });
  return { seed: FormDraft.parse({ locality: context.locality, shared: { mobility: [input.mobility] }, points: {}, days }), provenance };
}

/** Optional-parser entry point. No LLM client is accepted or reachable here. */
export class ManualPlanning {
  constructor(readonly options: { database: PlanningDatabase; context: (token: string) => Promise<Context> }) {}
  async choices(owner: string, raw: unknown) {
    const input = parse(ManualOptionsInput, raw), database = this.options.database;
    return database.withOwner(owner, async (_state, _save, client) => database.withSlot(client, 'intent', async () => {
      await database.recordUsage(client, 'geography');
      return manualOptions(await this.options.context(input.locality_token));
    }));
  }
  async start(owner: string, raw: unknown): Promise<PlanningView> {
    const input = parse(ManualRequestInput, raw), database = this.options.database;
    const key = `manual:${input.event_id}`, hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return database.withOwner(owner, async (state, save, client) => {
      const sessions = new PlanningSessions({ checkpoint: state.checkpoint, now: database.now, plan: noPlan });
      state.checkpoint = sessions.checkpoint();
      const old = state.receipts[key];
      if (old) {
        if (old.hash !== hash) reject('EVENT_CONFLICT', 409);
        if (old.status === 'pending') reject('MANUAL_INTERRUPTED', 503);
        if (old.status === 'failed') reject(old.error ?? 'MANUAL_CREATION_FAILED', old.errorStatus ?? 503);
        return sessions.get(owner, old.draftId!);
      }
      state.receipts[key] = { hash, status: 'pending', at: database.now().getTime() };
      await save();
      const previous = state.checkpoint;
      try {
        const context = await database.withSlot(client, 'intent', async () => {
          await database.recordUsage(client, 'geography'); return this.options.context(input.locality_token);
        });
        const { seed, provenance } = manualSeed(input, context);
        const view = sessions.create(owner, seed, context.planning, provenance);
        state.checkpoint = sessions.checkpoint();
        state.receipts[key] = { hash, status: 'done', at: database.now().getTime(), draftId: view.id };
        await database.transaction(client, async () => {
          await save(); await database.saveSaved(client, owner, { id: view.id, revision: view.version,
            expires_at: new Date(database.now().getTime() + 30 * 86400000).toISOString(),
            conditions: projectSavedConditions(view, { now: database.now() }) });
        });
        return view;
      } catch (error) {
        state.checkpoint = previous;
        const failure = error instanceof InitialIntentError || error instanceof PlanningSessionError
          ? error : new PlanningSessionError('MANUAL_CREATION_FAILED', 503);
        state.receipts[key] = { hash, at: database.now().getTime(), status: 'failed', error: failure.code, errorStatus: failure.status };
        await save(); throw failure;
      }
    });
  }
}
export function registerManualPlanning(app: FastifyInstance, manual: ManualPlanning, authenticate: PlanningAuthenticator,
  onCreated?: (owner: string, view: PlanningView) => Promise<void>) {
  for (const [suffix, method] of [['options', 'choices'], ['requests', 'start']] as const) {
    app.post(`/api/planning/manual/${suffix}`, { bodyLimit: 32 * 1024 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const owner = authenticate(request); if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
      try {
        const value = await manual[method](owner, request.body);
        if (method === 'start') {
          try { await onCreated?.(owner, value as PlanningView); }
          catch { request.log.warn({ action: 'manual_create' }, 'Created route index could not be refreshed'); }
        }
        return value;
      } catch (error) {
        if (error instanceof InitialIntentError || error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
        return reply.code(503).send({ error: 'MANUAL_CREATION_FAILED' });
      }
    });
  }
}
