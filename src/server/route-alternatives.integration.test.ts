import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { DurablePlanning } from './durable-planning.js';
import { PlanningDatabase } from './planning-database.js';
import { intentFixture } from './intent-start.fixture.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';

const run = it.skipIf(!process.env.TEST_DATABASE_URL);
const event = (version: number) => ({ event_id: randomUUID(), base_version: version });
async function fixture() {
  const database = PlanningDatabase.connect(process.env.TEST_DATABASE_URL!, undefined, { now: demoNow });
  await database.migrate();
  const places = planningFixture(), intent = intentFixture(), owner = 'alternative-test:' + randomUUID();
  let modelCalls = 0, planCalls = 0;
  const options = { database, now: demoNow,
    context: async () => ({ ...intent.context, planning: { catalog: places.input.catalog, visit_policy: places.input.visit_policy,
      point_area: { south: 55, north: 56, west: 37, east: 38 }, modes: ['walking'] as const, data_mode: 'test' as const } }),
    provider: async () => { modelCalls++; return intent.response; },
    plan: async (job: Record<string, unknown>) => { planCalls++; return planPlacesWithDgis(places.client(), job,
      { retrieval: { radiusMeters: 5000 }, dataMode: 'test', now: demoNow }); },
  };
  const service = new DurablePlanning(options);
  const initial = await service.start(owner, { event_id: randomUUID(), user_text: intent.text, locality_token: 'synthetic-only' });
  if (initial.status !== 'draft') throw Error('Expected draft');
  const edited = await service.edit(owner, initial.view.id, { ...event(initial.view.version), changes: [
    { op: 'window', day_ids: ['day-1'], start: '16:00', end: '20:00' },
    { op: 'point', field: 'origin', point: { lat: 55.75, lon: 37.62, label: 'Own synthetic point', source: 'user_map' } },
  ] });
  const confirmed = await service.confirm(owner, edited.id, event(edited.version));
  const view = await service.calculate(owner, edited.id, event(confirmed.version));
  const body = { ...event(view.version), day_id: 'day-1', activity_id: 'day-1-activity-1', place_id: 'near' };
  return { database, owner, service, options, view, body, calls: () => ({ modelCalls, planCalls }), cleanup: async () => {
    await database.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]);
    await database.pool.query('DELETE FROM saved_user_conditions WHERE owner=$1', [owner]);
    await database.pool.end();
  } };
}

run('durably replays preview/apply across instances, keeps own-condition TTL and uses one fresh planner attempt', async () => {
  const f = await fixture();
  try {
    const savedBefore = await f.service.getSaved(f.owner, f.view.id);
    const preview = await f.service.previewAlternative(f.owner, f.view.id, f.body);
    expect(preview.alternatives).toHaveLength(1);
    const second = new DurablePlanning(f.options);
    expect(await second.previewAlternative(f.owner, f.view.id, f.body)).toEqual(preview);
    await expect(second.previewAlternative('foreign', f.view.id, f.body)).rejects.toThrow('DRAFT_NOT_FOUND');
    const apply = { ...event(f.view.version), alternative_id: preview.alternatives[0]!.id };
    const applied = await second.applyAlternative(f.owner, f.view.id, apply);
    expect(applied.result).toEqual(preview.alternatives[0]!.result);
    expect(await f.service.applyAlternative(f.owner, f.view.id, apply)).toEqual(applied);
    expect(f.calls()).toEqual({ modelCalls: 1, planCalls: 2 });
    const savedAfter = await second.getSaved(f.owner, f.view.id);
    expect(savedAfter.revision).toBe(applied.version);
    expect(savedAfter.conditions).toEqual(savedBefore.conditions);
    expect(savedAfter.expires_at).toBe(savedBefore.expires_at);
    expect(JSON.stringify(savedAfter)).not.toMatch(/Учебный музей|Учебное кафе|alternative|route_legs|candidate_pool/);
  } finally { await f.cleanup(); }
}, 40_000);

run('applies checkpoint and revision atomically; SQL rejection leaves the original and preview usable', async () => {
  const f = await fixture(), constraint = 'reject_alternative_' + randomUUID().replaceAll('-', '');
  try {
    const preview = await f.service.previewAlternative(f.owner, f.view.id, f.body);
    const own = await f.service.getSaved(f.owner, f.view.id);

    await f.database.pool.query(`ALTER TABLE planning_owners ADD CONSTRAINT ${constraint}
      CHECK (owner <> '${f.owner}' OR (state #>> '{checkpoint,records,0,view,version}')::int <= ${f.view.version})`);
    const apply = { ...event(f.view.version), alternative_id: preview.alternatives[0]!.id };
    await expect(f.service.applyAlternative(f.owner, f.view.id, apply)).rejects.toThrow();
    expect((await f.service.get(f.owner, f.view.id)).result).toEqual(f.view.result);
    expect(await f.service.getSaved(f.owner, f.view.id)).toEqual(own);
    await f.database.pool.query(`ALTER TABLE planning_owners DROP CONSTRAINT ${constraint}`);
    const applied = await f.service.applyAlternative(f.owner, f.view.id, apply);
    expect(applied.result).toEqual(preview.alternatives[0]!.result);
    expect(f.calls().planCalls).toBe(2);
  } finally {
    await f.database.pool.query(`ALTER TABLE planning_owners DROP CONSTRAINT IF EXISTS ${constraint}`);
    await f.cleanup();
  }
}, 40_000);

run('shares the existing global planner slots and rejects concurrent same-owner work before providers', async () => {
  const f = await fixture(), lease = await f.database.pool.connect();
  try {
    await lease.query('SELECT pg_advisory_lock(782011, 0), pg_advisory_lock(782011, 1)');
    await expect(f.service.previewAlternative(f.owner, f.view.id, f.body)).rejects.toThrow('PLANNER_BUSY');
    expect(f.calls().planCalls).toBe(1);
    await lease.query('SELECT pg_advisory_unlock_all()');
    await lease.query('SELECT pg_advisory_lock(hashtextextended($1, 782002))', [f.owner]);
    await expect(f.service.previewAlternative(f.owner, f.view.id, f.body)).rejects.toThrow('OPERATION_IN_PROGRESS');
    expect(f.calls().planCalls).toBe(1);
  } finally { await lease.query('SELECT pg_advisory_unlock_all()'); lease.release(); await f.cleanup(); }
}, 40_000);
