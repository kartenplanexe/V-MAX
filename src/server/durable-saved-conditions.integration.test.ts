import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { PlanningDatabase } from './planning-database.js';
import { DurablePlanning } from './durable-planning.js';
import { intentFixture } from './intent-start.fixture.js';
import { planningFixture } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';
import { InitialIntentError } from './intent-start.js';

const run = it.skipIf(!process.env.TEST_DATABASE_URL);
async function fixture() {
  let instant = new Date('2026-09-24T09:00:00Z');
  const now = () => new Date(instant), owner = 'saved-integration:' + randomUUID();
  const database = PlanningDatabase.connect(process.env.TEST_DATABASE_URL!, undefined, { now });
  await database.migrate(); await database.migrate();
  const intent = intentFixture(), places = planningFixture();
  let modelCalls = 0, contextCalls = 0, fresh = false;
  const options = { database, now,
    context: async () => {
      contextCalls++;
      if (!fresh) return { ...intent.context, now: now().toISOString(), planning: {
        catalog: { ...places.input.catalog, category_names: { '100': 'Музеи', '200': 'Кафе' } }, visit_policy: places.input.visit_policy,
        point_area: { south: 55, north: 56, west: 37, east: 38 }, modes: ['walking'] as const, data_mode: 'test' as const } };
      return { now: now().toISOString(), locality: { ...intent.context.locality, id: 'fresh-city', region_id: 'fresh-region' },
        catalog: { ...intent.context.catalog, version: 'fresh-catalog', region_id: 'fresh-region', rows: [['fresh-cafe', 'Кафе', []]] as [string, string, string[]][] },
        planning: { catalog: { version: 'fresh-catalog', region_id: 'fresh-region', leaf_ids: ['fresh-cafe'] },
          visit_policy: { version: 'fresh-policy', by_category: { 'fresh-cafe': 45 }, arrival_buffer_minutes: 5 },
          point_area: { south: 55, north: 56, west: 37, east: 38 }, modes: ['walking'] as const, data_mode: 'test' as const } };
    },
    provider: async () => { modelCalls++; return intent.response; },
    plan: (job: Record<string, unknown>) => planPlacesWithDgis(places.client(), job, { retrieval: { radiusMeters: 5000 }, dataMode: 'test', now }),
  };
  const planning = new DurablePlanning(options);
  async function create() {
    const result = await planning.start(owner, { event_id: randomUUID(), user_text: intent.text, locality_token: 'synthetic-city' });
    if (result.status !== 'draft') throw new Error('Expected draft');
    return planning.edit(owner, result.view.id, { event_id: randomUUID(), base_version: result.view.version, changes: [
      { op: 'window', day_ids: ['day-1'], start: '17:00', end: '20:00' },
      { op: 'party', total: 2 },
      { op: 'budget', value: { kind: 'unlimited' } },
      { op: 'remove_activity', day_id: 'day-1', activity_id: 'day-1-activity-1' },
      { op: 'point', field: 'origin', point: { lat: 55.75, lon: 37.62, label: 'Must not persist this point label', source: 'user_map' } },
    ] });
  }
  return { database, owner, options, planning, create, now,
    advance: (ms: number) => { instant = new Date(instant.getTime() + ms); },
    fresh: () => { fresh = true; }, calls: () => ({ modelCalls, contextCalls }),
    cleanup: async () => { await database.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]);
      await database.pool.query('DELETE FROM saved_user_conditions WHERE owner=$1', [owner]); await database.pool.end(); },
  };
}

run('persists chosen radius across restart and expiry, restores it without another model call', async () => {
  const f = await fixture();
  try {
    const before = await f.create();
    const edited = await f.planning.edit(f.owner, before.id, { event_id: randomUUID(), base_version: before.version,
      changes: [{ op: 'search_radius', meters: 12000 }] });
    const restarted = new DurablePlanning(f.options);
    expect((await restarted.get(f.owner, before.id)).draft.shared.search_radius_meters).toBe(12000);
    f.advance(1_801_000);
    const saved = await restarted.getSaved(f.owner, before.id);
    expect(saved.conditions.shared.search_radius_meters).toBe(12000);
    expect(saved.conditions.provenance['shared.search_radius_meters']).toBe('user_form');
    expect(saved.conditions.days[0]!.order).toEqual(edited.draft.days[0]!.order);
    const restored = await restarted.restore(f.owner, before.id, { event_id: randomUUID(), base_revision: saved.revision, locality_token: 'synthetic-city' });
    expect(restored.draft.shared.search_radius_meters).toBe(12000);
    expect(restored.confirmed_version).toBeNull(); expect(f.calls().modelCalls).toBe(1);
  } finally { await f.cleanup(); }
});

run('persists activity edits and exact precedence atomically across coordinator restart without another model or catalog call', async () => {
  const f = await fixture();
  try {
    const before = await f.create(), counts = f.calls(), options = await f.planning.activityOptions(f.owner, before.id);
    const day = before.draft.days[0]!, id = 'added-museum';
    const body = { base_version: before.version, event_id: randomUUID(), changes: [
      { op: 'activities', day_id: day.day_id, remove_ids: [], additions: [{ activity_id: id,
        catalog_version: options.catalog_version, choice: { kind: 'place', category_ids: ['100'] } }] },
      { op: 'order', day_id: day.day_id, activity_ids: [...day.activities.map(a => a.id), id], precedence: [[day.activities[0]!.id, id]] },
    ] };
    const edited = await f.planning.edit(f.owner, before.id, body), restarted = new DurablePlanning(f.options);
    expect(await restarted.get(f.owner, before.id)).toEqual(edited);
    expect(await restarted.edit(f.owner, before.id, body)).toEqual(edited);
    const saved = await restarted.getSaved(f.owner, before.id);
    expect(saved.conditions.days[0]!.activities.at(-1)!.label).toBe('Музеи');
    expect(saved.conditions.days[0]!.order).toEqual([[day.activities[0]!.id, id]]);
    expect(edited.draft.shared).toEqual(before.draft.shared);
    expect(edited.draft.points).toEqual(before.draft.points);
    expect(f.calls()).toEqual(counts);
    await expect(restarted.activityOptions(f.owner + ':foreign', before.id)).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  } finally { await f.cleanup(); }
});

run('retains edited own conditions after provider TTL and restores the same id against fresh catalog without an LLM', async () => {
  const f = await fixture();
  try {
    const edited = await f.create(), original = await f.planning.getSaved(f.owner, edited.id);
    expect(original.conditions.days[0]?.window).toEqual({ start: '17:00', end: '20:00' });
    expect(original.conditions.days[0]?.activities.map(a => a.label)).toEqual(['кафе']);
    expect(original.conditions.shared.party?.total).toBe(2);
    expect(JSON.stringify(original)).not.toMatch(/catalog_version|region_id|locality_id|Must not persist|"result"/u);
    const confirmed = await f.planning.confirm(f.owner, edited.id, { event_id: randomUUID(), base_version: edited.version });
    const result = await f.planning.calculate(f.owner, edited.id, { event_id: randomUUID(), base_version: confirmed.version });
    expect(result.result?.status).toBe('AVAILABLE');
    f.advance(301_000);
    const expiredResult = await f.planning.get(f.owner, edited.id);
    expect(expiredResult.version).toBeGreaterThan(confirmed.version);
    const seen = await f.planning.getSaved(f.owner, edited.id);
    expect(seen.revision).toBe(expiredResult.version);
    expect(seen.expires_at).toBe(original.expires_at);
    expect(seen.conditions.updated_at).toBe(original.conditions.updated_at);
    f.advance(1_501_000);
    await expect(f.planning.get(f.owner, edited.id)).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    const saved = await new DurablePlanning(f.options).getSaved(f.owner, edited.id);
    expect(saved.conditions.days).toEqual(original.conditions.days);
    expect(f.calls()).toEqual({ modelCalls: 1, contextCalls: 1 });
    f.fresh();
    const request = { event_id: randomUUID(), base_revision: saved.revision, locality_token: 'fresh-synthetic-city' };
    const restored = await f.planning.restore(f.owner, edited.id, request);
    expect(restored.id).toBe(edited.id); expect(restored.version).toBeGreaterThan(saved.revision);
    expect(restored.phase).toBe('DRAFT'); expect(restored.confirmed_version).toBeNull(); expect(restored.result).toBeNull();
    expect(restored.draft.days[0]?.activities[0]?.categories).toMatchObject({ include_any: ['fresh-cafe'], catalog_version: 'fresh-catalog', region_id: 'fresh-region' });
    expect(restored.draft.points.origin?.locality_id).toBe('fresh-city');
    expect(restored.draft.days[0]?.date).toBe(original.conditions.days[0]?.date);
    expect((await f.planning.restore(f.owner, edited.id, request)).version).toBe(restored.version);
    expect(f.calls()).toEqual({ modelCalls: 1, contextCalls: 2 });
    await expect(f.planning.edit(f.owner, edited.id, { event_id: randomUUID(), base_version: expiredResult.version,
      changes: [{ op: 'party', total: 99 }] })).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await expect(f.planning.restore(f.owner, edited.id, { ...request, event_id: randomUUID() })).rejects.toMatchObject({ code: 'SAVED_CONDITIONS_STALE' });
    expect((await f.planning.getSaved(f.owner, edited.id)).expires_at).toBe(original.expires_at);
  } finally { await f.cleanup(); }
}, 60_000);

run('does not extend saved TTL on reads, repeated unchanged edits or recovery; expires and deletes by owner', async () => {
  const f = await fixture();
  try {
    const view = await f.create(), saved = await f.planning.getSaved(f.owner, view.id);
    f.advance(1_000);
    await f.planning.edit(f.owner, view.id, { event_id: randomUUID(), base_version: view.version, changes: [{ op: 'party', total: 2 }] });
    expect((await f.planning.getSaved(f.owner, view.id)).expires_at).toBe(saved.expires_at);
    await expect(f.planning.getSaved(f.owner + ':other', view.id)).rejects.toMatchObject({ code: 'SAVED_CONDITIONS_NOT_FOUND', status: 404 });
    await expect(f.planning.remove(f.owner + ':other', view.id)).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND', status: 404 });
    f.advance(1_801_000);
    await f.planning.remove(f.owner, view.id);
    await expect(f.planning.getSaved(f.owner, view.id)).rejects.toMatchObject({ code: 'SAVED_CONDITIONS_NOT_FOUND' });
    const other = await f.create();
    f.advance(30 * 86_400_000);
    await expect(f.planning.getSaved(f.owner, other.id)).rejects.toMatchObject({ code: 'SAVED_CONDITIONS_NOT_FOUND' });
  } finally { await f.cleanup(); }
});

run('rolls back the edited checkpoint when saving own conditions fails', async () => {
  const f = await fixture(), constraint = 'synthetic_saved_failure_' + randomUUID().replaceAll('-', '');
  try {
    const view = await f.create();
    // A real SQL constraint failure exercises the atomic boundary, not a mocked repository.
    await f.database.pool.query(`ALTER TABLE saved_user_conditions ADD CONSTRAINT ${constraint}
      CHECK (owner <> '${f.owner}' OR (conditions->'shared'->'party'->>'total')::integer <> 99) NOT VALID`);
    await expect(f.planning.edit(f.owner, view.id, { event_id: randomUUID(), base_version: view.version,
      changes: [{ op: 'party', total: 99 }] })).rejects.toBeDefined();
    expect((await f.planning.get(f.owner, view.id)).draft.shared.party?.total).toBe(2);
    expect((await f.planning.getSaved(f.owner, view.id)).conditions.shared.party?.total).toBe(2);
  } finally { await f.database.pool.query(`ALTER TABLE saved_user_conditions DROP CONSTRAINT IF EXISTS ${constraint}`); await f.cleanup(); }
});

run('only prolongs retention for changed own conditions and keeps restore failures typed and replayable', async () => {
  const f = await fixture();
  try {
    const view = await f.create(), original = await f.planning.getSaved(f.owner, view.id);
    f.advance(10_000);
    const edited = await f.planning.edit(f.owner, view.id, { event_id: randomUUID(), base_version: view.version,
      changes: [{ op: 'party', total: 3 }] });
    const latest = await f.planning.getSaved(f.owner, view.id);
    expect(new Date(latest.expires_at).getTime() - new Date(original.expires_at).getTime()).toBe(10_000);
    expect(latest.conditions.conditions_revision).toBe(edited.version);
    const failing = new DurablePlanning({ ...f.options, context: async () => { throw new InitialIntentError('LOCALITY_CHOICE_EXPIRED', 422); } });
    const request = { event_id: randomUUID(), base_revision: latest.revision, locality_token: 'expired-synthetic-token' };
    await expect(failing.restore(f.owner, view.id, request)).rejects.toMatchObject({ code: 'LOCALITY_CHOICE_EXPIRED', status: 422 });
    await expect(failing.restore(f.owner, view.id, request)).rejects.toMatchObject({ code: 'LOCALITY_CHOICE_EXPIRED', status: 422 });
    await expect(failing.restore(f.owner, view.id, { ...request, locality_token: 'different-token' })).rejects.toMatchObject({ code: 'EVENT_CONFLICT' });
    expect((await f.planning.getSaved(f.owner, view.id)).expires_at).toBe(latest.expires_at);
    expect((await f.planning.get(f.owner, view.id)).version).toBe(edited.version);
  } finally { await f.cleanup(); }
});

run('retains only address input for a provider point and clears obsolete queries after explicit manual replacement', async () => {
  const f = await fixture();
  try {
    let view = await f.create();
    await f.database.withOwner(f.owner, async (state, save) => {
      state.chat = { seen: {}, pending: { kind: 'origin_address', draftId: view.id, query: 'Авторский адрес 123' } }; await save();
    });
    const addressEvent = { event_id: randomUUID(), base_version: view.version, changes: [
      { op: 'point', field: 'origin', point: { lat: 55.751, lon: 37.621, label: 'Provider geocoder label', source: 'place_choice' } },
    ] };
    view = await f.planning.edit(f.owner, view.id, addressEvent);
    const address = await f.planning.getSaved(f.owner, view.id);
    expect(address.conditions.queries.origin).toBe('Авторский адрес 123');
    expect(address.conditions.points.origin).toBeUndefined();
    expect(JSON.stringify(address)).not.toMatch(/55\.751|37\.621|Provider geocoder label/u);
    view = await f.planning.edit(f.owner, view.id, { event_id: randomUUID(), base_version: view.version, changes: [
      { op: 'point', field: 'origin', point: { lat: 55.752, lon: 37.622, label: 'Own map point', source: 'user_map' } },
    ] });
    const manual = await f.planning.getSaved(f.owner, view.id);
    expect(manual.conditions.queries.origin).toBeUndefined();
    expect(manual.conditions.points.origin).toMatchObject({ lat: 55.752, lon: 37.622, source: 'user_map' });
    // Replaying an old address action must not overwrite the latest saved query.
    await f.planning.edit(f.owner, view.id, addressEvent);
    expect(await f.planning.getSaved(f.owner, view.id)).toEqual(manual);
  } finally { await f.cleanup(); }
});

run('does not renew expired provider checkpoints when saving a new greeting receipt', async () => {
  const f = await fixture();
  try {
    const view = await f.create();
    f.advance(29 * 60_000);
    await f.planning.get(f.owner, view.id);
    f.advance(2 * 60_000);
    await f.planning.start(f.owner, { event_id: randomUUID(), user_text: 'Привет', locality_token: 'unused' });
    const row = await f.database.pool.query('SELECT state FROM planning_owners WHERE owner=$1', [f.owner]);
    expect(row.rows[0].state.checkpoint.records).toEqual([]);
    expect((await f.planning.getSaved(f.owner, view.id)).conditions.shared.party?.total).toBe(2);
  } finally { await f.cleanup(); }
});

run('rolls back checkpoint creation and restoration when the snapshot transaction fails', async () => {
  const f = await fixture(), constraint = 'synthetic_restore_failure_' + randomUUID().replaceAll('-', '');
  const failedOwner = f.owner + ':failed-start';
  try {
    const view = await f.create(), saved = await f.planning.getSaved(f.owner, view.id);
    await f.database.pool.query(`ALTER TABLE saved_user_conditions ADD CONSTRAINT ${constraint}
      CHECK (owner <> '${failedOwner}' AND (owner <> '${f.owner}' OR revision <= ${view.version})) NOT VALID`);
    const restoreRequest = { event_id: randomUUID(), base_revision: saved.revision, locality_token: 'synthetic-context' };
    await expect(f.planning.restore(f.owner, view.id, restoreRequest)).rejects.toMatchObject({ code: 'SAVED_RESTORE_FAILED', status: 503 });
    expect((await f.planning.get(f.owner, view.id)).version).toBe(view.version);
    expect(await f.planning.getSaved(f.owner, view.id)).toEqual(saved);
    const callsAfterFailure = f.calls();
    await expect(f.planning.restore(f.owner, view.id, restoreRequest)).rejects.toMatchObject({ code: 'SAVED_RESTORE_FAILED', status: 503 });
    expect(f.calls()).toEqual(callsAfterFailure);
    const intent = intentFixture(), startRequest = { event_id: randomUUID(), user_text: intent.text, locality_token: 'synthetic-context' };
    await expect(f.planning.start(failedOwner, startRequest)).rejects.toBeDefined();
    const row = await f.database.pool.query('SELECT state FROM planning_owners WHERE owner=$1', [failedOwner]);
    expect(row.rows[0].state.checkpoint.records).toEqual([]);
    expect((await f.database.pool.query('SELECT 1 FROM saved_user_conditions WHERE owner=$1', [failedOwner])).rowCount).toBe(0);
  } finally {
    await f.database.pool.query(`ALTER TABLE saved_user_conditions DROP CONSTRAINT IF EXISTS ${constraint}`);
    await f.database.pool.query('DELETE FROM planning_owners WHERE owner=$1', [failedOwner]);
    await f.cleanup();
  }
});
