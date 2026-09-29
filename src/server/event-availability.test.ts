import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { normalizeKudagoEvent, normalizeKudagoVenue } from './event-normalization.js';
import { buildEventPlanningCandidate, resolveEventAvailability, resolveEventSelection, resolveSelectedEvent } from './event-availability.js';
import { KudagoClient, EventRequestBudgetError } from './kudago.js';

const now = Date.parse('2026-09-27T09:00:00Z'), start = Date.parse('2026-09-28T10:00:00Z') / 1000;
const context = { fetchedAt: new Date(now).toISOString(), validUntil: new Date(now + 300000).toISOString() };
const scope = { date: '2026-09-28', window: { start: '10:00', end: '19:00' }, timezone: 'Europe/Moscow', providerLocation: 'nnv', now };
const rawVenue = { id: 44, title: 'Synthetic venue', site_url: 'https://kudago.com/nnv/place/test/', coords: { lat: 56.32, lon: 44 },
  is_closed: false, timetable: 'пн–пт 10:00–19:00; сб, вс закрыто' };
function rawEvent(visit = false) { return { id: 123, title: 'Synthetic event', location: { slug: 'nnv' }, site_url: 'https://kudago.com/nnv/event/test/',
  dates: [{ start, end: visit ? start + 30 * 86400 : start + 3600, is_startless: false, is_endless: false, is_continuous: false,
    use_place_schedule: visit, schedules: [] }], place: rawVenue, price: 'бесплатно', is_free: true, age_restriction: '6+' }; }
const venue = () => normalizeKudagoVenue(rawVenue, context);
it('carries the advertised upper admission price into the planner per person', () => {
  const card = normalizeKudagoEvent({ ...rawEvent(true), price: 'от 400 до 600 рублей', is_free: false }, context);
  const selected = resolveEventAvailability(card, venue(), scope).choices[0]!;
  const candidate = buildEventPlanningCandidate(selected, { activityId: 'a', dayId: 'd', localityId: 'city', regionId: 'region', visitDurationMinutes: 60, now });
  expect(candidate.price).toEqual({ expected_minor: 60000, upper_minor: 60000, basis: 'per_person', estimate_kind: 'advertised_admission' });
});
function choice(visit = false) {
  const result = resolveEventAvailability(normalizeKudagoEvent(rawEvent(visit), context), venue(), scope);
  expect(result.status).toBe('READY'); return result.choices[0]!;
}
it('builds an exact selected fixed event wire candidate with independent bindings and preserved price/age/source', () => {
  const selected = choice();
  const bind = { activityId: 'a', dayId: 'd', localityId: 'city', regionId: 'region', now };
  const candidate = buildEventPlanningCandidate(selected, bind);
  expect(candidate.id).toBe(`event:kudago:${createHash('sha256').update(JSON.stringify(['123', selected.event_ref.occurrence_key, 'd', 'a'])).digest('hex')}`);
  expect(candidate).toMatchObject({ kind: 'event', activity_id: 'a', day_id: 'd', locality_id: 'city', region_id: 'region',
    duration: { minutes: 60, basis: 'provider_session' }, price: { expected_minor: 0, upper_minor: 0, basis: 'whole_party' }, age: { minimum_age: 6 } });
  expect(candidate).not.toHaveProperty('rubric_ids'); expect(candidate).not.toHaveProperty('opening_intervals');
  expect(buildEventPlanningCandidate(selected, { ...bind, activityId: 'b' }).id).not.toBe(candidate.id);
  const selectedState = resolveEventSelection(selected, undefined, now);
  expect(selectedState.evidence.display.title).toBe('Synthetic event');
  expect(selectedState.target).not.toHaveProperty('visit_duration_minutes');
  expect(() => resolveEventSelection(selected, 15, now)).toThrow('EVENT_DURATION_NOT_APPLICABLE');
});
it('requires an own visit estimate, checks a whole visit fits, and does not call paid/unknown price free', () => {
  const selected = choice(true);
  expect(() => resolveEventSelection(selected, undefined, now)).toThrow('EVENT_DURATION_REQUIRED');
  expect(() => resolveEventSelection(selected, 720, now)).toThrow('EVENT_DURATION_OUTSIDE_WINDOW');
  const state = resolveEventSelection(selected, 60, now);
  expect(state.target.visit_duration_minutes).toBe(60); expect(state.display.duration.basis).toBe('user_estimate');
  const unknown = { ...selected, price: { display: 'от 500 ₽', kind: 'text' as const, admission_upper_minor: null, basis: 'admission' as const, strict_eligible: false } };
  const candidate = buildEventPlanningCandidate(unknown, { activityId: 'a', dayId: 'd', localityId: 'city', regionId: 'r', visitDurationMinutes: 60, now });
  expect(candidate.price).toEqual({ expected_minor: null, upper_minor: null, basis: 'unknown', estimate_kind: 'unknown' });
});
it('rejects expired, other-city and out-of-area source facts before presenting a selectable option', () => {
  const card = normalizeKudagoEvent(rawEvent(), context), place = venue();
  expect(resolveEventAvailability(card, place, { ...scope, now: now + 300000 }).choices).toEqual([]);
  expect(resolveEventAvailability({ ...card, provider_location: 'kzn' }, place, scope).unresolved[0]?.code).toBe('EVENT_LOCALITY_MISMATCH');
  expect(resolveEventAvailability(card, place, { ...scope, pointArea: { south: 55, north: 56, west: 43, east: 45 } }).choices).toEqual([]);
  expect(() => resolveEventSelection(choice(), undefined, now + 300000)).toThrow('EVENT_SOURCE_EXPIRED');
});
it('never truncates a fixed event to the user window and clips flexible visit windows safely', () => {
  const card = normalizeKudagoEvent(rawEvent(), context);
  const tooShort = resolveEventAvailability(card, venue(), { ...scope, window: { start: '13:30', end: '19:00' } });
  expect(tooShort.choices).toEqual([]); expect(tooShort.unresolved[0]?.code).toBe('EVENT_OUTSIDE_DAY_WINDOW');
  const visit = resolveEventAvailability(normalizeKudagoEvent(rawEvent(true), context), venue(), { ...scope, window: { start: '14:00', end: '15:00' } });
  expect(visit.choices[0]?.schedule.windows_utc).toEqual([{ start_utc: start + 3600, end_utc: start + 7200 }]);
});
it('returns known choices while disclosing an unsupported entry and avoids fixed sessions across DST offset changes', () => {
  const raw = rawEvent(); raw.dates.push({ ...raw.dates[0]!, end: start });
  const result = resolveEventAvailability(normalizeKudagoEvent(raw, context), venue(), scope);
  expect(result.status).toBe('PARTIAL'); expect(result.choices).toHaveLength(1); expect(result.unresolved).toHaveLength(1);
  const dst = rawEvent(); dst.dates[0]!.start = Date.parse('2026-10-25T00:00:00Z') / 1000; dst.dates[0]!.end = Date.parse('2026-10-25T02:00:00Z') / 1000;
  const invalid = resolveEventAvailability(normalizeKudagoEvent(dst, context), venue(), { ...scope, date: '2026-10-25',
    timezone: 'Europe/Berlin', window: { start: '00:00', end: '24:00' } });
  expect(invalid.choices).toEqual([]); expect(invalid.unresolved.map(x => x.code)).toContain('EVENT_LOCAL_TIME_UNSUPPORTED');
});
it('freshly resolves exact target through detail+venue with shared budgets, and refuses changed location or occurrence', async () => {
  const selected = choice(); let attempts = 0;
  const client = new KudagoClient({ now: () => now, fetcher: async url => {
    attempts++; return new Response(JSON.stringify(new URL(String(url)).pathname.includes('/events/') ? rawEvent() : rawVenue)); } });
  const target = resolveEventSelection(selected, undefined, now).target;
  const ctx = { ...scope, activityId: 'a', dayId: 'd', localityId: 'city', regionId: 'r' };
  const options = { now: () => now, requestBudget: { consume() { if (attempts >= 2) throw new EventRequestBudgetError('HTTP_BUDGET_EXHAUSTED'); } } };
  const result = await resolveSelectedEvent(client, target, ctx, options);
  expect(result.status).toBe('READY'); expect(result.attempts).toBe(2); expect(attempts).toBe(2);
  const exhausted = await resolveSelectedEvent(client, target, ctx, options);
  expect(exhausted).toMatchObject({ status: 'UNAVAILABLE', attempts: 0, code: 'EVENT_HTTP_BUDGET_EXHAUSTED' });
  const moved = await resolveSelectedEvent(client, target, ctx, { now: () => now, previousPoint: { lat: 56.1, lon: 44 } });
  expect(moved).toMatchObject({ status: 'NEEDS_INPUT', code: 'EVENT_LOCATION_CHANGED' });
  const changed = await resolveSelectedEvent(client, { ...target, occurrence_key: 'b'.repeat(64) }, ctx, { now: () => now });
  expect(changed).toMatchObject({ status: 'NEEDS_INPUT', code: 'EVENT_SELECTION_CHANGED' });
});
