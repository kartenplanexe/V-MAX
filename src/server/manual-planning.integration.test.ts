import { randomUUID, createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { ManualPlanning, registerManualPlanning } from './manual-planning.js';
import { ManualRequestInput } from '../shared/manual-planning.js';
import { PlanningDatabase } from './planning-database.js';
import { intentFixture } from './intent-start.fixture.js';

const run = it.skipIf(!process.env.TEST_DATABASE_URL);
async function fixture() {
  let calls = 0;
  const now = () => new Date('2026-09-24T09:30:00Z'), f = intentFixture(), owner = `manual:${randomUUID()}`;
  const database = PlanningDatabase.connect(process.env.TEST_DATABASE_URL!, undefined, { now }); await database.migrate();
  const context = async () => { calls++; return { ...f.context, planning: {
    catalog: { version: 'synthetic.v1', region_id: '32', leaf_ids: ['100', '200'] },
    visit_policy: { version: 'synthetic.v1', by_category: { '100': 60, '200': 45 }, arrival_buffer_minutes: 5 },
    modes: ['walking'] as const, data_mode: 'test' as const,
  } }; };
  const manual = new ManualPlanning({ database, context }), input = { event_id: randomUUID(), locality_token: 'synthetic',
    catalog_version: 'synthetic.v1', mobility: 'walking', days: [{ date: '2026-09-25', start: '16:00', end: '20:00', ordered: true,
      activities: [{ kind: 'place', category_ids: ['100'] }, { kind: 'place', category_ids: ['200'] }] }] };
  return { now, database, owner, manual, input, calls: () => calls, context, cleanup: async () => {
    await database.pool.query('DELETE FROM saved_user_conditions WHERE owner=$1', [owner]);
    await database.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]); await database.pool.end();
  } };
}
run('durably creates unconfirmed own conditions and replays across coordinator instances without provider work', async () => {
  const f = await fixture();
  try {
    const view = await f.manual.start(f.owner, f.input), second = new ManualPlanning({ database: f.database, context: f.context });
    expect(view).toMatchObject({ result: null, confirmed_version: null, phase: 'DRAFT' });
    expect((await second.start(f.owner, f.input)).id).toBe(view.id); expect(f.calls()).toBe(1);
    const saved = await f.database.withOwner(f.owner, async (_state, _save, client) => f.database.loadSaved(client, f.owner, view.id));
    expect(saved!.conditions.days[0]!.activities.map(activity => activity.label)).toEqual(['Музеи', 'Кафе']);
    expect(JSON.stringify(saved)).not.toMatch(/catalog_version|include_any|synthetic.v1/);
    expect(await f.database.withOwner('manual-foreign', async (_state, _save, client) => f.database.loadSaved(client, 'manual-foreign', view.id))).toBeNull();
    await expect(second.start(f.owner, { ...f.input, catalog_version: 'changed' })).rejects.toMatchObject({ code: 'EVENT_CONFLICT' });
    expect(f.calls()).toBe(1);
  } finally { await f.cleanup(); }
});
run('preserves pending and failed receipts instead of repeating external context calls', async () => {
  const f = await fixture();
  try {
    await f.database.withOwner(f.owner, async (state, save) => {
      state.receipts[`manual:${f.input.event_id}`] = { status: 'pending', at: f.now().getTime(),
        hash: createHash('sha256').update(JSON.stringify(ManualRequestInput.parse(f.input))).digest('hex') }; await save();
    });
    await expect(f.manual.start(f.owner, f.input)).rejects.toMatchObject({ code: 'MANUAL_INTERRUPTED' });
    expect(f.calls()).toBe(0);
    let attempts = 0;
    const broken = new ManualPlanning({ database: f.database, context: async () => { attempts++; throw new Error('private provider detail'); } });
    const other = { ...f.input, event_id: randomUUID() };
    for (let n = 0; n < 2; n++) await expect(broken.start(f.owner, other)).rejects.toMatchObject({ code: 'MANUAL_CREATION_FAILED' });
    expect(attempts).toBe(1);
  } finally { await f.cleanup(); }
});
run('rolls back checkpoint and saved draft together after a real SQL constraint failure', async () => {
  const f = await fixture(), constraint = `manual_reject_${randomUUID().replaceAll('-', '')}`;
  try {
    await f.database.pool.query(`ALTER TABLE saved_user_conditions ADD CONSTRAINT ${constraint} CHECK(owner <> '${f.owner}')`);
    await expect(f.manual.start(f.owner, f.input)).rejects.toMatchObject({ code: 'MANUAL_CREATION_FAILED' });
    const rows = await f.database.pool.query('SELECT state FROM planning_owners WHERE owner=$1', [f.owner]);
    expect(rows.rows[0].state.checkpoint.records).toEqual([]);
    expect(rows.rows[0].state.receipts[`manual:${f.input.event_id}`].status).toBe('failed');
    expect((await f.database.pool.query('SELECT 1 FROM saved_user_conditions WHERE owner=$1', [f.owner])).rowCount).toBe(0);
  } finally {
    await f.database.pool.query(`ALTER TABLE saved_user_conditions DROP CONSTRAINT IF EXISTS ${constraint}`); await f.cleanup();
  }
});
run('manual HTTP routes require authentication, are not cached and return a real persisted draft', async () => {
  const f = await fixture(), app = Fastify(), activated: string[] = [];
  registerManualPlanning(app, f.manual, request => request.headers['x-test-auth'] === 'synthetic' ? f.owner : null,
    async (_owner, view) => { activated.push(view.id); });
  try {
    for (const suffix of ['options', 'requests']) expect((await app.inject({ method: 'POST', url: `/api/planning/manual/${suffix}`, payload: {} })).statusCode).toBe(401);
    const options = await app.inject({ method: 'POST', url: '/api/planning/manual/options', headers: { 'x-test-auth': 'synthetic' },
      payload: { locality_token: 'synthetic' } });
    expect(options.statusCode).toBe(200); expect(options.headers['cache-control']).toBe('no-store');
    expect(options.json().categories.map((c: any) => c.id).sort()).toEqual(['100', '200']);
    const created = await app.inject({ method: 'POST', url: '/api/planning/manual/requests', headers: { 'x-test-auth': 'synthetic' }, payload: f.input });
    expect(created.statusCode).toBe(200); expect(created.headers['cache-control']).toBe('no-store');
    expect(activated).toEqual([created.json().id]); expect(created.json().issues).toContainEqual({ code: 'ORIGIN_REQUIRED', field: 'points.origin' });
  } finally { await app.close(); await f.cleanup(); }
});
