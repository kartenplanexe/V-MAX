import { expect, it } from 'vitest';
import { PublicPlan } from '../shared/planning-form.js';
import { normalizeKudagoEvent, normalizeKudagoVenue } from './event-normalization.js';
import { resolveEventAvailability, resolveEventSelection } from './event-availability.js';
import { KudagoClient } from './kudago.js';
import { createResolvePlanEvents } from './selected-event-retrieval.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis, safePlanningDiagnostic } from './place-planning.js';

function fixture() {
  const f = planningFixture();
  const origin = { lat: 56.32, lon: 44, locality_id: 'nnv' };
  f.input.intent.locality = { ...f.input.intent.locality, id: 'nnv', name: 'Нижний Новгород' };
  f.input.intent.points.origin = origin;
  for (const item of f.items) { item.point.lat += 0.57; item.point.lon += 6.38; }
  const start = Date.parse('2026-09-25T13:30:00Z') / 1000;
  const venue = { id: 44, title: 'Учебный зал', site_url: 'https://kudago.com/nnv/place/synthetic-only/',
    coords: { lat: 56.321, lon: 44.001 }, is_closed: false, timetable: 'пн\u2013вс 10:00\u201322:00' };
  const event = { id: 123, title: 'Учебный сеанс', location: { slug: 'nnv' }, site_url: 'https://kudago.com/nnv/event/synthetic-only/',
    dates: [{ start, end: start + 3600, is_startless: false, is_endless: false, is_continuous: false,
      use_place_schedule: false, schedules: [] }], place: venue, price: 'бесплатно', is_free: true, age_restriction: '0+' };
  const stamp = { fetchedAt: demoNow().toISOString(), validUntil: new Date(+demoNow() + 300000).toISOString(), dataMode: 'test' as const };
  const choice = resolveEventAvailability(normalizeKudagoEvent(event, stamp), normalizeKudagoVenue(venue, stamp), {
    date: '2026-09-25', window: { start: '16:00', end: '19:00' }, timezone: 'Europe/Moscow', providerLocation: 'nnv', now: +demoNow(),
  }).choices[0]!;
  const selected = resolveEventSelection(choice, undefined, +demoNow());
  const job = { ...f.input, intent: { ...f.input.intent, days: [{ ...f.input.intent.days[0]!, activities: [
    { id: 'culture', label: 'Выбранное событие', intent_kind: 'event_visit', target: selected.target, requirements: [] },
    f.input.intent.days[0]!.activities[1]!,
  ] }] }, event_evidence: [{ day_id: 'd1', activity_id: 'culture', target: selected.target,
    point: selected.evidence.point, date: '2026-09-25', valid_until: selected.evidence.valid_until }],
    point_area: { south: 56, north: 57, west: 43, east: 45 } };
  const calls: string[] = [];
  const client = new KudagoClient({ now: () => +demoNow(), fetcher: async url => {
    const path = new URL(String(url)).pathname; calls.push(path);
    return Response.json(path.includes('/events/') ? event : venue);
  } });
  return { f, event, venue, job, calls, resolveEvents: createResolvePlanEvents(client) };
}

it('rechecks selected source and venue through the real client before an event + food Python route', async () => {
  const { f, job, calls, resolveEvents } = fixture();
  const raw = await planPlacesWithDgis(f.client(), job, { retrieval: { radiusMeters: 5000 }, now: demoNow, dataMode: 'test', resolveEvents });
  const plan = PublicPlan.parse(raw);
  expect(plan.status, JSON.stringify(safePlanningDiagnostic(raw))).toBe('AVAILABLE');
  expect(plan.days[0]!.visits.map(visit => visit.activity_id)).toEqual(['culture', 'food']);
  expect(plan.days[0]!.visits[0]).toMatchObject({ starts_at: 990, ends_at: 1050,
    event: { event_id: '123', schedule_kind: 'fixed', duration_basis: 'provider_session' } });
  expect(calls).toEqual(['/public-api/v1.4/events/123/', '/public-api/v1.4/places/44/']);
  expect(safePlanningDiagnostic(raw)).toMatchObject({ event_http_calls: 2, places_http_calls: 1, retrieval_http_calls: 3 });
}, 30000);

it('cannot refresh expired selection implicitly, change its venue or silently swap the occurrence', async () => {
  const scope = { requestBudget: { consume() {} }, shouldContinue: () => true, now: demoNow };
  const expired = fixture(); expired.job.event_evidence[0]!.valid_until = demoNow().toISOString();
  expect(await expired.resolveEvents(expired.job, scope)).toMatchObject({ candidates: [], issues: [{ code: 'EVENT_RECHECK_REQUIRED' }] });
  expect(expired.calls).toEqual([]);
  const moved = fixture(); moved.venue.coords.lat += 0.01;
  expect(await moved.resolveEvents(moved.job, scope)).toMatchObject({ candidates: [], issues: [{ code: 'EVENT_LOCATION_CHANGED' }] });
  const changed = fixture(); changed.event.dates[0]!.start += 600;
  expect(await changed.resolveEvents(changed.job, scope)).toMatchObject({ candidates: [], issues: [{ code: 'EVENT_SELECTION_CHANGED' }] });
});

it('binds evidence to the exact day and locality before spending any provider request', async () => {
  const { job, calls, resolveEvents } = fixture();
  const scope = { requestBudget: { consume() { throw new Error('must not request'); } }, shouldContinue: () => true, now: demoNow };
  job.event_evidence[0]!.day_id = 'different-day';
  expect(await resolveEvents(job, scope)).toMatchObject({ candidates: [], issues: [{ code: 'EVENT_RECHECK_REQUIRED' }] });
  job.intent.locality.name = 'Неподдерживаемый город';
  expect(await resolveEvents(job, scope)).toMatchObject({ candidates: [], issues: [{ code: 'EVENT_LOCALITY_UNSUPPORTED' }] });
  expect(calls).toEqual([]);
});
