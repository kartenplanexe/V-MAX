import { expect, it } from 'vitest';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';
import { PlanningSessions } from './planning-sessions.js';
import { visitPolicy } from './live-geography.js';
import { normalizePublicTransport } from './dgis-public-transport.js';

const options = { retrieval: { radiusMeters: 5000 }, now: demoNow, dataMode: 'test' as const };
it('keeps ordinary places with unknown age classification, visibly uncertain, while preserving the child ages', async () => {
  const f = planningFixture();
  const result = await planPlacesWithDgis(f.client(), { ...f.input, intent: { ...f.input.intent,
    shared: { ...f.input.intent.shared, party: { total: 2, child_ages: [8] } } } }, options);
  expect(result.status).toBe('AVAILABLE');
  expect(JSON.stringify(result)).toContain('AGE_ELIGIBILITY_UNVERIFIED');
}, 30_000);
it('gives every supported catalog type a visit estimate instead of dropping a meal', async () => {
  const f = planningFixture(); f.input.intent.days[0]!.window.end = '20:00';
  const result = await planPlacesWithDgis(f.client(), { ...f.input,
    visit_policy: visitPolicy([{ id: '100', name: 'Музеи' }, { id: '200', name: 'Пиццерии' }]) }, options);
  expect(result.status).toBe('AVAILABLE');
  expect(JSON.stringify(result.days)).toContain('food');
}, 30_000);
it('isolates malformed optional provider attributes without losing other eligible places', async () => {
  const f = planningFixture(); Object.assign(f.items[0]!, { attribute_groups: [null] });
  f.input.intent.days[0]!.window.end = '20:00';
  const result = await planPlacesWithDgis(f.client(), f.input, options);
  expect(result.status).toBe('AVAILABLE');
  expect(result.warnings).toContain('RETRIEVAL_PARTIAL');
}, 30_000);
it('keeps multiple walking stops when a destination is specified', async () => {
  const f = planningFixture(), first = f.input.intent.days[0]!.activities[0]!;
  const intent = { ...f.input.intent, points: { ...f.input.intent.points, destination: { lat: 55.755, lon: 37.625, locality_id: 'mow' } },
    days: [{ ...f.input.intent.days[0]!, window: { start: '16:00', end: '22:00' },
      activities: [{ ...first, intent_kind: 'route_walk', label: 'Прогулка' }], order: [] }] };
  const sessions = new PlanningSessions({ now: demoNow, plan: job => planPlacesWithDgis(f.client(), job, options) });
  const view = sessions.create('synthetic-owner', intent, { catalog: f.input.catalog,
    visit_policy: { ...f.input.visit_policy, walkable_category_ids: ['100'] }, modes: ['walking'], data_mode: 'test' });
  const confirmed = sessions.confirm('synthetic-owner', view.id, { base_version: view.version, event_id: 'audit-confirm' });
  const result = await sessions.calculate('synthetic-owner', view.id, { base_version: confirmed.version, event_id: 'audit-calculate' });
  expect(result.result?.days[0]?.visits.length).toBeGreaterThan(1);
}, 30_000);
it('requires an explicit decision to discard an unsupported condition and invalidates confirmation', () => {
  const f = planningFixture();
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => { throw Error('Unexpected provider'); } });
  const view = sessions.create('owner', { ...f.input.intent, clarifications: [{ id: 'question', field: 'requirements',
    day_ids: ['d1'], text: 'без ступенек', reason: 'not_representable' }] },
  { catalog: f.input.catalog, visit_policy: f.input.visit_policy, modes: ['walking'], data_mode: 'test' });
  expect(() => sessions.confirm('owner', view.id, { base_version: 0, event_id: 'before-discard' })).toThrow('INCOMPLETE_DRAFT');
  const changed = sessions.edit('owner', view.id, { base_version: 0, event_id: 'explicit-discard', changes: [
    { op: 'discard_clarification', clarification_id: 'question' }] });
  expect(changed.draft.clarifications).toBeUndefined();
  expect(changed.draft.days).toEqual(view.draft.days);
  expect(changed.confirmed_version).toBeNull();
});
it('rejects total transit time shorter than a known moving stage', () => {
  expect(() => normalizePublicTransport([{ total_duration: 60, total_distance: 100, pedestrian: false,
    transfer_count: 0, crossing_count: 0, movements: [{ type: 'passage', moving_duration: 1200, waiting_duration: 0 }] }],
  { from: { lat: 55.75, lon: 37.62 }, to: { lat: 55.7501, lon: 37.6201 } })).toThrow();
});
