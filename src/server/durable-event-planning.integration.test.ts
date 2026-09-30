import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { PlanningDatabase } from './planning-database.js';
import { PlanningSessions } from './planning-sessions.js';
import { DurableEventPlanning } from './durable-event-planning.js';
import { KudagoClient } from './kudago.js';
import { projectSavedConditions } from './saved-conditions.js';
import { registerEventPlanningRoutes } from './event-planning-routes.js';
import { DurablePlanning } from './durable-planning.js';
import { registerPlanningRoutes } from './planning-routes.js';
import { planningFixture } from './place-planning.fixture.js';
import { planPlacesWithDgis, safePlanningDiagnostic } from './place-planning.js';
import { createResolvePlanEvents } from './selected-event-retrieval.js';

const run = it.skipIf(!process.env.TEST_DATABASE_URL);
async function fixture(withFood = false, paid = false) {
  let time = Date.parse('2026-09-27T09:00:00Z'), calls = 0, providerFails = false;
  const owner = `synthetic-event-${randomUUID()}`;

  const schema = `events_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(process.env.TEST_DATABASE_URL!); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const database = PlanningDatabase.connect(scoped.href, undefined, { now: () => new Date(time) });
  await database.migrate(); await database.migrate();
  const venue = { id: 44, title: 'Synthetic venue title', site_url: 'https://nn.kudago.com/place/synthetic/',
    coords: { lat: 56.32, lon: 44 }, is_closed: false, timetable: 'ежедневно 10:00–20:00' };
  const event = { id: 123, title: 'Synthetic provider title', location: 'nnv', site_url: 'https://nn.kudago.com/event/synthetic/',
    dates: [{ start: Date.parse('2026-09-28T10:00:00Z') / 1000, end: Date.parse('2026-09-28T11:00:00Z') / 1000,
      is_startless: false, is_endless: false, is_continuous: false, use_place_schedule: false, schedules: [] }],
    place: venue, age_restriction: '0+', is_free: !paid, price: paid ? 'от 400 до 600 рублей' : 'бесплатно' };
  const client = new KudagoClient({ now: () => time, fetcher: async raw => {
    calls++; if (providerFails) return new Response('', { status: 503 });
    const url = new URL(String(raw));
    return new Response(JSON.stringify(url.pathname === '/public-api/v1.4/events/' ? { count: 1, next: null, results: [event] }
      : url.pathname.includes('/events/') ? event : venue));
  } });
  const service = new DurableEventPlanning({ database, client });
  const view = await database.withOwner(owner, async (state, save, sql) => {
    const sessions = new PlanningSessions({ now: () => new Date(time), plan: async () => { throw new Error('No LLM/planner allowed'); } });
    const view = sessions.create(owner, { locality: { id: 'nn', name: 'Нижний Новгород', region_id: '32', timezone: 'Europe/Moscow' },
      shared: { mobility: ['walking'], party: { total: 2 }, budget: { kind: 'unlimited' } },
      points: { origin: { lat: 56.319, lon: 44, locality_id: 'nn', source: 'user_map', label: 'Own point' } },
      days: [{ day_id: 'd', date: '2026-09-28', window: { start: '10:00', end: '19:00' }, activities: withFood ? [{
        id: 'food', label: 'кафе', selection: { category_policy: 'related_allowed', named_types: ['кафе'] }, requirements: [],
        categories: { state: 'matched', include_any: ['200'], exclude: [], region_id: '32', catalog_version: 'test' },
      }] : [], order: [] }] },
    { catalog: { version: 'test', region_id: '32', leaf_ids: ['200'] }, visit_policy: { version: 'test', by_category: { '200': 45 }, arrival_buffer_minutes: 5 },
      modes: ['walking'], data_mode: 'test', point_area: { south: 56, north: 57, west: 43, east: 45 } }, { 'points.origin': 'user_map' });
    state.checkpoint = sessions.checkpoint(); await save();
    await database.saveSaved(sql, owner, { id: view.id, revision: view.version, conditions: projectSavedConditions(view, { now: new Date(time) }), expires_at: new Date(time + 30 * 86400000).toISOString() });
    return view;
  });
  const action = () => ({ base_version: view.version, event_id: randomUUID(), day_id: 'd' });
  async function available() {
    const search = await service.search(owner, view.id, action());
    const availability = await service.availability(owner, view.id, { base_version: view.version, event_id: randomUUID(), search_id: search.search_id, choice_id: search.cards[0]!.choice_id });
    const select = { ...action(), search_id: search.search_id, occurrence_choice_id: availability.choices[0]!.occurrence_choice_id };
    return { search, availability, select };
  }
  const get = () => database.withOwner(owner, async state => new PlanningSessions({ checkpoint: state.checkpoint, now: () => new Date(time), plan: async () => ({}) }).get(owner, view.id));
  return { database, owner, view, service, client, action, available, get, calls: () => calls, fail: () => { providerFails = true; }, advance: (ms: number) => { time += ms; },
    cleanup: async () => { await database.pool.end();
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); } } };
}

run('search/availability/select has no LLM, stable replay, own snapshot whitelist and source expiry/recheck', async () => {
  const f = await fixture();
  try {
    const searchBody = f.action(), search = await f.service.search(f.owner, f.view.id, searchBody);
    expect(await f.service.search(f.owner, f.view.id, searchBody)).toEqual(search); expect(f.calls()).toBe(1);
    const body = { base_version: f.view.version, event_id: randomUUID(), search_id: search.search_id, choice_id: search.cards[0]!.choice_id };
    const choices = await f.service.availability(f.owner, f.view.id, body);
    expect(await f.service.availability(f.owner, f.view.id, body)).toEqual(choices); expect(f.calls()).toBe(3);
    const selection = { ...f.action(), search_id: search.search_id, occurrence_choice_id: choices.choices[0]!.occurrence_choice_id };
    const selected = await f.service.select(f.owner, f.view.id, selection);
    expect(selected.draft.days[0]!.activities).toHaveLength(1); expect(selected.confirmed_version).toBeNull();
    expect(Object.values(selected.event_previews ?? {})[0]?.title).toBe('Synthetic provider title');
    expect(await f.service.select(f.owner, f.view.id, selection)).toEqual(selected); expect(f.calls()).toBe(3);
    const saved = (await f.database.pool.query('SELECT conditions,expires_at FROM saved_user_conditions WHERE owner=$1', [f.owner])).rows[0];
    expect(saved.conditions.days[0].activities[0]).toMatchObject({ label: 'Выбранное событие', target: { event_id: '123' } });
    expect(JSON.stringify(saved.conditions)).not.toMatch(/Synthetic provider|Synthetic venue|opening|price|venue_source/u);
    const ownExpiry = saved.expires_at.getTime();
    f.advance(300001); const expired = await f.get();
    expect(expired.event_previews).toBeUndefined(); expect(expired.issues.map(i => i.code)).toContain('EVENT_RECHECK_REQUIRED');
    const recheck = { base_version: expired.version, event_id: randomUUID(), day_id: 'd', activity_id: expired.draft.days[0]!.activities[0]!.id };
    const fresh = await f.service.recheck(f.owner, f.view.id, recheck);
    expect(fresh.event_previews).toBeDefined(); expect(f.calls()).toBe(5);
    expect(await f.service.recheck(f.owner, f.view.id, recheck)).toEqual(fresh); expect(f.calls()).toBe(5);
    expect((await f.database.pool.query('SELECT expires_at FROM saved_user_conditions WHERE owner=$1', [f.owner])).rows[0].expires_at.getTime()).toBe(ownExpiry);
  } finally { await f.cleanup(); }
});

run('HTTP event selection survives SQL reload and composes a fixed session with food through the real Python planner', async () => {
  const f = await fixture(true, true), app = Fastify(), places = planningFixture();
  for (const item of places.items) {
    item.point.lat += 0.57; item.point.lon += 6.38;
    Object.assign(item.schedule, { Mon: structuredClone(item.schedule.Fri) });
  }
  let solves = 0, diagnostic: unknown;
  const options = { database: f.database, context: async (): Promise<never> => { throw new Error('No geography refresh expected'); },
    provider: async (): Promise<never> => { throw new Error('No LLM expected'); },
    plan: async (job: Record<string, unknown>) => { solves++; const result = await planPlacesWithDgis(places.client(), job, {
      now: f.database.now, dataMode: 'test', resolveEvents: createResolvePlanEvents(f.client), retrieval: { radiusMeters: 5000 },
    }); diagnostic = safePlanningDiagnostic(result); return result; } };
  const planning = new DurablePlanning(options), headers = { 'x-test-owner': f.owner };
  const auth = (request: { headers: Record<string, unknown> }) => request.headers['x-test-owner'] === f.owner ? f.owner : null;
  registerPlanningRoutes(app, planning, auth); registerEventPlanningRoutes(app, f.service, auth);
  const base = `/api/planning/drafts/${f.view.id}`;
  async function post(path: string, payload: object) {
    const response = await app.inject({ method: 'POST', url: `${base}${path}`, headers, payload });
    expect(response.statusCode, response.body).toBe(200); return response.json();
  }
  try {
    const search = await post('/events/search', f.action());
    const availability = await post('/events/availability', { ...f.action(), day_id: undefined,
      search_id: search.search_id, choice_id: search.cards[0].choice_id });
    const selected = await post('/events/select', { ...f.action(), search_id: search.search_id,
      occurrence_choice_id: availability.choices[0].occurrence_choice_id });
    expect(selected.draft.days[0].activities).toHaveLength(2);
    const confirmed = await post('/confirm', { base_version: selected.version, event_id: randomUUID() });
    const body = { base_version: confirmed.version, event_id: randomUUID() };
    const result = await post('/plan', body);
    expect(result.result.status, JSON.stringify(diagnostic)).toBe('AVAILABLE');
    const visits = result.result.days[0].visits;
    expect(visits.some((visit: { activity_id: string }) => visit.activity_id === 'food')).toBe(true);
    expect(visits.find((visit: { event?: unknown }) => visit.event)).toMatchObject({ starts_at: 780, ends_at: 840,
      price_expected_minor: 120000,
      event: { event_id: '123', schedule_kind: 'fixed', duration_basis: 'provider_session' } });
    expect(f.calls()).toBe(5);
    expect(places.requests.some(request => request.url.searchParams.get('rubric_id') === '200')).toBe(true);
    expect(await post('/plan', body)).toEqual(result); expect(solves).toBe(1); expect(f.calls()).toBe(5);
    const reloaded = new DurablePlanning(options);
    expect((await reloaded.get(f.owner, f.view.id)).result).toEqual(result.result);
    const saved = await reloaded.getSaved(f.owner, f.view.id);
    expect(saved.conditions.days[0]!.activities).toHaveLength(2);
    expect(JSON.stringify(saved.conditions)).not.toMatch(/Synthetic provider|Synthetic venue|official_start_utc/u);
  } finally { await app.close(); await f.cleanup(); }
}, 30000);
run('rejects other owners, stale version, forged choices and expired previews without another provider request', async () => {
  const f = await fixture();
  try {
    const ready = await f.available(), before = f.calls();
    await expect(f.service.select('other-owner', f.view.id, ready.select)).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    await expect(f.service.select(f.owner, f.view.id, { ...ready.select, event_id: randomUUID(), base_version: 99 })).rejects.toMatchObject({ code: 'EVENT_PREVIEW_STALE' });
    await expect(f.service.select(f.owner, f.view.id, { ...ready.select, event_id: randomUUID(), occurrence_choice_id: randomUUID() })).rejects.toMatchObject({ code: 'EVENT_CHOICE_NOT_FOUND' });
    f.advance(300001);
    await expect(f.service.select(f.owner, f.view.id, ready.select)).rejects.toMatchObject({ code: 'EVENT_PREVIEW_EXPIRED' });
    expect(f.calls()).toBe(before); expect((await f.get()).draft.days[0]!.activities).toEqual([]);
  } finally { await f.cleanup(); }
});
run('rolls back checkpoint and own snapshot on real SQL error; failed action does not repeat upstream or partially add an activity', async () => {
  const f = await fixture();
  try {
    const ready = await f.available(), original = f.database.saveSaved;
    f.database.saveSaved = async (client, owner, saved) => {
      if (saved.revision > f.view.version) await client.query('SELECT 1 / 0');
      else await original.call(f.database, client, owner, saved);
    };
    try { await expect(f.service.select(f.owner, f.view.id, ready.select)).rejects.toMatchObject({ code: 'EVENT_OPERATION_FAILED' }); }
    finally { f.database.saveSaved = original; }
    expect((await f.get()).draft.days[0]!.activities).toEqual([]);
    expect((await f.database.pool.query('SELECT conditions FROM saved_user_conditions WHERE owner=$1', [f.owner])).rows[0].conditions.days[0].activities).toEqual([]);
    await expect(f.service.select(f.owner, f.view.id, ready.select)).rejects.toMatchObject({ code: 'EVENT_OPERATION_FAILED' });
    expect(f.calls()).toBe(3);
    const good = await f.service.select(f.owner, f.view.id, { ...ready.select, event_id: randomUUID() });
    expect(good.draft.days[0]!.activities).toHaveLength(1);
  } finally { await f.cleanup(); }
});
run('enforces global capacity, does not replay failed provider calls, purges exact facts and cascades on deletion', async () => {
  const f = await fixture(), lock = await f.database.pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(782010,0),pg_advisory_lock(782010,1)');
    await expect(f.service.search(f.owner, f.view.id, f.action())).rejects.toMatchObject({ code: 'INTENT_BUSY', status: 429 });
    expect(f.calls()).toBe(0); await lock.query('SELECT pg_advisory_unlock_all()');
    const ready = await f.available();
    f.fail(); const body = { base_version: f.view.version, event_id: randomUUID(), search_id: ready.search.search_id, choice_id: ready.search.cards[0]!.choice_id };
    await expect(f.service.availability(f.owner, f.view.id, body)).rejects.toMatchObject({ code: 'EVENT_PROVIDER_ERROR' });
    await expect(f.service.availability(f.owner, f.view.id, body)).rejects.toMatchObject({ code: 'EVENT_PROVIDER_ERROR' }); expect(f.calls()).toBe(4);
    f.advance(300001); await f.database.purge();
    expect((await f.database.pool.query('SELECT data FROM planning_event_previews WHERE owner=$1', [f.owner])).rows.every(row => row.data === null)).toBe(true);
    await f.database.pool.query('DELETE FROM saved_user_conditions WHERE owner=$1', [f.owner]);
    expect((await f.database.pool.query('SELECT * FROM planning_event_previews WHERE owner=$1', [f.owner])).rowCount).toBe(0);
  } finally { await lock.query('SELECT pg_advisory_unlock_all()'); lock.release(); await f.cleanup(); }
});
run('HTTP authenticates all event actions, bounds payloads, and only notifies after explicit successful selection', async () => {
  const f = await fixture(), app = Fastify(), changes: string[] = [];
  registerEventPlanningRoutes(app, f.service, request => request.headers['x-test-owner'] === f.owner ? f.owner : null,
    async (_owner, view) => { changes.push(view.id); });
  try {
    for (const action of ['search', 'availability', 'select', 'recheck']) {
      const res = await app.inject({ method: 'POST', url: `/api/planning/drafts/${f.view.id}/events/${action}`, payload: {} });
      expect(res.statusCode).toBe(401); expect(res.headers['cache-control']).toBe('no-store');
    }
    const headers = { 'x-test-owner': f.owner }, base = `/api/planning/drafts/${f.view.id}/events`;
    const search = (await app.inject({ method: 'POST', url: `${base}/search`, headers, payload: f.action() })).json();
    expect(search.cards).toHaveLength(1); expect(changes).toEqual([]);
    const availability = (await app.inject({ method: 'POST', url: `${base}/availability`, headers, payload: { base_version: f.view.version, event_id: randomUUID(), search_id: search.search_id, choice_id: search.cards[0].choice_id } })).json();
    const selected = await app.inject({ method: 'POST', url: `${base}/select`, headers, payload: { ...f.action(), search_id: search.search_id, occurrence_choice_id: availability.choices[0].occurrence_choice_id } });
    expect(selected.statusCode).toBe(200); expect(changes).toEqual([f.view.id]);
  } finally { await app.close(); await f.cleanup(); }
});
