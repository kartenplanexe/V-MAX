/** LOOPBACK UI QA ONLY. No env files, live identity, external providers or production auth bypass.
 * Planning edits/confirm/solve/replacement use the real coordinator and Python planner.
 * The parser, geography and volatile saved/share adapters are explicitly synthetic fixtures.
 * Run: npm run build:client && node --import tsx scripts/qa-ui-local.mts
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PlanningSessions, PlanningSessionError, type PlanningContext } from '../src/server/planning-sessions.js';
import { registerPlanningRoutes, type PlanningAuthenticator } from '../src/server/planning-routes.js';
import { registerInitialRequestRoutes } from '../src/server/initial-requests.js';
import { planningFixture } from '../src/server/place-planning.fixture.js';
import { planPlacesWithDgis } from '../src/server/place-planning.js';
import { manualOptions, manualSeed } from '../src/server/manual-planning.js';
import { intentFixture } from '../src/server/intent-start.fixture.js';
import { projectSavedConditions, remapSavedConditions } from '../src/server/saved-conditions.js';
import type { PlanningView } from '../src/shared/planning-form.js';
import type { SavedConditionsView } from '../src/shared/saved-conditions.js';
import { CreateShareInputSchema, ImportShareInputSchema, ResolveShareInputSchema, RevokeShareInputSchema } from '../src/shared/route-sharing.js';
import { registerQaEvents, resolveQaEvents } from './qa-events.fixture.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Synthetic UI harness must never run in production');
const host = '127.0.0.1', port = 4175, origin = `http://${host}:${port}`, app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
const fixture = planningFixture();
fixture.input.catalog.leaf_ids.push('300');
Object.assign(fixture.input.visit_policy.by_category, { '300': 25 });
Object.assign(fixture.input.visit_policy, { walkable_category_ids: ['300'], park_category_ids: ['300'] });
for (const [id, name, lat, lon] of [['park-a', 'Учебная набережная', 55.754, 37.624], ['park-b', 'Учебный сквер', 55.755, 37.625]] as const)
  fixture.items.push({ id, name, region_id: '32', rubrics: [{ id: '300' }], point: { lat, lon }, schedule: { Fri: { working_hours: [{ from: '00:00', to: '24:00' }] } } });
for (const item of fixture.items) Object.assign(item.schedule, Object.fromEntries(['Mon', 'Tue', 'Wed', 'Thu', 'Sat', 'Sun'].map(day => [day, structuredClone(item.schedule.Fri)])));
let clockOffsetMs = 0;
const qaNow = () => new Date(Date.now() + clockOffsetMs);
const planning: PlanningContext = { catalog: { ...fixture.input.catalog, category_names: { '100': 'Музеи', '200': 'Кафе', '300': 'Парки' } }, visit_policy: fixture.input.visit_policy,
  modes: ['walking', 'driving'], data_mode: 'test', point_area: { south: 55.7, north: 55.8, west: 37.5, east: 37.8 }, map_center: { lat: 55.75, lon: 37.62 } };
function context() { const value = intentFixture().context; value.catalog.rows.push(['300', 'Парки', []]); return { ...value, now: qaNow().toISOString(), planning }; }
let routingDenied = false;
const sessions = new PlanningSessions({ now: qaNow, plan: job => planPlacesWithDgis(fixture.client(async (url, init) => {
  if (routingDenied && new URL(String(url)).hostname === 'routing.api.2gis.com') return new Response('', { status: 429 });
  return fixture.defaultFetch(url, init);
}), job, { retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test', now: qaNow, resolveEvents: resolveQaEvents }) });
const active = new Map<string, string>(), saved = new Map<string, Map<string, SavedConditionsView>>(), expired = new Set<string>();
const authenticate: PlanningAuthenticator = request => {
  const value = request.headers['x-max-init-data'];
  return typeof value === 'string' && /^qa-synthetic:(initial|result|limited|three|saved|partial)(?:&start_param=share_[A-Za-z0-9_-]{43})?$/u.test(value) ? value.split('&')[0]! : null;
};
function remember(owner: string, view: PlanningView) {
  active.set(owner, view.id); const items = saved.get(owner) ?? new Map();
  items.set(view.id, { id: view.id, revision: view.version, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), conditions: projectSavedConditions(view, { queries: { locality: 'Учебный город' } }) }); saved.set(owner, items);
}
function tomorrow(offset = 1) { const day = new Date(); day.setUTCDate(day.getUTCDate() + offset); return day.toISOString().slice(0, 10); }
function seed(owner: string, kind: string, text?: string) {
  const walk = text?.toLowerCase().includes('погулять'), food = !walk || text?.toLowerCase().includes('поесть');
  const body = { event_id: randomUUID(), locality_token: 'qa-city', catalog_version: fixture.input.catalog.version, mobility: 'walking',
    days: Array.from({ length: kind === 'three' ? 3 : 1 }, (_, i) => ({ date: tomorrow(i + 1), start: '14:00', end: kind === 'limited' ? '15:30' : '19:00', ordered: true,
      activities: [...(walk ? [{ kind: 'walk' }] : [{ kind: 'place', category_ids: ['100'] }]), ...(food ? [{ kind: 'place', category_ids: ['200'] }] : [])] })) };
  const input = manualSeed(body, context());
  if (!text) {
    input.seed.points.origin = { lat: 55.75, lon: 37.62, locality_id: input.seed.locality.id, label: 'Учебная точка старта', source: 'user_map' };
    input.provenance['points.origin'] = 'user_map';
  }
  const seedDraft = kind === 'partial' ? { ...input.seed,
    clarifications: [{ id: 'question-1', field: 'budget', text: 'бюджет как обычно', reason: 'ambiguous', day_ids: [] }],
    days: input.seed.days.map(day => ({ ...day, activities: day.activities.map((activity, index) => index === 1 && activity.intent_kind !== 'event_visit'
      ? { ...activity, categories: { ...activity.categories, state: 'no_match', include_any: [] } } : activity) })) } : input.seed;
  const view = sessions.create(owner, seedDraft, planning, input.provenance); remember(owner, view); return view;
}
app.addHook('onRequest', async (request, reply) => {
  if (request.headers.host !== `${host}:${port}` || request.headers.origin && request.headers.origin !== origin || !['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin)
    return reply.code(403).send({ error: 'LOCAL_ORIGIN_REQUIRED' });
  if (request.url.startsWith('/api/planning/') && !authenticate(request)) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
});
app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff')
  .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"); });
app.setErrorHandler((error, _request, reply) => reply.code(error instanceof PlanningSessionError ? error.status : 400).send({ error: error instanceof PlanningSessionError ? error.code : 'QA_INPUT_INVALID' }));
app.get('/api/public-config', async () => ({ maps: { enabled: false } }));
// Fault control exists only in this loopback-only synthetic runner, never in
// the production app. Expiry still uses the real PlanningSessions clock/TTL.
app.post('/qa/clock/expire-drafts', async (request, reply) => {
  if (!authenticate(request)) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
  clockOffsetMs += 31 * 60_000;
  return { data_mode: 'test', clock_advanced_minutes: 31 };
});
app.post('/qa/routing', async (request, reply) => {
  if (!authenticate(request)) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
  const denied = (request.body as { denied?: unknown } | null)?.denied;
  if (typeof denied !== 'boolean') return reply.code(400).send({ error: 'QA_INPUT_INVALID' });
  routingDenied = denied;
  return { data_mode: 'test', routing_denied: routingDenied };
});
function currentView(owner: string, id: string) {
  if (expired.has(id)) return null;
  try { return sessions.get(owner, id); }
  catch (error) {
    if (!(error instanceof PlanningSessionError) || error.code !== 'DRAFT_NOT_FOUND') throw error;
    expired.add(id); return null;
  }
}
app.get('/api/planning/bootstrap', async request => {
  const owner = authenticate(request)!; let id = active.get(owner);
  if (!id && owner !== 'qa-synthetic:initial') {
    let view = seed(owner, owner.split(':')[1]!); id = view.id;
    if (owner.endsWith(':saved')) expired.add(id);
    else if (!owner.endsWith(':partial')) { view = sessions.confirm(owner, id, { base_version: view.version, event_id: randomUUID() }); view = await sessions.calculate(owner, id, { base_version: view.version, event_id: randomUUID() }); remember(owner, view); }
  }
  if (!id) return { view: null };
  const view = currentView(owner, id);
  return view ? { view } : { view: null, expiredRoute: 'Учебные сохранённые условия', saved: saved.get(owner)!.get(id) };
});
app.get('/api/planning/localities', async () => ({ choices: [{ name: 'Учебный город', token: 'qa-city' }] }));
app.post('/api/planning/addresses', async () => ({ choices: [{ id: 'qa-address', label: 'Учебная улица, 1', point: { lat: 55.75, lon: 37.62 } }] }));
registerInitialRequestRoutes(app, { start: async (owner, raw) => {
  const body = raw as { user_text: string; locality_token: string };
  if (body.locality_token !== 'qa-city' || typeof body.user_text !== 'string') throw new PlanningSessionError('INVALID_ACTION', 400);
  if (body.user_text.toLowerCase().includes('ошибка')) throw new PlanningSessionError('INTENT_PROVIDER_FAILED', 502);
  return { status: 'draft', view: seed(owner, 'initial', body.user_text) };
} }, authenticate);
app.post('/api/planning/manual/options', async () => manualOptions(context()));
app.post('/api/planning/manual/requests', async request => { const owner = authenticate(request)!; const value = manualSeed(request.body, context()); const view = sessions.create(owner, value.seed, planning, value.provenance); remember(owner, view); return view; });
const service = {
  activityOptions: sessions.activityOptions.bind(sessions),
  get: (owner: string, id: string) => sessions.get(owner, id), edit: sessions.edit.bind(sessions), confirm: sessions.confirm.bind(sessions), calculate: sessions.calculate.bind(sessions),
  previewAlternative: sessions.previewAlternative.bind(sessions), applyAlternative: sessions.applyAlternative.bind(sessions),
  getSaved: (owner: string, id: string) => { const value = saved.get(owner)?.get(id); if (!value) throw new PlanningSessionError('SAVED_CONDITIONS_NOT_FOUND', 404); return value; },
  restore: async (owner: string, id: string) => { const raw = saved.get(owner)?.get(id); if (!raw) throw new PlanningSessionError('SAVED_CONDITIONS_NOT_FOUND', 404);
    const mapped = remapSavedConditions(raw.conditions, context()); if (mapped.status !== 'RESTORABLE') throw new PlanningSessionError('SAVED_CATEGORY_RECONFIRM_REQUIRED', 422);
    const view = sessions.restoreDraft(owner, id, raw.revision + 1, mapped.draft, planning, mapped.provenance);
    expired.delete(id); remember(owner, view); return view; },
};
registerPlanningRoutes(app, service, authenticate, async (owner, view) => remember(owner, view));
registerQaEvents(app, sessions, authenticate, remember);
app.get('/api/planning/saved', async request => ({ items: [...(saved.get(authenticate(request)!)?.values() ?? [])].map(value => {
  const view = currentView(authenticate(request)!, value.id);
  return { id: value.id, title: value.conditions.days.map(day => day.activities.map(a => a.label).join(' → ')).join(' · '), revision: value.revision,
    updated_at: value.conditions.updated_at, expires_at: value.expires_at, active: active.get(authenticate(request)!) === value.id, can_open: !!view, has_fresh_result: !!view?.result };
}), next_cursor: null }));
app.post<{ Params: { id: string } }>('/api/planning/saved/:id/activate', async request => { const owner = authenticate(request)!, id = request.params.id; service.getSaved(owner, id); active.set(owner, id);
  const view = currentView(owner, id);
  return view ? { view } : { view: null, saved: service.getSaved(owner, id), expiredRoute: 'Учебный маршрут' }; });
const shares = new Map<string, { owner: string; share_id: string; preview: Record<string, unknown> }>();
app.post('/api/planning/shares', async request => { const input = CreateShareInputSchema.parse(request.body), owner = authenticate(request)!; const own = service.getSaved(owner, input.draft_id);
  if (own.conditions.clarifications?.length) throw new PlanningSessionError('SHARE_CLARIFICATION_REQUIRED', 422);
  const conditions = structuredClone(own.conditions), omissions: string[] = []; conditions.queries = {};
  if (!input.include_private_points) for (const field of ['origin', 'destination'] as const) if (conditions.points[field]) { delete conditions.points[field]; delete conditions.provenance[`points.${field}`]; omissions.push(field); }
  const token = randomBytes(32).toString('base64url'), share_id = randomUUID(), expires_at = new Date(Date.now() + 3600000).toISOString();
  shares.set(token, { owner, share_id, preview: { expires_at, conditions, omissions, result: null, result_expires_at: null } });
  return { token, share_id, expires_at, deep_link: `${origin}/?qa=initial&share=${token}` }; });
app.post('/api/planning/shares/resolve', async request => { const { token } = ResolveShareInputSchema.parse(request.body), value = shares.get(token); if (!value) throw new PlanningSessionError('SHARE_NOT_FOUND', 404); return value.preview; });
app.post('/api/planning/shares/revoke', async request => { const value = RevokeShareInputSchema.parse(request.body); for (const [key, share] of shares) if (share.owner === authenticate(request) && share.share_id === value.share_id) shares.delete(key); return { revoked: true }; });
app.post('/api/planning/shares/import', async request => { const input = ImportShareInputSchema.parse(request.body), value = shares.get(input.token); if (!value) throw new PlanningSessionError('SHARE_NOT_FOUND',404); const mapped = remapSavedConditions(value.preview.conditions as SavedConditionsView['conditions'], context()); if(mapped.status!=='RESTORABLE') throw new PlanningSessionError('SAVED_CATEGORY_RECONFIRM_REQUIRED',422); const owner=authenticate(request)!, view=sessions.create(owner,mapped.draft,planning,mapped.provenance); remember(owner,view); return view; });
const root = fileURLToPath(new URL('../dist/client/', import.meta.url));
app.post<{ Params: { id: string } }>('/api/planning/saved/:id/delete', async request => { const owner = authenticate(request)!, id = request.params.id; service.getSaved(owner, id); saved.get(owner)!.delete(id); if(active.get(owner)===id) active.delete(owner); return { deleted:true }; });
const html = async () => (await readFile(new URL('../dist/client/index.html', import.meta.url), 'utf8')).replace('https://st.max.ru/js/max-web-app.js', '/qa/bridge.js')
  .replace('<body>', '<body><aside style="padding:6px 14px;background:#332050;color:white;font:12px system-ui">Локальная QA · синтетические места и география · реальные формы и Python · без MAX/LLM/2ГИС</aside>');
app.get('/qa/bridge.js', async (_request, reply) => reply.type('application/javascript').send("const scene = new URLSearchParams(location.search).get('qa') || 'initial'; const share=new URLSearchParams(location.search).get('share'); window.WebApp = {initData:'qa-synthetic:'+scene+(share?'&start_param=share_'+share:''),platform:'web'};"));
await app.register(fastifyStatic, { root, index: false });
app.get('/', async (_request, reply) => reply.type('text/html').send(await html()));
app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());
await app.listen({ host, port });
console.log(`Synthetic UI QA only: ${origin}/?qa=initial (also result, limited, three, saved, partial). No real credentials/providers.`);
