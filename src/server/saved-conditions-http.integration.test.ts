import { createHmac, randomInt, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { PlanningDatabase } from './planning-database.js';
import { DurablePlanning } from './durable-planning.js';
import { registerPlanningRoutes, maxPlanningAuthenticator } from './planning-routes.js';
import { intentFixture } from './intent-start.fixture.js';
import { SavedConditionsViewSchema } from '../shared/saved-conditions.js';

it.skipIf(!process.env.TEST_DATABASE_URL)('preserves edited conditions through authenticated HTTP expiry and fresh restoration across instances', async () => {
  let instant = new Date('2026-09-24T09:00:00Z');
  const now = () => new Date(instant), userId = randomInt(10_000_000, 99_999_999), owner = `max:${userId}`;
  const database = PlanningDatabase.connect(process.env.TEST_DATABASE_URL!, undefined, { now });
  await database.migrate();
  const f = intentFixture();
  let contexts = 0, modelCalls = 0, plannerCalls = 0;
  const options = { database, now, context: async () => {
    const fresh = ++contexts > 1, cafeId = fresh ? 'fresh-cafe' : '200', museumId = fresh ? 'fresh-museum' : '100';
    const version = fresh ? 'fresh-version' : f.context.catalog.version;
    return { ...f.context, now: now().toISOString(),
      catalog: { ...f.context.catalog, version, rows: [[museumId, 'Музеи', []], [cafeId, 'Кафе', []]] as [string, string, string[]][] },
      planning: { catalog: { version, region_id: '32', leaf_ids: [museumId, cafeId] },
        visit_policy: { version: 'test-durations', by_category: { [museumId]: 60, [cafeId]: 45 } },
        modes: ['walking'] as const, data_mode: 'test' as const, point_area: { south: 55, north: 56, west: 37, east: 38 } },
    };
  }, provider: async () => { modelCalls++; return f.response; }, plan: async () => { plannerCalls++; throw new Error('No calculation on reopen'); } };
  function signed(id = userId) {
    const entries = [['auth_date', String(Math.floor(now().getTime() / 1000))], ['user', JSON.stringify({ id, first_name: 'Synthetic' })]];
    const key = createHmac('sha256', 'WebAppData').update('saved-http-test').digest();
    const hash = createHmac('sha256', key).update(entries.map(item => item.join('=')).join('\n')).digest('hex');
    return { 'x-max-init-data': new URLSearchParams([...entries, ['hash', hash]]).toString() };
  }
  const planning = new DurablePlanning(options), app = Fastify();
  registerPlanningRoutes(app, new DurablePlanning(options), maxPlanningAuthenticator('saved-http-test', 3600, () => Math.floor(now().getTime() / 1000)));
  try {
    const created = await planning.start(owner, { event_id: randomUUID(), user_text: f.text, locality_token: 'synthetic-start' });
    if (created.status !== 'draft') throw new Error('Expected initial draft');
    const id = created.view.id, draftPath = `/api/planning/drafts/${id}`, savedPath = `/api/planning/saved/${id}`;
    const changed = await app.inject({ method: 'PATCH', url: draftPath, headers: signed(), payload: {
      event_id: randomUUID(), base_version: created.view.version, changes: [
        { op: 'window', day_ids: ['day-1'], start: '17:00', end: '20:00' },
        { op: 'party', total: 2 }, { op: 'budget', value: { kind: 'limit', amount_rub: 2400, basis: 'whole_party', period: 'per_day', enforcement: 'estimated', price_basis_assumption: 'per_person' } },
        { op: 'remove_activity', day_id: 'day-1', activity_id: 'day-1-activity-1' },
        { op: 'point', field: 'origin', point: { lat: 55.75, lon: 37.62, label: 'Synthetic user point', source: 'user_map' } },
      ],
    } });
    expect(changed.statusCode).toBe(200);
    instant = new Date(instant.getTime() + 1_801_000);
    expect((await app.inject({ url: draftPath, headers: signed() })).statusCode).toBe(404);
    expect((await app.inject({ url: savedPath })).statusCode).toBe(401);
    expect((await app.inject({ url: savedPath, headers: signed(userId + 1) })).statusCode).toBe(404);
    const read = await app.inject({ url: savedPath, headers: signed() });
    expect(read.statusCode).toBe(200); expect(read.headers['cache-control']).toBe('no-store');
    const saved = SavedConditionsViewSchema.parse(read.json());
    expect(saved.conditions.days[0]?.window).toEqual({ start: '17:00', end: '20:00' });
    expect(saved.conditions.days[0]?.activities.map(activity => activity.label)).toEqual(['кафе']);
    expect(saved.conditions.shared.budget).toMatchObject({ amount_rub: 2400, enforcement: 'estimated' });
    expect(saved.conditions.shared.party?.total).toBe(2);
    expect({ modelCalls, contexts, plannerCalls }).toEqual({ modelCalls: 1, contexts: 1, plannerCalls: 0 });
    const body = { event_id: randomUUID(), base_revision: saved.revision, locality_token: 'synthetic-fresh' };
    expect((await app.inject({ method: 'POST', url: savedPath + '/restore', headers: signed(userId + 1), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: savedPath + '/restore', headers: signed(), payload: { ...body, base_revision: saved.revision + 99 } })).statusCode).toBe(409);
    expect(contexts).toBe(1);
    const restored = await app.inject({ method: 'POST', url: savedPath + '/restore', headers: signed(), payload: body });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id, phase: 'DRAFT', confirmed_version: null, result: null });
    expect(restored.json().version).toBeGreaterThan(saved.revision);
    expect(restored.json().draft.days[0].activities[0].categories.include_any).toEqual(['fresh-cafe']);
    expect(restored.json().draft.shared.budget.amount_rub).toBe(2400);
    const replay = await app.inject({ method: 'POST', url: savedPath + '/restore', headers: signed(), payload: body });
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(restored.json());
    expect({ modelCalls, contexts, plannerCalls }).toEqual({ modelCalls: 1, contexts: 2, plannerCalls: 0 });
    await planning.remove(owner, id);
    expect((await app.inject({ url: savedPath, headers: signed() })).statusCode).toBe(404);
  } finally {
    await app.close();
    await database.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]);
    await database.pool.query('DELETE FROM saved_user_conditions WHERE owner=$1', [owner]);
    await database.pool.end();
  }
}, 30_000);
