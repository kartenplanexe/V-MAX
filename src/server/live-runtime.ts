import type { FastifyInstance } from 'fastify';
import { loadDatabaseCa, requireDatabaseTls } from './database-tls.js';
import { z } from 'zod';
import { config } from './config.js';
import { PlanningDatabase } from './planning-database.js';
import { DurablePlanning } from './durable-planning.js';
import { LiveGeography, LocalityTokens } from './live-geography.js';
import { YandexIntentClient } from './yandex-intent.js';
import { DgisClient } from './dgis.js';
import { planPlacesWithDgis } from './place-planning.js';
import { maxPlanningAuthenticator, registerPlanningRoutes } from './planning-routes.js';
import { registerInitialRequestRoutes } from './initial-requests.js';
import { InitialIntentError } from './intent-start.js';
import { PlanningSessionError } from './planning-sessions.js';

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
  try { await database.migrate(); await database.purge(); }
  catch { await database.pool.end(); throw new Error('Planning database initialization failed'); }
  const purge = setInterval(() => { void database.purge().catch(() => app.log.warn('Planning expiry cleanup failed')); }, 60_000);
  purge.unref();
  app.addHook('onClose', async () => { clearInterval(purge); await database.pool.end(); });
  const geography = new LiveGeography(config.dgisPlacesApiKey, new LocalityTokens(config.maxBotToken));
  const client = new DgisClient({ placesApiKey: config.dgisPlacesApiKey, routingApiKey: config.dgisRoutingApiKey });
  const planning = new DurablePlanning({ database, context: token => geography.context(token),
    // Per-call transport cap; the authoritative cross-instance daily cap lives in PostgreSQL.
    provider: request => new YandexIntentClient({ apiKey: config.yandexApiKey, folderId: config.yandexFolderId,
      maxCalls: 1, maxEstimatedRub: 7.38 }).generate(request),
    dailyIntentCalls: config.dailyIntentCalls, dailyPlanCalls: config.dailyPlanCalls,
    plan: job => planPlacesWithDgis(client, job, { retrieval: { radiusMeters: 5000, pageSize: 20, maxPages: 2, maxRequests: 20 },
      maxRoutingHttpCalls: 30, maxRoutePairs: 200, dataMode: 'live' }),
  });
  registerPlanningRoutes(app, planning, authenticate);
  registerInitialRequestRoutes(app, planning, authenticate);
  app.get('/api/planning/bootstrap', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = authenticate(req); if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    try { return { view: await planning.latest(owner) }; }
    catch { return reply.code(503).send({ error: 'PLANNER_BUSY' }); }
  });
  app.get('/api/planning/localities', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = authenticate(req); if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    const query = z.object({ q: z.string().trim().min(2).max(100) }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'LOCALITY_QUERY_REQUIRED' });
    try {
      return await database.withOwner(owner, async (state, save, db) => {
        const recent = Object.entries(state.receipts).filter(([key, r]) => key.startsWith('geo:') && Date.now() - r.at < 60_000);
        if (recent.length >= 10) throw new InitialIntentError('GEOGRAPHY_RATE_LIMIT', 429);
        const key = 'geo:' + Date.now(); state.receipts[key] = { status: 'done', hash: '', at: Date.now() }; await save();
        await database.reserve(db, 'geography', config.dailyGeographyCalls);
        return { choices: await geography.search(query.data.q) };
      });
    } catch (e) {
      if (e instanceof InitialIntentError || e instanceof PlanningSessionError) return reply.code(e.status).send({ error: e.code });
      return reply.code(503).send({ error: 'GEOGRAPHY_UNAVAILABLE' });
    }
  });
}
