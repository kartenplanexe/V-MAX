import { createHmac, randomInt, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { PlanningDatabase } from './planning-database.js';
import { DurablePlanning } from './durable-planning.js';
import { RouteSharing } from './route-sharing.js';
import { intentFixture } from './intent-start.fixture.js';
import { registerSharingRoutes } from './route-sharing-routes.js';
import { maxPlanningAuthenticator } from './planning-routes.js';

const run = it.skipIf(!process.env.TEST_DATABASE_URL);
async function fixture() {
  let time = Date.parse('2026-09-24T09:30:00Z'), contextCalls = 0, llmCalls = 0;
  const database = PlanningDatabase.connect(process.env.TEST_DATABASE_URL!, undefined, { now: () => new Date(time) });
  await database.migrate(); await database.migrate();
  const owner = 'max:' + randomInt(1_000_000_000, 2_000_000_000), recipient = 'max:' + randomInt(2_000_000_000, 3_000_000_000), f = intentFixture();
  const context = async () => { contextCalls++; return { ...f.context, now: new Date(time).toISOString(), planning: {
    catalog: { version: f.context.catalog.version, region_id: '32', leaf_ids: ['100', '200'] },
    visit_policy: { version: 'test.v1', by_category: { '100': 60, '200': 45 }, arrival_buffer_minutes: 5 },
    modes: ['walking'] as const, point_area: { south: 55, north: 56, west: 37, east: 38 }, data_mode: 'test' as const } }; };
  const plan = async () => ({ status: 'AVAILABLE', warnings: [], data_mode: 'test',
    origin: { lat: 55.75, lon: 37.62, label: 'private-point-label', locality_id: 'mow', source: 'user_map' },
    days: [{ day_id: 'day-1', date: '2026-09-25', status: 'AVAILABLE', missing_activity_ids: [], ends_at: 1100,
      visits: ['100', '200'].map((id, index) => ({ activity_id: `day-1-activity-${index + 1}`, place_id: `synthetic-${id}`,
        name: `Synthetic ${id}`, point: { lat: 55.76 + index / 1000, lon: 37.64 }, starts_at: 960 + index * 70,
        ends_at: 1020 + index * 70, travel_before_minutes: 5, arrival_buffer_minutes: 5,
        price_expected_minor: null, warnings: [], source: { provider: 'test', fetched_at: new Date(time).toISOString(),
          valid_until: new Date(time + 900000).toISOString(), data_mode: 'test' } })) }] });
  const planning = new DurablePlanning({ database, context, provider: async () => { llmCalls++; return f.response; }, plan });
  const initial = await planning.start(owner, { event_id: randomUUID(), user_text: f.text, locality_token: 'synthetic' });
  if (initial.status !== 'draft') throw new Error('Expected draft');
  let view = await planning.edit(owner, initial.view.id, { event_id: randomUUID(), base_version: initial.view.version,
    changes: [{ op: 'point', field: 'origin', point: { lat: 55.75, lon: 37.62, label: 'private-point-label', source: 'user_map' } }] });
  view = await planning.confirm(owner, view.id, { event_id: randomUUID(), base_version: view.version });
  view = await planning.calculate(owner, view.id, { event_id: randomUUID(), base_version: view.version });
  const sharing = new RouteSharing({ database, context, botUsername: 'synthetic_bot' });
  const create = () => ({ event_id: randomUUID(), draft_id: view.id, base_revision: view.version, include_private_points: false });
  return { database, owner, recipient, planning, sharing, create, view, context,
    advance: (ms: number) => { time += ms; }, calls: () => ({ llmCalls, contextCalls }),
    cleanup: async () => {
      await database.pool.query('DELETE FROM saved_user_conditions WHERE owner=ANY($1::text[])', [[owner, recipient]]);
      await database.pool.query('DELETE FROM planning_owners WHERE owner=ANY($1::text[])', [[owner, recipient]]);
      await database.pool.end();
    } };
}

run('immutable share has private-point omission, exact original result expiry, no provider refresh on reads and owner-only revoke', async () => {
  const f = await fixture();
  try {
    const body = f.create(), created = await f.sharing.create(f.owner, body), baseline = f.calls();
    expect(await f.sharing.create(f.owner, body)).toEqual(created);
    await expect(f.sharing.create(f.owner, { ...body, include_private_points: true })).rejects.toMatchObject({ code: 'EVENT_CONFLICT' });
    const fresh = await f.sharing.resolve(f.recipient, { token: created.token });
    expect(fresh.result?.days[0]?.visits.map(v => v.place_id)).toEqual(['synthetic-100', 'synthetic-200']);
    expect(fresh.result?.origin).toBeUndefined();
    expect(fresh.conditions.points).toEqual({});
    expect(fresh.conditions.queries).toEqual({});
    expect(JSON.stringify(fresh)).not.toMatch(/private-point-label|sharing-owner|"draft_id"|"token"/u);
    expect(Date.parse(fresh.result_expires_at!) - Date.parse('2026-09-24T09:30:00Z')).toBe(300000);
    f.advance(300001);
    expect(await f.sharing.resolve(f.recipient, { token: created.token })).toMatchObject({ result: null, result_expires_at: null, expires_at: created.expires_at });
    expect(f.calls()).toEqual(baseline);
    await expect(f.sharing.revoke(f.recipient, { share_id: created.share_id, event_id: randomUUID() })).rejects.toMatchObject({ code: 'SHARED_PLAN_NOT_FOUND' });
    await f.sharing.revoke(f.owner, { share_id: created.share_id, event_id: randomUUID() });
    await expect(f.sharing.resolve(f.recipient, { token: created.token })).rejects.toMatchObject({ code: 'SHARED_PLAN_NOT_FOUND' });
  } finally { await f.cleanup(); }
});
run('imports into a new recipient draft without LLM/confirmation/result and deduplicates beyond the checkpoint TTL', async () => {
  const f = await fixture();
  try {
    const shared = await f.sharing.create(f.owner, f.create()), before = f.calls();
    const body = { token: shared.token, event_id: randomUUID(), locality_token: 'fresh-synthetic' };
    const copied = await f.sharing.import(f.recipient, body);
    expect(copied.id).not.toBe(f.view.id);
    expect(copied).toMatchObject({ phase: 'DRAFT', confirmed_version: null, result: null });
    expect(copied.draft.days[0]?.activities.map(a => a.label)).toEqual(['музей', 'кафе']);
    expect(copied.issues).toContainEqual({ code: 'ORIGIN_REQUIRED', field: 'points.origin' });
    expect(f.calls()).toEqual({ llmCalls: before.llmCalls, contextCalls: before.contextCalls + 1 });
    expect((await f.sharing.import(f.recipient, body)).id).toBe(copied.id);
    await expect(f.sharing.import(f.recipient, { ...body, locality_token: 'changed' })).rejects.toMatchObject({ code: 'EVENT_CONFLICT' });
    await expect(f.planning.get(f.recipient, f.view.id)).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    f.advance(1800001);
    await expect(f.sharing.import(f.recipient, body)).rejects.toMatchObject({ code: 'SHARED_IMPORT_EXPIRED', status: 410 });
    expect(f.calls().contextCalls).toBe(before.contextCalls + 1);
    expect((await f.planning.getSaved(f.recipient, copied.id)).conditions.days[0]?.activities).toHaveLength(2);
  } finally { await f.cleanup(); }
});
run('retained routes can create a fresh share after their original draft retention date', async () => {
  const f = await fixture();
  try {
    await f.database.pool.query('UPDATE saved_user_conditions SET retained=true WHERE owner=$1 AND draft_id=$2', [f.owner, f.view.id]);
    f.advance(31 * 86400000);
    const shared = await f.sharing.create(f.owner, f.create());
    expect(Date.parse(shared.expires_at) - f.database.now().getTime()).toBe(7 * 86400000);
    expect((await f.sharing.resolve(f.recipient, { token: shared.token })).conditions.days).toHaveLength(1);
  } finally { await f.cleanup(); }
});
run('source deletion cascades, link TTL is bounded, stale source revisions fail and failed context is not repeated', async () => {
  const f = await fixture();
  try {
    await expect(f.sharing.create(f.owner, { ...f.create(), base_revision: 0 })).rejects.toMatchObject({ code: 'SHARE_SOURCE_STALE' });
    const shared = await f.sharing.create(f.owner, f.create());
    expect(Date.parse(shared.expires_at) - Date.parse('2026-09-24T09:30:00Z')).toBe(7 * 86400000);
    let calls = 0;
    const broken = new RouteSharing({ database: f.database, botUsername: 'synthetic_bot', context: async () => { calls++; throw new Error('synthetic failure'); } });
    const body = { token: shared.token, event_id: randomUUID(), locality_token: 'bad' };
    await expect(broken.import(f.recipient, body)).rejects.toMatchObject({ code: 'SHARED_IMPORT_FAILED' });
    await expect(broken.import(f.recipient, body)).rejects.toMatchObject({ code: 'SHARED_IMPORT_FAILED' });
    expect(calls).toBe(1);
    await f.database.pool.query('DELETE FROM saved_user_conditions WHERE owner=$1 AND draft_id=$2', [f.owner, f.view.id]);
    await expect(f.sharing.resolve(f.recipient, { token: shared.token })).rejects.toMatchObject({ code: 'SHARED_PLAN_NOT_FOUND' });
    expect((await f.database.pool.query('SELECT * FROM planning_share_imports WHERE owner=$1', [f.recipient])).rowCount).toBe(0);
  } finally { await f.cleanup(); }
});
run('revoke during external context prevents import commit and SQL failure never saves a partial recipient draft', async () => {
  const f = await fixture();
  try {
    const shared = await f.sharing.create(f.owner, f.create());
    const raced = new RouteSharing({ database: f.database, botUsername: 'synthetic_bot', context: async () => {
      await f.sharing.revoke(f.owner, { share_id: shared.share_id, event_id: randomUUID() }); return f.context();
    } });
    await expect(raced.import(f.recipient, { token: shared.token, event_id: randomUUID(), locality_token: 'race' })).rejects.toMatchObject({ code: 'SHARED_PLAN_NOT_FOUND' });
    expect((await f.database.pool.query('SELECT * FROM saved_user_conditions WHERE owner=$1', [f.recipient])).rowCount).toBe(0);
    const next = await f.sharing.create(f.owner, f.create()), original = f.database.saveSaved;
    f.database.saveSaved = async client => { await client.query('SELECT 1 / 0'); };
    try { await expect(f.sharing.import(f.recipient, { token: next.token, event_id: randomUUID(), locality_token: 'rollback' })).rejects.toMatchObject({ code: 'SHARED_IMPORT_FAILED' }); }
    finally { f.database.saveSaved = original; }
    expect((await f.database.pool.query('SELECT * FROM saved_user_conditions WHERE owner=$1', [f.recipient])).rowCount).toBe(0);
    const state = (await f.database.pool.query('SELECT state FROM planning_owners WHERE owner=$1', [f.recipient])).rows[0]?.state;
    expect(state?.checkpoint?.records ?? []).toHaveLength(0);
  } finally { await f.cleanup(); }
});
run('authenticates sharing HTTP, keeps tokens out of URL paths, and adds a recipient copy through the integration hook', async () => {
  const f = await fixture(), app = Fastify(), copied: string[] = [];
  const timestamp = Date.parse('2026-09-24T09:30:00Z') / 1000;
  function signed(owner: string) {
    const entries = [['auth_date', String(timestamp)], ['user', JSON.stringify({ id: Number(owner.slice(4)), first_name: 'Synthetic' })]];
    const key = createHmac('sha256', 'WebAppData').update('synthetic-only-auth-key').digest();
    const signature = createHmac('sha256', key).update(entries.map(pair => pair.join('=')).join('\n')).digest('hex');
    return { 'x-max-init-data': String(new URLSearchParams([...entries, ['hash', signature]])) };
  }
  registerSharingRoutes(app, f.sharing, maxPlanningAuthenticator('synthetic-only-auth-key', 3600, () => timestamp), async (owner, view) => {
    expect(owner).toBe(f.recipient); copied.push(view.id);
  });
  try {
    for (const suffix of ['', '/resolve', '/import', '/revoke']) {
      const blocked = await app.inject({ method: 'POST', url: `/api/planning/shares${suffix}`, payload: {} });
      expect(blocked.statusCode).toBe(401); expect(blocked.headers['cache-control']).toBe('no-store');
    }
    const created = await app.inject({ method: 'POST', url: '/api/planning/shares', headers: signed(f.owner), payload: f.create() });
    expect(created.statusCode).toBe(200);
    const shared = created.json();
    const resolved = await app.inject({ method: 'POST', url: '/api/planning/shares/resolve', headers: signed(f.recipient), payload: { token: shared.token } });
    expect(resolved.statusCode).toBe(200); expect(resolved.json().result.status).toBe('AVAILABLE');
    const bad = await app.inject({ method: 'POST', url: '/api/planning/shares/resolve', headers: signed(f.recipient), payload: { token: shared.token, owner: f.owner } });
    expect(bad.statusCode).toBe(400);
    const imported = await app.inject({ method: 'POST', url: '/api/planning/shares/import', headers: signed(f.recipient),
      payload: { token: shared.token, event_id: randomUUID(), locality_token: 'synthetic' } });
    expect(imported.statusCode).toBe(200); expect(copied).toEqual([imported.json().id]);
    const denied = await app.inject({ method: 'POST', url: '/api/planning/shares/revoke', headers: signed(f.recipient),
      payload: { share_id: shared.share_id, event_id: randomUUID() } });
    expect(denied.statusCode).toBe(404);
  } finally { await app.close(); await f.cleanup(); }
});
run('bounds link expiry by remaining own retention and physically clears expired provider preview without extending the link', async () => {
  const f = await fixture();
  try {
    const expiry = new Date(Date.parse('2026-09-24T09:30:00Z') + 3600000).toISOString();
    await f.database.pool.query('UPDATE saved_user_conditions SET expires_at=$3 WHERE owner=$1 AND draft_id=$2', [f.owner, f.view.id, expiry]);
    const shared = await f.sharing.create(f.owner, f.create());
    expect(shared.expires_at).toBe(expiry);
    f.advance(300001); await f.database.purge();
    const stored = (await f.database.pool.query('SELECT plan,plan_expires_at,expires_at FROM planning_share_links WHERE id=$1', [shared.share_id])).rows[0];
    expect(stored.plan).toBeNull(); expect(stored.plan_expires_at).toBeNull(); expect(stored.expires_at.toISOString()).toBe(expiry);
    f.advance(3300000);
    await expect(f.sharing.resolve(f.recipient, { token: shared.token })).rejects.toMatchObject({ code: 'SHARED_PLAN_NOT_FOUND' });
  } finally { await f.cleanup(); }
});
run('shares global context capacity with other owners and counts only an admitted context attempt', async () => {
  const f = await fixture(), occupied = await f.database.pool.connect();
  try {
    const shared = await f.sharing.create(f.owner, f.create()), before = f.calls();
    const usage = async () => Number((await f.database.pool.query("SELECT COALESCE(sum(calls),0) AS calls FROM planning_daily_usage WHERE kind='geography'")).rows[0].calls);
    const baseline = await usage();
    await occupied.query('SELECT pg_advisory_lock(782010,0),pg_advisory_lock(782010,1)');
    const body = { token: shared.token, event_id: randomUUID(), locality_token: 'capacity' };
    await expect(f.sharing.import(f.recipient, body)).rejects.toMatchObject({ code: 'INTENT_BUSY', status: 429 });
    expect(f.calls()).toEqual(before); expect(await usage()).toBe(baseline);
    await occupied.query('SELECT pg_advisory_unlock_all()');
    await expect(f.sharing.import(f.recipient, body)).rejects.toMatchObject({ code: 'INTENT_BUSY', status: 429 });
    await f.sharing.import(f.recipient, { ...body, event_id: randomUUID() });
    expect(f.calls().contextCalls).toBe(before.contextCalls + 1); expect(await usage()).toBe(baseline + 1);
  } finally { await occupied.query('SELECT pg_advisory_unlock_all()'); occupied.release(); await f.cleanup(); }
});
