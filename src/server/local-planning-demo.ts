import Fastify from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { PlanningSessions } from './planning-sessions.js';
import { registerPlanningRoutes } from './planning-routes.js';
import { planPlacesWithDgis } from './place-planning.js';
import { demoNow, planningFixture } from './place-planning.fixture.js';
import { intentFixture } from './intent-start.fixture.js';
import { InitialIntentError } from './intent-start.js';
import { InitialRequests, registerInitialRequestRoutes } from './initial-requests.js';
import type { PlanningAuthenticator } from './planning-routes.js';

/** Offline, loopback-only UI harness. Does NOT load .env or call external APIs. */
export function createLocalPlanningDemo() {
  if (process.env.NODE_ENV === 'production') throw new Error('Local demo is unavailable in production');
  const app = Fastify({ bodyLimit: 32 * 1024, logger: false });
  const origin = 'http://127.0.0.1:4174';
  const tokens = new Map<string, { owner: string; expires: number }>();
  const examples = [intentFixture(), intentFixture(3)];
  const evening = intentFixture();
  evening.text = 'Завтра вечером хочу в музей. Пешком.';
  evening.response.days[0]!.time_updates = [{ op: 'set', field: 'period', value: 'evening', evidence: 'вечером' }];
  evening.response.days[0]!.activity_edits.splice(1);
  evening.response.days[0]!.category_matches.splice(1);
  evening.response.days[0]!.order_changes = [];
  examples.push(evening);
  const sessions = new PlanningSessions({ plan: job => {
    const fixture = planningFixture();
    // The demo's opening hours cover every day; they are deliberately synthetic.
    for (const item of fixture.items) Object.assign(item.schedule, Object.fromEntries(
      ['Mon', 'Tue', 'Wed', 'Thu', 'Sat', 'Sun'].map(day => [day, structuredClone(item.schedule.Fri)])));
    return planPlacesWithDgis(fixture.client(), job, {
      retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test', now: demoNow,
    });
  }, now: () => new Date(demoNow().getTime() + (Date.now() - started)) });
  const started = Date.now();
  const authenticate: PlanningAuthenticator = request => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return null;
    const token = tokens.get(authorization.slice(7));
    return token && token.expires > Date.now() ? token.owner : null;
  };
  const initial = new InitialRequests({ sessions, now: () => new Date(demoNow().getTime() + Date.now() - started),
    context: () => { const fixture = planningFixture(); return { ...intentFixture().context,
      planning: { catalog: fixture.input.catalog, visit_policy: fixture.input.visit_policy, modes: ['walking', 'driving'], data_mode: 'test',
        point_area: { south: 55.7, north: 55.8, west: 37.5, east: 37.8 } } }; },
    provider: async request => {
      const messages = request.messages as { content: string }[];
      const text = JSON.parse(messages[1]!.content).user_text;
      const example = examples.find(e => e.text === text);
      if (!example) throw new InitialIntentError('OFFLINE_EXAMPLE_REQUIRED');
      return structuredClone(example.response);
    },
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== '127.0.0.1:4174' ||
        request.headers.origin && request.headers.origin !== origin ||
        !['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) {
      return reply.code(403).send({ error: 'LOCAL_ORIGIN_REQUIRED' });
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  app.post('/api/demo/session', async (_request, reply) => {
    for (const [key, token] of tokens) if (token.expires <= Date.now()) tokens.delete(key);
    if (tokens.size >= 100) return reply.code(429).send({ error: 'SESSION_CAPACITY' });
    const fixture = planningFixture(), owner = `demo:${randomUUID()}`, token = randomBytes(32).toString('base64url');
    fixture.input.intent.days[0]!.activities[0]!.label = 'Культура';
    fixture.input.intent.days[0]!.activities[1]!.label = 'Поесть в кафе';
    const seed = { ...fixture.input.intent, points: { origin: { ...fixture.input.intent.points.origin, label: 'Учебная точка старта', source: 'place_choice' } } };
    const view = sessions.create(owner, seed, { catalog: fixture.input.catalog, visit_policy: fixture.input.visit_policy,
      modes: ['walking', 'driving'], data_mode: 'test', point_area: { south: 55.7, north: 55.8, west: 37.5, east: 37.8 } });
    tokens.set(token, { owner, expires: Date.now() + 1_800_000 });
    return { token, view };
  });
  app.post('/api/demo/bootstrap', async (_request, reply) => {
    for (const [key, token] of tokens) if (token.expires <= Date.now()) tokens.delete(key);
    if (tokens.size >= 100) return reply.code(429).send({ error: 'SESSION_CAPACITY' });
    const owner = `demo:${randomUUID()}`, token = randomBytes(32).toString('base64url');
    tokens.set(token, { owner, expires: Date.now() + 1_800_000 });
    return { token, view: null, examples: examples.map(e => e.text), parser_mode: 'authored_replay' };
  });
  app.get('/api/public-config', async () => ({ maps: { enabled: false } }));
  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());
  registerPlanningRoutes(app, sessions, authenticate);
  registerInitialRequestRoutes(app, initial, authenticate);
  return app;
}
