import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { PlanningDatabase } from './planning-database.js';
import { PlanningSessions } from './planning-sessions.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { projectSavedConditions } from './saved-conditions.js';
import { SavedRouteLibrary, registerSavedRouteLibrary } from './saved-route-list.js';

const run = it.skipIf(!process.env.TEST_DATABASE_URL);
async function fixture() {
  let instant = demoNow(); const now = () => new Date(instant), owner = 'library-test:' + randomUUID();
  const database = PlanningDatabase.connect(process.env.TEST_DATABASE_URL!, undefined, { now });
  await database.migrate();
  const library = new SavedRouteLibrary(database), app = Fastify();
  registerSavedRouteLibrary(app, library, request => request.headers['x-test-owner'] === owner ? owner : null);
  const sessions = new PlanningSessions({ now, plan: async () => { throw Error('No provider in library'); } });
  async function seed(count = 1, who = owner) {
    const fixture = planningFixture(), created = Array.from({ length: count }, () => sessions.create(who, fixture.input.intent,
      { catalog: fixture.input.catalog, visit_policy: fixture.input.visit_policy, modes: ['walking'], data_mode: 'test' }));
    await database.withOwner(who, async (state, save, client) => {
      state.checkpoint = sessions.checkpoint(); await save();
      for (const view of created) await database.saveSaved(client, who, { id: view.id, revision: view.version,
        expires_at: new Date(+now() + 30 * 86400_000).toISOString(), conditions: projectSavedConditions(view, { now: now() }) });
    });
    return created;
  }
  const headers = { 'x-test-owner': owner };
  return { app, library, database, owner, headers, seed, now,
    advance: (ms: number) => { instant = new Date(+instant + ms); },
    cleanup: async () => { await app.close(); for (const table of ['bot_navigation', 'saved_user_conditions', 'planning_owners'])
      await database.pool.query(`DELETE FROM ${table} WHERE owner=$1 OR owner=$2`, [owner, owner + ':foreign']);
      await database.pool.end(); } };
}

run('deletes only an explicitly selected own revision, preserves another active route and deduplicates replay', async () => {
  const f = await fixture();
  try {
    const [a, b] = await f.seed(2), foreign = (await f.seed(1, f.owner + ':foreign'))[0]!;
    await f.library.activate(f.owner, a!.id, { event_id: randomUUID() });
    await f.library.activate(f.owner, b!.id, { event_id: randomUUID() });
    const body = { event_id: randomUUID(), base_revision: a!.version }, path = `/api/planning/saved/${a!.id}/delete`;
    expect((await f.app.inject({ method: 'POST', url: path, payload: body })).statusCode).toBe(401);
    await expect(f.library.remove(f.owner, foreign.id, body)).rejects.toMatchObject({ code: 'SAVED_CONDITIONS_NOT_FOUND' });
    await expect(f.library.remove(f.owner, a!.id, { ...body, base_revision: 99 })).rejects.toMatchObject({ code: 'SAVED_CONDITIONS_STALE' });
    const deleted = await f.app.inject({ method: 'POST', url: path, headers: f.headers, payload: body });
    expect(deleted.statusCode).toBe(200); expect(deleted.json()).toEqual({ deleted: true });
    expect(deleted.headers['cache-control']).toBe('no-store');
    expect(await f.library.remove(f.owner, a!.id, body)).toEqual({ deleted: true });
    await expect(f.library.remove(f.owner, b!.id, body)).rejects.toMatchObject({ code: 'EVENT_CONFLICT' });
    const remaining = await f.library.list(f.owner);
    expect(remaining.items).toHaveLength(1); expect(remaining.items[0]).toMatchObject({ id: b!.id, active: true });
    f.advance(1_800_001); // Long-lived own conditions can also be deleted after draft expiry.
    await f.library.remove(f.owner, b!.id, { event_id: randomUUID(), base_revision: b!.version });
    expect((await f.library.list(f.owner)).items).toEqual([]);
    const state = (await f.database.pool.query('SELECT state FROM bot_navigation WHERE owner=$1', [f.owner])).rows[0].state;
    expect(state).toMatchObject({ mode: 'idle', routes: [] }); expect(state.activeRouteId).toBeUndefined();
  } finally { await f.cleanup(); }
});

run('rolls back deletion of saved conditions and checkpoint when navigation write fails', async () => {
  const f = await fixture(), constraint = 'library_delete_fail_' + randomUUID().replaceAll('-', '');
  try {
    const [view] = await f.seed(); await f.library.activate(f.owner, view!.id, { event_id: randomUUID() });
    const before = (await f.database.pool.query('SELECT state FROM planning_owners WHERE owner=$1', [f.owner])).rows;
    await f.database.pool.query(`ALTER TABLE bot_navigation ADD CONSTRAINT ${constraint} CHECK(owner <> '${f.owner}' OR state->>'mode' <> 'idle')`);
    await expect(f.library.remove(f.owner, view!.id, { event_id: randomUUID(), base_revision: view!.version })).rejects.toThrow();
    expect((await f.database.pool.query('SELECT state FROM planning_owners WHERE owner=$1', [f.owner])).rows).toEqual(before);
    expect((await f.database.pool.query('SELECT 1 FROM saved_user_conditions WHERE owner=$1 AND draft_id=$2', [f.owner, view!.id])).rowCount).toBe(1);
    expect((await f.library.list(f.owner)).items[0]?.active).toBe(true);
  } finally {
    await f.database.pool.query(`ALTER TABLE bot_navigation DROP CONSTRAINT IF EXISTS ${constraint}`); await f.cleanup();
  }
});

run('lists own snapshots read-only with stable pagination, freshness flags and no expiry extension', async () => {
  const f = await fixture();
  try {
    await f.seed(51); await f.seed(1, f.owner + ':foreign');
    const before = await f.database.pool.query('SELECT state,expires_at FROM planning_owners WHERE owner=$1', [f.owner]);
    const unauthorized = await f.app.inject({ method: 'GET', url: '/api/planning/saved' });
    expect(unauthorized.statusCode).toBe(401);
    const first = await f.app.inject({ method: 'GET', url: '/api/planning/saved', headers: f.headers });
    expect(first.statusCode).toBe(200); expect(first.headers['cache-control']).toBe('no-store');
    const page = first.json(); expect(page.items).toHaveLength(50); expect(page.next_cursor).toEqual(expect.any(String));
    expect(page.items.every((item: { can_open: boolean; has_fresh_result: boolean }) => item.can_open && !item.has_fresh_result)).toBe(true);
    const last = await f.app.inject({ method: 'GET', url: '/api/planning/saved?cursor=' + page.next_cursor, headers: f.headers });
    expect(last.statusCode).toBe(200); expect(last.json().items).toHaveLength(1); expect(last.json().next_cursor).toBeNull();
    expect(new Set([...page.items, ...last.json().items].map(item => item.id)).size).toBe(51);
    expect(JSON.stringify(page)).not.toMatch(/point|region_id|catalog_version|provider|checkpoint|shared|requirements/);
    expect((await f.database.pool.query('SELECT state,expires_at FROM planning_owners WHERE owner=$1', [f.owner])).rows).toEqual(before.rows);
    expect((await f.app.inject({ method: 'GET', url: '/api/planning/saved?cursor=not-a-cursor', headers: f.headers })).statusCode).toBe(400);
    f.advance(1_800_001);
    expect((await f.library.list(f.owner)).items.every(item => !item.can_open)).toBe(true);
    f.advance(30 * 86400_000);
    expect((await f.library.list(f.owner)).items).toEqual([]);
  } finally { await f.cleanup(); }
}, 20_000);

run('activates a fresh draft, replays without rewinding later selection and returns own conditions after expiry', async () => {
  const f = await fixture();
  try {
    const [a, b] = await f.seed(2), foreign = (await f.seed(1, f.owner + ':foreign'))[0]!;
    const path = (id: string) => `/api/planning/saved/${id}/activate`;
    const requestA = { event_id: randomUUID() }, requestB = { event_id: randomUUID() };
    expect((await f.app.inject({ method: 'POST', url: path(foreign.id), headers: f.headers, payload: requestA })).statusCode).toBe(404);
    const activated = await f.app.inject({ method: 'POST', url: path(a!.id), headers: f.headers, payload: requestA });
    expect(activated.statusCode).toBe(200); expect(activated.json().view.id).toBe(a!.id);
    expect((await f.library.list(f.owner)).items.find(item => item.id === a!.id)?.active).toBe(true);
    const snapshot = await f.database.pool.query('SELECT revision,conditions,expires_at FROM saved_user_conditions WHERE owner=$1 AND draft_id=$2', [f.owner, a!.id]);
    expect((await f.app.inject({ method: 'POST', url: path(a!.id), headers: f.headers, payload: requestA })).json()).toEqual(activated.json());
    expect((await f.app.inject({ method: 'POST', url: path(b!.id), headers: f.headers, payload: requestA })).json().error).toBe('EVENT_CONFLICT');
    await f.library.activate(f.owner, b!.id, requestB);
    expect((await f.app.inject({ method: 'POST', url: path(a!.id), headers: f.headers, payload: requestA })).json().error).toBe('ACTIVATION_SUPERSEDED');
    expect((await f.library.list(f.owner)).items.find(item => item.id === b!.id)?.active).toBe(true);
    f.advance(1_800_001);
    const reopened = await f.library.activate(f.owner, a!.id, { event_id: randomUUID() });
    expect(reopened.view).toBeNull(); expect(reopened.saved?.id).toBe(a!.id);
    expect(reopened.saved?.conditions.days[0]!.activities.map(activity => activity.label)).toEqual(['culture', 'food']);
    expect((await f.database.pool.query('SELECT revision,conditions,expires_at FROM saved_user_conditions WHERE owner=$1 AND draft_id=$2', [f.owner, a!.id])).rows).toEqual(snapshot.rows);
    const nav = (await f.database.pool.query('SELECT state FROM bot_navigation WHERE owner=$1', [f.owner])).rows[0].state;
    expect(nav.routes).toHaveLength(2); expect(nav.routes.every((r: { requestText: string }) => r.requestText === '')).toBe(true);
  } finally { await f.cleanup(); }
}, 20_000);

run('rolls back navigation, receipts and checkpoint on SQL failure and respects nav contention', async () => {
  const f = await fixture(), constraint = 'library_fail_' + randomUUID().replaceAll('-', '');
  let lease;
  try {
    const [view] = await f.seed(), request = { event_id: randomUUID() };
    const before = (await f.database.pool.query('SELECT state FROM planning_owners WHERE owner=$1', [f.owner])).rows;
    await f.database.pool.query(`ALTER TABLE bot_navigation ADD CONSTRAINT ${constraint} CHECK (owner <> '${f.owner}')`);
    await expect(f.library.activate(f.owner, view!.id, request)).rejects.toThrow();
    expect((await f.database.pool.query('SELECT state FROM planning_owners WHERE owner=$1', [f.owner])).rows).toEqual(before);
    expect((await f.database.pool.query('SELECT state FROM bot_navigation WHERE owner=$1', [f.owner])).rowCount).toBe(0);
    await f.database.pool.query(`ALTER TABLE bot_navigation DROP CONSTRAINT ${constraint}`);
    lease = await f.database.pool.connect();
    await lease.query('SELECT pg_advisory_lock(hashtextextended($1,782003))', [f.owner]);
    await expect(f.library.activate(f.owner, view!.id, request)).rejects.toThrow('OPERATION_IN_PROGRESS');
    await lease.query('SELECT pg_advisory_unlock_all()'); lease.release(); lease = undefined;
    expect((await f.library.activate(f.owner, view!.id, request)).view?.id).toBe(view!.id);
  } finally {
    if (lease) { await lease.query('SELECT pg_advisory_unlock_all()'); lease.release(); }
    await f.database.pool.query(`ALTER TABLE bot_navigation DROP CONSTRAINT IF EXISTS ${constraint}`);
    await f.cleanup();
  }
}, 20_000);
