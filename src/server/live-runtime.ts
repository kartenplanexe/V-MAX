import type { FastifyInstance } from 'fastify';
import { loadDatabaseCa, requireDatabaseTls } from './database-tls.js';
import { z } from 'zod';
import { config } from './config.js';
import { PlanningDatabase } from './planning-database.js';
import { DurablePlanning } from './durable-planning.js';
import { LiveGeography, LocalityTokens } from './live-geography.js';
import { YandexIntentClient } from './yandex-intent.js';
import { DgisClient } from './dgis.js';
import { planPlacesWithDgis, safePlanningDiagnostic } from './place-planning.js';
import { maxPlanningAuthenticator, registerPlanningRoutes } from './planning-routes.js';
import { registerInitialRequestRoutes } from './initial-requests.js';
import { InitialIntentError } from './intent-start.js';
import { PlanningSessionError } from './planning-sessions.js';
import { databaseStartupDiagnostic } from './database-startup-diagnostic.js';
import { MaxApiTransport, registerMaxChatRoute, routeTitle } from './max-chat.js';
import { selectPublicMapglKey } from './public-config.js';

export async function registerLiveRuntime(app: FastifyInstance) {
  const authenticate = maxPlanningAuthenticator(config.maxBotToken, config.initDataTtlSeconds);
  const missing = [!config.databaseUrl && 'DATABASE_URL', !config.yandexApiKey && 'YANDEX_API_KEY',
    !config.yandexFolderId && 'YANDEX_FOLDER_ID', !config.maxBotToken && 'MAX_BOT_TOKEN',
    !config.dgisPlacesApiKey && 'DGIS_PLACES_API_KEY', !config.dgisRoutingApiKey && 'DGIS_ROUTING_API_KEY'].filter(Boolean);
  if (missing.length) {
    app.log.warn({ missing }, 'Live planner configuration incomplete');
    app.get('/api/planning/bootstrap', async (_req, reply) => reply.code(503).send({ error: 'PLANNER_NOT_CONFIGURED' }));
    return;
  }
  const database = PlanningDatabase.connect(config.databaseUrl, await loadDatabaseCa({
    pem: config.databaseCaPem, path: config.databaseCaPath,
    required: requireDatabaseTls(config.isProduction, config.databaseAllowLocalPlaintext, config.databaseUrl),
  }));
  // Only additive schema changes. A DB error prevents startup; never fall back to in-memory state.
  let phase: 'migration' | 'cleanup' = 'migration';
  try {
    await database.migrate();
    phase = 'cleanup';
    await database.purge();
  } catch (error) {
    app.log.error({ phase, ...databaseStartupDiagnostic(error) }, 'Planning database initialization failed');
    await database.pool.end();
    throw new Error('Planning database initialization failed');
  }
  const purge = setInterval(() => { void database.purge().catch(() => app.log.warn('Planning expiry cleanup failed')); }, 60_000);
  purge.unref();
  app.addHook('onClose', async () => { clearInterval(purge); await database.pool.end(); });
  const geography = new LiveGeography(config.dgisPlacesApiKey, new LocalityTokens(config.maxBotToken), fetch,
    config.dgisBackupApiKey);
  const client = new DgisClient({ placesApiKey: config.dgisPlacesApiKey, routingApiKey: config.dgisRoutingApiKey,
    backupApiKey: config.dgisBackupApiKey });
  const planning = new DurablePlanning({ database, context: token => geography.context(token),
    // Per-call bounds prevent a runaway transport loop; there is no daily usage quota.
    provider: request => new YandexIntentClient({ apiKey: config.yandexApiKey, folderId: config.yandexFolderId,
      maxCalls: 1, maxEstimatedRub: 7.38 }).generate(request),
    plan: async job => {
      // The current 2GIS key rejects page_size=20 (meta.code=400, paramIsOutsideSet).
      // page_size=5 is verified by the live Places smoke test; five pages preserve a 25-item window.
      const result = await planPlacesWithDgis(client, job, { retrieval: { radiusMeters: 5000, pageSize: 5, maxPages: 5, maxRequests: 30 },
        maxRoutingHttpCalls: 30, maxRoutePairs: 200, dataMode: 'live' });
      if (result.status !== 'AVAILABLE') app.log.warn(safePlanningDiagnostic(result), 'Planning outcome summary');
      return result;
    },
  });
  registerPlanningRoutes(app, planning, authenticate, async (owner, view) => {
    await database.withNavigation(owner, async (state, save) => {
      const route = state.routes.find(item => item.draftId === view.id);
      if (!route) return;
      route.title = routeTitle(view);
      route.status = view.result ? 'planned' : 'draft';
      await save();
    });
  });
  registerInitialRequestRoutes(app, planning, authenticate);
  registerMaxChatRoute(app, { database, geography, planning,
    transport: new MaxApiTransport(config.maxBotToken), botUsername: config.maxBotUsername,
    mapEnabled: Boolean(selectPublicMapglKey({ isProduction: config.isProduction,
      mapglApiKey: config.dgisMapglApiKey, placesApiKey: config.dgisPlacesApiKey,
      routingApiKey: config.dgisRoutingApiKey })) }, config.maxBotToken);
  app.get('/api/planning/bootstrap', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = authenticate(req); if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    try {
      const navigation = await database.withNavigation(owner, async state => structuredClone(state));
      const active = navigation.mode === 'planning'
        ? navigation.routes.find(route => route.id === navigation.activeRouteId) : null;
      if (!active) return { view: null };
      try { return { view: await planning.get(owner, active.draftId) }; }
      catch (error) {
        if (error instanceof PlanningSessionError && error.code === 'DRAFT_NOT_FOUND')
          return { view: null, expiredRoute: active.title };
        throw error;
      }
    } catch { return reply.code(503).send({ error: 'PLANNER_BUSY' }); }
  });
  app.get('/api/planning/localities', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = authenticate(req); if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    const query = z.object({ q: z.string().trim().min(2).max(100) }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'LOCALITY_QUERY_REQUIRED' });
    try {
      return await database.withOwner(owner, async (_state, _save, db) => {
        await database.recordUsage(db, 'geography');
        return { choices: await geography.search(query.data.q) };
      });
    } catch (e) {
      if (e instanceof InitialIntentError || e instanceof PlanningSessionError) return reply.code(e.status).send({ error: e.code });
      return reply.code(503).send({ error: 'GEOGRAPHY_UNAVAILABLE' });
    }
  });
  app.post('/api/planning/addresses', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = authenticate(req); if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    const query = z.object({ draft_id: z.string().min(1).max(100), q: z.string().trim().min(4).max(120) }).safeParse(req.body);
    if (!query.success) return reply.code(400).send({ error: 'ADDRESS_QUERY_REQUIRED' });
    try {
      const view = await planning.get(owner, query.data.draft_id);
      return await database.withOwner(owner, async (_state, _save, db) => {
        await database.recordUsage(db, 'geography');
        return { choices: await geography.searchAddress(query.data.q, view.draft.locality.id) };
      });
    } catch (e) {
      if (e instanceof InitialIntentError || e instanceof PlanningSessionError) return reply.code(e.status).send({ error: e.code });
      return reply.code(503).send({ error: 'GEOGRAPHY_UNAVAILABLE' });
    }
  });
}
