import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { PlanningSessions, type PlanningContext } from './planning-sessions.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { registerPlanningRoutes } from './planning-routes.js';
import { projectSavedConditions } from './saved-conditions.js';
import { changesFor } from '../shared/planning-edits.js';
import { orderWithoutActivity } from '../shared/activity-order.js';

function setup() {
  const fixture = planningFixture();
  const context: PlanningContext = { catalog: { ...fixture.input.catalog, leaf_ids: ['100', '200', '300'],
    category_names: { '100': 'Музеи', '200': 'Кафе', '300': 'Набережные', '999': 'Не лист' } },
    visit_policy: { ...fixture.input.visit_policy, by_category: { '100': 60, '200': 45, '300': 30 }, walkable_category_ids: ['300'] },
    modes: ['walking', 'driving'], data_mode: 'test' };
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => { throw new Error('Editing must not plan'); } });
  const view = sessions.create('owner', fixture.input.intent, context);
  const day = view.draft.days[0]!;
  return { sessions, view, context, day };
}
const event = (version: number, changes: unknown[], event_id = 'activity-edit-001') => ({ base_version: version, event_id, changes });
const addition = (version: string, activity_id = 'new-food') => ({ activity_id, catalog_version: version,
  choice: { kind: 'place', category_ids: ['200'] } });

describe('atomic activity editing', () => {
  it('adds food, replaces an activity, preserves other constraints and replays exactly once', () => {
    const { sessions, view, context, day } = setup();
    const remove = day.activities[0]!.id;
    const body = event(view.version, [{ op: 'activities', day_id: day.day_id, remove_ids: [remove],
      additions: [addition(context.catalog.version)] }]);
    const edited = sessions.edit('owner', view.id, body);
    const expected = structuredClone(view.draft); expected.days[0]!.activities.shift();
    expect(edited.draft.shared).toEqual(view.draft.shared);
    expect(edited.draft.points).toEqual(view.draft.points);
    expect(edited.draft.days[0]!.date).toBe(day.date);
    expect(edited.draft.days[0]!.window).toEqual(day.window);
    expect(edited.draft.days[0]!.activities.slice(0, -1)).toEqual(expected.days[0]!.activities);
    expect(edited.draft.days[0]!.activities.at(-1)).toMatchObject({ id: 'new-food', label: 'Кафе', intent_kind: 'place_visit',
      selection: { category_policy: 'named_types_only', named_types: ['Кафе'] }, categories: { include_any: ['200'] } });
    expect(edited).toMatchObject({ phase: 'DRAFT', confirmed_version: null, result: null, version: view.version + 1 });
    expect(sessions.edit('owner', view.id, body)).toEqual(edited);
    const saved = projectSavedConditions(edited, { now: demoNow() });
    expect(JSON.stringify(saved)).not.toMatch(/category_names|include_any|catalog_version/);
    expect(saved.days[0]!.activities.at(-1)!.selection.named_types).toEqual(['Кафе']);
  });
  it.each(['category', 'version', 'duplicate', 'facts', 'unknown-remove'])('rejects %s atomically', kind => {
    const { sessions, view, context, day } = setup();
    const add = addition(context.catalog.version);
    const change = { op: 'activities', day_id: day.day_id, remove_ids: [] as string[], additions: [add] };
    if (kind === 'category') add.choice.category_ids = ['999'];
    if (kind === 'version') add.catalog_version = 'outdated';
    if (kind === 'duplicate') add.activity_id = day.activities[0]!.id;
    if (kind === 'facts') Object.assign(add.choice, { label: 'Fake price', price: 0 });
    if (kind === 'unknown-remove') change.remove_ids.push('not-existing');
    expect(() => sessions.edit('owner', view.id, event(view.version, [{ op: 'budget', value: { kind: 'unlimited' } }, change]))).toThrow();
    expect(sessions.get('owner', view.id)).toEqual(view);
  });
  it('keeps A before C when removing the middle of a dependency chain', () => {
    const { sessions, view, context, day } = setup();
    const base = day.activities[0]!;
    const draft = structuredClone(view.draft);
    draft.days[0]!.activities = ['A', 'B', 'C'].map(id => ({ ...structuredClone(base), id }));
    draft.days[0]!.order = [['A', 'B'], ['B', 'C']];
    const created = sessions.create('owner', draft, context);
    const edited = sessions.edit('owner', created.id, event(created.version, [{ op: 'remove_activity', day_id: day.day_id, activity_id: 'B' }]));
    expect(edited.draft.days[0]!.order).toEqual([['A', 'C']]);
    const unordered = sessions.edit('owner', created.id, event(edited.version, [{ op: 'order', day_id: day.day_id,
      activity_ids: ['A', 'C'], precedence: [] }], 'remove-order-001'));
    expect(unordered.draft.days[0]!.order).toEqual([]);
    expect(unordered.draft.days[0]!.activities.map(a => a.id)).toEqual(['A', 'C']);
  });
  it('permits an empty day but prevents confirmation or planning', () => {
    const { sessions, view, day } = setup();
    const edited = sessions.edit('owner', view.id, event(view.version, [{ op: 'activities', day_id: day.day_id,
      remove_ids: day.activities.map(a => a.id), additions: [] }]));
    expect(edited.issues.map(i => i.code)).toContain('ACTIVITIES_REQUIRED');
    expect(() => sessions.confirm('owner', view.id, { base_version: edited.version, event_id: 'confirm-empty-001' })).toThrow('INCOMPLETE_DRAFT');
  });
  it('roundtrips the browser diff without losing partial precedence or imposing order on unrelated activities', () => {
    const { sessions, view, context } = setup();
    const draft = structuredClone(view.draft), day = draft.days[0]!, base = day.activities[0]!;
    day.activities = ['A', 'B', 'C'].map(id => ({ ...structuredClone(base), id })); day.order = [['A', 'B']];
    const before = sessions.create('owner', draft, context), edited = structuredClone(before.draft);
    edited.days[0]!.activities.push({ ...structuredClone(base), id: 'new-museum' });
    edited.days[0]!.order.push(['B', 'new-museum'], ['C', 'new-museum']);
    const after = sessions.edit('owner', before.id, event(before.version, changesFor(before, edited)));
    expect(after.draft.days[0]!.order).toEqual(edited.days[0]!.order);
    expect(after.draft.days[0]!.order).not.toContainEqual(['B', 'C']);
    const removed = structuredClone(after.draft);
    removed.days[0]!.activities = removed.days[0]!.activities.filter(a => a.id !== 'B');
    removed.days[0]!.order = orderWithoutActivity(removed.days[0]!.order, 'B');
    expect(sessions.edit('owner', before.id, event(after.version, changesFor(after, removed), 'remove-roundtrip')).draft.days[0]!.order)
      .toEqual([['C', 'new-museum'], ['A', 'new-museum']]);
  });
  it('rejects stale writes, cycles, duplicate additions and walking on a driving route without partial edits', () => {
    const { sessions, view, day, context } = setup();
    for (const changes of [
      [{ op: 'activities', day_id: day.day_id, remove_ids: [], additions: [addition(context.catalog.version), addition(context.catalog.version)] }],
      [{ op: 'order', day_id: day.day_id, activity_ids: day.activities.map(a => a.id), precedence: [[day.activities[0]!.id, day.activities[0]!.id]] }],
      [{ op: 'activities', day_id: day.day_id, remove_ids: [], additions: [{ activity_id: 'new-walk', catalog_version: context.catalog.version, choice: { kind: 'walk' } }] }, { op: 'mobility', mode: 'driving' }],
    ]) {
      expect(() => sessions.edit('owner', view.id, event(view.version, changes))).toThrow();
      expect(sessions.get('owner', view.id)).toEqual(view);
    }
    expect(() => sessions.edit('owner', view.id, event(view.version + 1, [{ op: 'budget', value: { kind: 'unlimited' } }]))).toThrow('STALE_VERSION');
  });
  it('old checkpoints allow removals while declining unsupported category additions', () => {
    const { sessions, view, context, day } = setup(); delete context.catalog.category_names;
    const old = sessions.create('owner', view.draft, context);
    expect(() => sessions.activityOptions('owner', old.id)).toThrow('ACTIVITY_OPTIONS_UNAVAILABLE');
    expect(sessions.edit('owner', old.id, event(old.version, [{ op: 'activities', day_id: day.day_id,
      remove_ids: [day.activities[0]!.id], additions: [] }])).version).toBe(old.version + 1);
  });
  it('options use the trusted draft catalog, require ownership, and never expose the checkpoint', async () => {
    const { sessions, view } = setup();
    const app = Fastify(); registerPlanningRoutes(app, sessions, request => typeof request.headers['x-qa-owner'] === 'string' ? request.headers['x-qa-owner'] : null);
    try {
      const url = `/api/planning/drafts/${view.id}/activity-options`;
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { 'x-qa-owner': 'other' } })).statusCode).toBe(404);
      const response = await app.inject({ url, headers: { 'x-qa-owner': 'owner' } });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().categories.map((c: { id: string }) => c.id).sort()).toEqual(['100', '200', '300']);
      expect(response.body).not.toMatch(/checkpoint|point_area|owner/);
      expect(sessions.get('owner', view.id)).toEqual(view);
    } finally { await app.close(); }
  });
});
