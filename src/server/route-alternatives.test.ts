import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { PlanningSessions } from './planning-sessions.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';
import { AlternativePreviewSchema } from '../shared/route-alternatives.js';
import { alternativeDelta, planFreshUntil } from './route-alternatives.js';

const event = (version: number) => ({ event_id: randomUUID(), base_version: version });
async function fixture() {
  const places = planningFixture(); let instant = demoNow(), calls = 0;
  places.input.intent.days[0]!.window.end = '20:00';
  const now = () => new Date(instant);
  const plan = async (job: Record<string, unknown>) => { calls++; return planPlacesWithDgis(places.client(), job,
    { retrieval: { radiusMeters: 5000 }, dataMode: 'test', now }); };
  const options = { now, plan };
  const sessions = new PlanningSessions(options);
  const draft = sessions.create('owner', places.input.intent, { catalog: places.input.catalog,
    visit_policy: places.input.visit_policy, modes: ['walking'], data_mode: 'test' });
  const confirmed = sessions.confirm('owner', draft.id, event(draft.version));
  const view = await sessions.calculate('owner', draft.id, event(confirmed.version));
  const body = { ...event(view.version), day_id: 'd1', activity_id: 'culture', place_id: 'near' };
  return { places, options, sessions, view, body, calls: () => calls, advance: (ms: number) => { instant = new Date(+instant + ms); } };
}

it('previews one fresh verified replacement, preserves neighbors, and applies exactly that plan without another request', async () => {
  const f = await fixture(), beforeHttp = f.places.requests.length;
  const preview = AlternativePreviewSchema.parse(await f.sessions.previewAlternative('owner', f.view.id, f.body));
  expect(preview.alternatives).toHaveLength(1);
  const alternative = preview.alternatives[0]!;
  expect(alternative.result.days[0]!.visits.map(v => v.place_id)).toEqual(['far', 'cafe']);
  expect(alternative.delta).toEqual({ ends_at_minutes: 80, travel_minutes: 80, expected_cost_minor: null });
  expect(f.places.requests.slice(beforeHttp).filter(r => r.url.hostname === 'catalog.api.2gis.com')).toHaveLength(2);
  expect(f.sessions.get('owner', f.view.id)).toEqual(f.view);
  expect(await f.sessions.previewAlternative('owner', f.view.id, f.body)).toEqual(preview);
  expect(f.calls()).toBe(2);

  const checkpoint = f.sessions.checkpoint();
  expect(JSON.stringify(checkpoint)).not.toMatch(/provider_batches|opening_intervals|candidate_pool|route_legs/);
  const second = new PlanningSessions({ ...f.options, checkpoint });
  const request = { ...event(f.view.version), alternative_id: alternative.id };
  const applied = second.applyAlternative('owner', f.view.id, request);
  expect(applied.result).toEqual(alternative.result);
  expect(applied.version).toBe(f.view.version + 1); expect(applied.confirmed_version).toBe(applied.version);
  expect(second.applyAlternative('owner', f.view.id, request)).toEqual(applied);
  expect(f.calls()).toBe(2);
  f.advance(301_000);
  expect(second.get('owner', f.view.id).result).toBeNull();
}, 30_000);

it('refuses stale, foreign and conflicting actions and never extends the original result TTL', async () => {
  const f = await fixture(); f.advance(240_000);
  await expect(f.sessions.previewAlternative('foreign', f.view.id, f.body)).rejects.toThrow('DRAFT_NOT_FOUND');
  await expect(f.sessions.previewAlternative('owner', f.view.id, { ...f.body, base_version: 0 })).rejects.toThrow('STALE_VERSION');
  const preview = await f.sessions.previewAlternative('owner', f.view.id, f.body);
  expect(Date.parse(preview.expires_at)).toBe(+demoNow() + 300_000);
  await expect(f.sessions.previewAlternative('owner', f.view.id, { ...f.body, place_id: 'cafe' })).rejects.toThrow('EVENT_CONFLICT');
  const alternative = preview.alternatives[0]!;
  f.advance(61_000);
  expect(() => f.sessions.applyAlternative('owner', f.view.id, { ...event(f.view.version), alternative_id: alternative.id })).toThrow('STALE_VERSION');
  expect(JSON.stringify(f.sessions.checkpoint())).not.toContain(alternative.id);
  expect(f.calls()).toBe(2);
}, 30_000);

it('invalidates a preview on editing and does not resurrect it on replay', async () => {
  const f = await fixture(), preview = await f.sessions.previewAlternative('owner', f.view.id, f.body);
  const updated = f.sessions.edit('owner', f.view.id, { ...event(f.view.version), changes: [{ op: 'party', total: 2 }] });
  await expect(f.sessions.previewAlternative('owner', f.view.id, f.body)).rejects.toThrow('ALTERNATIVE_EXPIRED');
  expect(() => f.sessions.applyAlternative('owner', f.view.id,
    { ...event(updated.version), alternative_id: preview.alternatives[0]!.id })).toThrow('ALTERNATIVE_EXPIRED');
  expect(f.calls()).toBe(2);
}, 30_000);

it('keeps the existing plan when a pinned neighbor disappears from fresh retrieval', async () => {
  const f = await fixture(); f.places.items.splice(f.places.items.findIndex(p => p.id === 'cafe'), 1);
  const preview = await f.sessions.previewAlternative('owner', f.view.id, f.body);
  expect(preview.alternatives).toEqual([]);
  expect(preview.issues).toContain('REPLACEMENT_CURRENT_PLACE_UNAVAILABLE');
  expect(f.sessions.get('owner', f.view.id)).toEqual(f.view);
}, 30_000);

it('loads old checkpoints without alternative data, refuses unknown targets before doing provider work', async () => {
  const f = await fixture();
  const sessions = new PlanningSessions({ ...f.options, checkpoint: f.sessions.checkpoint() });
  await expect(sessions.previewAlternative('owner', f.view.id, { ...f.body, place_id: 'unknown' })).rejects.toThrow('UNKNOWN_STOP');
  expect(f.calls()).toBe(1); expect(sessions.get('owner', f.view.id)).toEqual(f.view);
}, 30_000);

it('does not repeat a pending paid preview after process interruption', async () => {
  const f = await fixture();
  let release!: () => void, captured!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const checkpointReady = new Promise<void>(resolve => { captured = resolve; });
  const sessions = new PlanningSessions({ ...f.options, checkpoint: f.sessions.checkpoint(),
    beforePlan: async () => { captured(); await pending; } });
  const active = sessions.previewAlternative('owner', f.view.id, f.body);
  await checkpointReady;
  const restored = new PlanningSessions({ ...f.options, checkpoint: sessions.checkpoint() });
  await expect(restored.previewAlternative('owner', f.view.id, f.body)).rejects.toThrow('PLAN_INTERRUPTED');
  expect(f.calls()).toBe(1);
  release(); await active;
  expect(f.calls()).toBe(2);
}, 30_000);

it('bounds preview validity by geometry freshness and reports only known cost deltas', async () => {
  const f = await fixture(), result = structuredClone(f.view.result!);
  result.total_expected_cost_minor = 100_000;
  const next = structuredClone(result); next.total_expected_cost_minor = 125_000;
  expect(alternativeDelta(result, next, f.body).expected_cost_minor).toBe(25_000);
  next.total_expected_cost_minor = null;
  expect(alternativeDelta(result, next, f.body).expected_cost_minor).toBeNull();
  next.days[0]!.travel_segments = [{ from_id: '@origin', to_id: 'near', mode: 'walking', departure_utc: 1,
    coordinates: [[[37.62, 55.75], [37.621, 55.751]]], source: { provider: 'synthetic', data_mode: 'test',
      fetched_at: demoNow().toISOString(), valid_until: new Date(+demoNow() + 10_000).toISOString() } }];
  expect(planFreshUntil(next)).toBe(+demoNow() + 10_000);
}, 30_000);
