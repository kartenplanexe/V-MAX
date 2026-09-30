import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicPlan } from '../shared/planning-form.js';
import { EventPlanningCandidateSchema } from '../shared/event-selection.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis, safePlanningDiagnostic, type ResolvePlanEvents } from './place-planning.js';

function fixture() {
  const f = planningFixture(), ref = { provider: 'kudago' as const, event_id: '17', occurrence_key: 'a'.repeat(64) };
  const target = { ...ref, kind: 'event' as const };
  const intent = { ...f.input.intent, days: [{ ...f.input.intent.days[0]!, activities: [
    { id: 'culture', label: 'Выбранное событие', intent_kind: 'event_visit', target, requirements: [] },
    f.input.intent.days[0]!.activities[1]!,
  ] }] };
  const digest = createHash('sha256').update(JSON.stringify([ref.event_id, ref.occurrence_key, 'd1', 'culture'])).digest('hex');
  const candidate = EventPlanningCandidateSchema.parse({ kind: 'event', id: `event:kudago:${digest}`,
    name: 'Синтетический сеанс', location_label: null, locality_id: 'mow', region_id: '32', date: '2026-09-25',
    event_ref: ref, activity_id: 'culture', day_id: 'd1', point: { lat: 55.751, lon: 37.621 },
    source: { provider: 'kudago', url: 'https://kudago.com/nnv/event/synthetic-test-only/', data_mode: 'test',
      fetched_at: demoNow().toISOString(), valid_until: new Date(+demoNow() + 300_000).toISOString() },
    schedule: { kind: 'fixed', windows_utc: [{ start_utc: Date.parse('2026-09-25T13:30:00Z') / 1000,
      end_utc: Date.parse('2026-09-25T14:30:00Z') / 1000 }] },
    duration: { minutes: 60, basis: 'provider_session' }, age: { minimum_age: 0 },
    price: { expected_minor: 0, upper_minor: 0, basis: 'whole_party', estimate_kind: 'verified_admission' },
    normalization_warnings: ['EVENT_BOOKING_NOT_VERIFIED'] });
  const resolveEvents: ResolvePlanEvents = async (_input, { requestBudget }) => {
    // Synthetic HTTP sources feed the real Python planner.
    requestBudget.consume(); requestBudget.consume();
    return { candidates: [candidate], issues: [] };
  };
  return { f, candidate, resolveEvents, job: { ...f.input, intent } };
}

it('retains the paid event time, price and city-subdomain link in the external all-stops result without Routing API', async () => {
  const { f, candidate, job, resolveEvents } = fixture();
  candidate.source.url = 'https://nn.kudago.com/event/synthetic-test-only/';
  candidate.price = { expected_minor: 60000, upper_minor: 60000, basis: 'per_person', estimate_kind: 'advertised_admission' };
  Object.assign(job.intent.shared, { party: { total: 1 } });
  const plan = PublicPlan.parse(await planPlacesWithDgis(f.client(), job, { retrieval: { radiusMeters: 5000 },
    now: demoNow, dataMode: 'test', resolveEvents, routingMode: 'external' }));
  expect(plan.status).toBe('PLACES_FOUND');
  expect(plan.candidate_preview?.groups[0]?.places[0]).toMatchObject({ place_id: candidate.id,
    event_visit: { starts_at: 990, ends_at: 1050, schedule_kind: 'fixed', admission_upper_minor: 60000 }, source: { url: candidate.source.url } });
  expect(f.routingBatches()).toBe(0);
}, 30_000);

it('keeps a fixed event and food in one verified route without querying fake event rubrics', async () => {
  const { f, candidate, job, resolveEvents } = fixture();
  const raw = await planPlacesWithDgis(f.client(), job, { retrieval: { radiusMeters: 5000, maxRequests: 30 },
    now: demoNow, dataMode: 'test', resolveEvents });
  const plan = PublicPlan.parse(raw);
  expect(plan.status, JSON.stringify({ issues: plan.issues, diagnostic: safePlanningDiagnostic(raw) })).toBe('AVAILABLE');
  expect(plan.days[0]!.visits.map(visit => visit.place_id)).toEqual([candidate.id, 'cafe']);
  expect(plan.days[0]!.visits[0]).toMatchObject({ starts_at: 990, ends_at: 1050,
    event: { provider: 'kudago', event_id: '17', schedule_kind: 'fixed', duration_basis: 'provider_session' } });
  expect(plan.days[0]!.missing_activity_ids).toEqual([]);
  expect(f.requests.filter(request => request.url.hostname === 'catalog.api.2gis.com').map(request => request.url.searchParams.get('rubric_id'))).toEqual(['200']);
  expect(safePlanningDiagnostic(raw)).toMatchObject({ event_http_calls: 2, places_http_calls: 1, retrieval_http_calls: 3 });
}, 30_000);

it('does not give event and Places separate hidden HTTP allowances or silently fulfil omitted food', async () => {
  const { f, job, resolveEvents } = fixture();
  const raw = await planPlacesWithDgis(f.client(), job, { retrieval: { radiusMeters: 5000, maxRequests: 2 },
    now: demoNow, dataMode: 'test', resolveEvents });
  const plan = PublicPlan.parse(raw);
  expect(plan.status).toBe('LIMITED');
  expect(plan.days[0]!.missing_activity_ids).toContain('food');
  expect(f.requests.filter(request => request.url.hostname === 'catalog.api.2gis.com')).toEqual([]);
  expect(safePlanningDiagnostic(raw)).toMatchObject({ event_http_calls: 2, places_http_calls: 0, retrieval_http_calls: 2 });
}, 30_000);

it('supports an event-only day and keeps changed event facts as an explicit gap', async () => {
  const { f, job, resolveEvents, candidate } = fixture();
  job.intent.days[0]!.activities.splice(1); job.intent.days[0]!.order = [];
  const options = { retrieval: { radiusMeters: 5000 }, now: demoNow, dataMode: 'test' as const, resolveEvents };
  const plan = PublicPlan.parse(await planPlacesWithDgis(f.client(), job, options));
  expect(plan.status).toBe('AVAILABLE'); expect(plan.days[0]!.visits[0]!.place_id).toBe(candidate.id);
  expect(f.requests.filter(request => request.url.hostname === 'catalog.api.2gis.com')).toEqual([]);
  const changed = PublicPlan.parse(await planPlacesWithDgis(f.client(), job, { ...options,
    resolveEvents: async () => ({ candidates: [], issues: [{ day_id: 'd1', activity_id: 'culture', code: 'EVENT_SELECTION_CHANGED' }] }) }));
  expect(changed.status).not.toBe('AVAILABLE');
  expect(changed.event_gaps).toEqual([{ day_id: 'd1', activity_id: 'culture', code: 'EVENT_SELECTION_CHANGED' }]);
}, 30_000);
