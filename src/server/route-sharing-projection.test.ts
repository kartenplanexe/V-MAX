import { expect, it } from 'vitest';
import { projectSharedConditions, projectSharedResult } from './route-sharing-projection.js';
import { projectSavedConditions } from './saved-conditions.js';
import { parseInitialIntent } from './intent-start.js';
import { intentFixture } from './intent-start.fixture.js';
import type { PlanningView } from '../shared/planning-form.js';

async function fixture() {
  const f = intentFixture();
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'share-fixture' }, async () => f.response);
  if (result.status !== 'draft') throw new Error('Expected draft');
  const view = { id: 'private-owner-draft', version: 3, phase: 'DRAFT', confirmed_version: null, expires_at: '2026-09-24T10:00:00Z',
    draft: result.draft, provenance: result.provenance, issues: [], capabilities: { modes: ['walking'], data_mode: 'test' }, result: null } as PlanningView;
  view.draft.points.origin = { lat: 55.75, lon: 37.62, locality_id: 'mow', source: 'user_map', label: 'PRIVATE home' };
  view.provenance['points.origin'] = 'user_map';
  const own = projectSavedConditions(view, { now: new Date('2026-09-24T09:00:00Z'), queries: { locality: 'PRIVATE query', destination: 'PRIVATE finish' } });
  return { own, view };
}
it('shares only own conditions, omits exact points by default and preserves required finish marker', async () => {
  const { own } = await fixture();
  const shared = projectSharedConditions(own, false);
  expect(shared.conditions.queries).toEqual({});
  expect(shared.conditions.points).toEqual({});
  expect(shared.omissions).toEqual(['origin', 'destination']);
  expect(shared.conditions.reconfirmation_required).toContainEqual({ code: 'POINT_RECONFIRM_REQUIRED', field: 'points.destination' });
  expect(shared.conditions.days[0]?.activities.map(a => a.label)).toEqual(['музей', 'кафе']);
  expect(JSON.stringify(shared)).not.toMatch(/PRIVATE|private-owner|37\.62|55\.75/u);
});
it('shares the chosen radius without disclosing the private center point', async () => {
  const { own } = await fixture();
  own.shared.search_radius_meters = 12000; own.provenance['shared.search_radius_meters'] = 'user_form';
  const shared = projectSharedConditions(own, false);
  expect(shared.conditions.shared.search_radius_meters).toBe(12000);
  expect(shared.conditions.provenance['shared.search_radius_meters']).toBe('user_form');
  expect(shared.conditions.points).toEqual({});
  expect(JSON.stringify(shared)).not.toMatch(/PRIVATE|private-owner|37\.62|55\.75/u);
});
it('explicit point inclusion retains only proven own coordinates and never provider labels or queries', async () => {
  const { own } = await fixture();
  const shared = projectSharedConditions(own, true);
  expect(shared.conditions.points.origin).toMatchObject({ lat: 55.75, lon: 37.62, source: 'user_map' });
  expect(shared.omissions).toEqual(['destination']);
  expect(JSON.stringify(shared)).not.toContain('PRIVATE');
  expect(() => projectSharedConditions({ ...own, provider_payload: {} }, true)).toThrow();
});
it('does not renew the exact result expiry or accept a result with unknown fact freshness', () => {
  const now = Date.parse('2026-09-24T09:00:00Z');
  const plan = { status: 'AVAILABLE', warnings: [], origin: { lat: 55.75, lon: 37.62, locality_id: 'mow' },
    days: [{ day_id: 'd', date: '2026-09-24', status: 'AVAILABLE', missing_activity_ids: [], visits: [{
      activity_id: 'a', place_id: 'p', name: 'Synthetic cafe', starts_at: 700, ends_at: 740,
      travel_before_minutes: 10, arrival_buffer_minutes: 5, price_expected_minor: null, warnings: [],
      source: { provider: 'test', fetched_at: new Date(now).toISOString(), valid_until: new Date(now + 600000).toISOString(), data_mode: 'test' } }] }] };
  const result = projectSharedResult(plan, now + 20000, now, false);
  expect(result.result?.origin).toBeUndefined();
  expect(result.result_expires_at).toBe(new Date(now + 20000).toISOString());
  const overall = projectSharedResult({ ...plan, valid_until: new Date(now + 1000).toISOString() }, now + 20000, now, false);
  expect(overall.result_expires_at).toBe(new Date(now + 1000).toISOString());
  expect(overall.result?.valid_until).toBe(new Date(now + 1000).toISOString());
  expect(projectSharedResult(plan, now, now, false).result).toBeNull();
  delete (plan.days[0]!.visits[0] as { source?: unknown }).source;
  expect(projectSharedResult(plan, now + 20000, now, true).result).toBeNull();
});
it('keeps only public venue-to-venue geometry by default but honors freshness of hidden private legs', () => {
  const now = Date.parse('2026-09-24T09:00:00Z');
  const source = (ms: number) => ({ provider: 'test', fetched_at: new Date(now).toISOString(), valid_until: new Date(now + ms).toISOString(), data_mode: 'test' });
  const plan = { status: 'AVAILABLE', warnings: [], days: [{ day_id: 'd', date: '2026-09-24', status: 'AVAILABLE', missing_activity_ids: [],
    visits: ['public1', 'public2'].map(place_id => ({ activity_id: 'a', place_id, name: place_id, starts_at: 700, ends_at: 740,
      travel_before_minutes: 10, arrival_buffer_minutes: 5, price_expected_minor: null, warnings: [], source: source(30000) })),
    travel_segments: [['private-origin', 'public1'], ['public1', 'public2'], ['public2', 'private-destination']].map(([from_id, to_id], i) => ({
      from_id, to_id, departure_utc: 1, mode: 'walking', coordinates: [[[37 + i, 55], [37.1 + i, 55.1]]], source: source(i === 0 ? 5000 : 20000) })) }] };
  const hidden = projectSharedResult(plan, now + 25000, now, false);
  expect(hidden.result?.days[0]?.travel_segments?.map(segment => [segment.from_id, segment.to_id])).toEqual([['public1', 'public2']]);
  expect(hidden.result_expires_at).toBe(new Date(now + 5000).toISOString());
  const included = projectSharedResult(plan, now + 25000, now, true);
  expect(included.result?.days[0]?.travel_segments).toHaveLength(3);
  const transit = { pedestrian: false, waitingSeconds: 60, transferCount: 1, crossingCount: 0, scheduleEvidence: 'predicted',
    stages: [{ kind: 'passage', transport: null, names: ['1', '8'], stop: 'Public stop', movingSeconds: 300, waitingSeconds: 60,
      routes: [{ transport: 'bus', names: ['1'], raw_key: 'must-not-copy' }, { transport: 'trolleybus', names: ['8'] }] }],
    raw_provider_payload: { secret: 'must-not-copy' } };
  const withTransit = { ...plan, days: [{ ...plan.days[0], travel_segments: plan.days[0]!.travel_segments.map(segment => ({ ...segment, mode: 'public_transport', coordinates: [], transit })) }] };
  const transported = projectSharedResult(withTransit, now + 25000, now, false);
  expect(transported.result?.days[0]?.travel_segments?.[0]?.transit?.stages[0]?.routes).toEqual([
    { transport: 'bus', names: ['1'] }, { transport: 'trolleybus', names: ['8'] }]);
  expect(transported.result?.days[0]?.travel_segments).toHaveLength(1);
  expect(JSON.stringify(transported)).not.toContain('must-not-copy');
});

it('shares the selected event session through a whitelist without copying provider extensions or extending freshness', () => {
  const now = Date.parse('2026-09-27T09:00:00Z');
  const source = { provider: 'kudago', fetched_at: new Date(now).toISOString(), valid_until: new Date(now + 3000).toISOString(), data_mode: 'test' };
  const event = { provider: 'kudago', event_id: '123', occurrence_key: 'a'.repeat(64), schedule_kind: 'fixed',
    duration_basis: 'provider_session', minimum_age: 6, official_start_utc: 1790596800, official_end_utc: 1790600400,
    provider_extension: { contact: 'private-provider-extension' } };
  const plan = { status: 'AVAILABLE', warnings: [], event_gaps: [{ day_id: 'd', activity_id: 'missing', code: 'EVENT_NOT_SCHEDULED',
    raw_diagnostics: 'private-provider-extension' }], days: [{ day_id: 'd', date: '2026-09-28', status: 'AVAILABLE', missing_activity_ids: [],
    visits: [{ activity_id: 'a', place_id: 'event123', name: 'Synthetic event', starts_at: 900, ends_at: 960,
      travel_before_minutes: 10, arrival_buffer_minutes: 5, price_expected_minor: 0, warnings: [], event, source }] }] };
  // Strict event contracts reject new provider fields before projection.
  expect(projectSharedResult(plan, now + 300000, now, false).result).toBeNull();
  const { provider_extension: _providerExtension, ...publicEvent } = event;
  const accepted = { ...plan, event_gaps: plan.event_gaps.map(({ raw_diagnostics: _raw, ...gap }) => gap),
    days: plan.days.map(day => ({ ...day, visits: day.visits.map(visit => ({ ...visit, event: publicEvent })) })) };
  const shared = projectSharedResult(accepted, now + 300000, now, false);
  expect(shared.result?.days[0]?.visits[0]?.event).toEqual({ provider: 'kudago', event_id: '123', occurrence_key: 'a'.repeat(64),
    schedule_kind: 'fixed', duration_basis: 'provider_session', minimum_age: 6, official_start_utc: 1790596800, official_end_utc: 1790600400 });
  expect(shared.result?.event_gaps).toEqual([{ day_id: 'd', activity_id: 'missing', code: 'EVENT_NOT_SCHEDULED' }]);
  expect(shared.result_expires_at).toBe(new Date(now + 3000).toISOString());
  expect(JSON.stringify(shared)).not.toContain('private-provider-extension');
  expect(projectSharedResult(accepted, now + 300000, now + 3001, false).result).toBeNull();
});
