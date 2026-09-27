import { expect, it } from 'vitest';
import { FormDraft } from '../shared/planning-form.js';
import { changesFor } from '../shared/planning-edits.js';
import { PlanningSessions } from './planning-sessions.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';

const options = { retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test' as const, now: demoNow };
it('applies an explicit radius to provider requests and independently excludes out-of-radius candidates', async () => {
  const f = planningFixture(); Object.assign(f.input.intent.shared, { search_radius_meters: 100 });
  const result = await planPlacesWithDgis(f.client(), f.input, options);
  expect(result.search_scope?.radius_meters).toBe(100);
  expect(result.days.every(day => day.visits.length === 0)).toBe(true);
  expect(result.status).toBe('UNAVAILABLE');
  const places = f.requests.filter(request => request.url.hostname === 'catalog.api.2gis.com');
  expect(places.length).toBeGreaterThan(0);
  expect(places.every(request => request.url.searchParams.get('radius') === '100')).toBe(true);
}, 30_000); // Real Python startup/solver work, like the other planner integration tests.
it('edits only radius, invalidates confirmation and keeps the same bound through calculation', async () => {
  const f = planningFixture();
  const sessions = new PlanningSessions({ now: demoNow, plan: job => planPlacesWithDgis(f.client(), job, options) });
  const context = { catalog: f.input.catalog, visit_policy: f.input.visit_policy, modes: ['walking'] as const, data_mode: 'test' as const };
  const initial = sessions.create('radius-owner', f.input.intent, context);
  const confirmed = sessions.confirm('radius-owner', initial.id, { event_id: 'radius-confirm-first', base_version: initial.version });
  const changed = sessions.edit('radius-owner', initial.id, { event_id: 'radius-edit-first', base_version: confirmed.version,
    changes: [{ op: 'search_radius', meters: 1000 }] });
  expect(changed.confirmed_version).toBeNull(); expect(changed.result).toBeNull();
  expect(changed.draft).toEqual({ ...initial.draft, shared: { ...initial.draft.shared, search_radius_meters: 1000 } });
  expect(changed.provenance['shared.search_radius_meters']).toBe('user_form');
  expect(changesFor(initial, changed.draft)).toEqual([{ op: 'search_radius', meters: 1000 }]);
  const accepted = sessions.confirm('radius-owner', initial.id, { event_id: 'radius-confirm-new', base_version: changed.version });
  const planned = await sessions.calculate('radius-owner', initial.id, { event_id: 'radius-plan-new', base_version: accepted.version });
  expect(planned.result?.status).toBe('AVAILABLE');
  expect(planned.result?.search_scope?.radius_meters).toBe(1000);
  expect(planned.draft.days[0]!.order).toEqual(initial.draft.days[0]!.order);
}, 30_000);
it.each([0, -1, 50_001, 1.5, '5000', null])('rejects invalid radius %s at the shared boundary', radius => {
  const f = planningFixture(); Object.assign(f.input.intent.shared, { search_radius_meters: radius });
  expect(FormDraft.safeParse(f.input.intent).success).toBe(false);
});
