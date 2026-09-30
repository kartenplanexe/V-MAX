import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EventCardSchema, EventVenueSchema, type EventCard, type EventVenue } from '../shared/event-catalog.js';
import { EventAvailabilitySchema, EventAvailabilityChoiceSchema, EventPlanningCandidateSchema, SelectedEventDisplaySchema,
  SelectedEventTargetSchema, type EventAvailability, type EventAvailabilityChoice, type SelectedEventTarget } from '../shared/event-selection.js';
import { localEventInstant, resolveEventVisitWindows } from './event-normalization.js';
import { KudagoClient, type EventRequestBudget } from './kudago.js';

type Point = { lat: number; lon: number };
export type EventAvailabilityScope = { date: string; window: { start: string; end: string }; timezone: string;
  providerLocation: string; now: number; pointArea?: { south: number; north: number; west: number; east: number } };
export class EventSelectionError extends Error { constructor(readonly code: string) { super(code); this.name = 'EventSelectionError'; } }
const fail = (code: string): never => { throw new EventSelectionError(code); };
const fresh = (source: EventCard['source'], now: number) => Number.isFinite(now) && Date.parse(source.fetched_at) <= now && now < Date.parse(source.valid_until);
const minutes = (time: string) => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/u.test(time)) return null;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
};

// Local-minute scheduling cannot represent DST gaps or repeated hours.
function ordinaryLocalWindow(start: number, end: number, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const parts = (at: number) => Object.fromEntries(formatter.formatToParts(new Date(at * 1000)).map(part => [part.type, part.value]));
  const offset = (at: number) => { const p = parts(at); return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second)) / 1000 - at; };
  if (offset(start) !== offset(end - 1)) return false;
  const minuteFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return [start, end].every(at => {
    const p = parts(at), date = `${p.year}-${p.month}-${p.day}`;
    return localEventInstant(date, Number(p.hour) * 60 + Number(p.minute), minuteFormatter) === Math.floor(at / 60) * 60;
  });
}

export function resolveEventAvailability(rawCard: EventCard, rawVenue: EventVenue, scope: EventAvailabilityScope): EventAvailability {
  const card = EventCardSchema.parse(rawCard), venue = EventVenueSchema.parse(rawVenue);
  const unavailable = (code: string): EventAvailability => ({ status: 'UNAVAILABLE', choices: [], unresolved: [{ occurrence_key: null, code }] });
  if (!fresh(card.source, scope.now) || !fresh(venue.source, scope.now)) return unavailable('EVENT_SOURCE_EXPIRED');
  if (!card.provider_location || card.provider_location !== scope.providerLocation) return unavailable('EVENT_LOCALITY_MISMATCH');
  const from = minutes(scope.window.start), to = minutes(scope.window.end);
  if (from === null || to === null || to <= from || !EventAvailabilityChoiceSchema.shape.date.safeParse(scope.date).success) return unavailable('EVENT_INVALID_SCOPE');
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: scope.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch { return unavailable('EVENT_TIMEZONE_UNSUPPORTED'); }
  const dayStart = localEventInstant(scope.date, from, formatter), dayEnd = localEventInstant(scope.date, to, formatter);
  if (dayStart === null || dayEnd === null) return unavailable('EVENT_LOCAL_TIME_UNSUPPORTED');
  const result = resolveEventVisitWindows(card, venue, { fromDate: scope.date, toDate: scope.date, timezone: scope.timezone });
  if (!result.point) return unavailable(result.reasons[0] ?? 'EVENT_VENUE_UNAVAILABLE');
  const box = scope.pointArea, point = result.point;
  if (box && (point.lat < box.south || point.lat > box.north || point.lon < box.west || point.lon > box.east)) return unavailable('EVENT_OUTSIDE_LOCALITY');
  const unresolved = [...result.unresolved], choices: EventAvailabilityChoice[] = [];
  const grouped = new Map<string, typeof result.windows>();
  for (const window of result.windows) grouped.set(window.occurrence_key, [...(grouped.get(window.occurrence_key) ?? []), window]);
  const source = { ...card.source,
    fetched_at: new Date(Math.min(Date.parse(card.source.fetched_at), Date.parse(venue.source.fetched_at))).toISOString(),
    valid_until: new Date(Math.min(Date.parse(card.source.valid_until), Date.parse(venue.source.valid_until))).toISOString() };
  for (const [key, windows] of grouped) {
    const kind = windows[0]!.kind;
    const intervals = windows.flatMap(window => {
      if (kind === 'fixed' && (window.start_utc < dayStart || window.end_utc > dayEnd)) return [];
      const start_utc = kind === 'fixed' ? window.start_utc : Math.max(dayStart, window.start_utc);
      const end_utc = kind === 'fixed' ? window.end_utc : Math.min(dayEnd, window.end_utc);
      return start_utc < end_utc ? [{ start_utc, end_utc }] : [];
    });
    if (!intervals.length) { unresolved.push({ occurrence_key: key, code: 'EVENT_OUTSIDE_DAY_WINDOW', dates: [scope.date] }); continue; }
    if (intervals.some(window => !ordinaryLocalWindow(window.start_utc, window.end_utc, scope.timezone))) {
      unresolved.push({ occurrence_key: key, code: 'EVENT_LOCAL_TIME_UNSUPPORTED', dates: [scope.date] }); continue;
    }
    choices.push(EventAvailabilityChoiceSchema.parse({ event_ref: { provider: 'kudago', event_id: String(card.provider_event_id), occurrence_key: key },
      title: card.title, date: scope.date, schedule: { kind, windows_utc: intervals }, point,
      venue_name: venue.title || card.venue?.name || null, location_label: card.venue?.address ?? null,
      source, venue_source: venue.source, duration_required: kind === 'visit_window', age: card.age, price: card.price,
      warnings: [...new Set([...card.issues.filter(issue => !['VENUE_COORDINATES_UNKNOWN', 'VENUE_STATUS_UNKNOWN'].includes(issue)),
        ...result.reasons.filter(reason => reason === 'VENUE_LOCATION_UPDATED')])] }));
  }
  if (!choices.length && !unresolved.length) unresolved.push({ occurrence_key: null, code: 'EVENT_NO_WINDOWS_IN_SCOPE' });
  return EventAvailabilitySchema.parse({ status: choices.length ? unresolved.length ? 'PARTIAL' : 'READY' : 'UNAVAILABLE', choices, unresolved });
}

export function resolveEventSelection(rawChoice: EventAvailabilityChoice, visitDurationMinutes: number | undefined, now: number) {
  const choice = EventAvailabilityChoiceSchema.parse(rawChoice);
  if (!fresh(choice.source, now) || choice.venue_source && !fresh(choice.venue_source, now)) fail('EVENT_SOURCE_EXPIRED');
  let duration: { minutes: number; basis: 'provider_session' | 'user_estimate' };
  if (choice.schedule.kind === 'fixed') {
    if (visitDurationMinutes !== undefined) fail('EVENT_DURATION_NOT_APPLICABLE');
    const window = choice.schedule.windows_utc[0]!;
    duration = { minutes: Math.ceil(window.end_utc / 60) - Math.floor(window.start_utc / 60), basis: 'provider_session' };
  } else {
    if (!Number.isInteger(visitDurationMinutes) || visitDurationMinutes! < 5 || visitDurationMinutes! > 720) fail('EVENT_DURATION_REQUIRED');
    if (!choice.schedule.windows_utc.some(window => Math.floor(window.end_utc / 60) - Math.ceil(window.start_utc / 60) >= visitDurationMinutes!))
      fail('EVENT_DURATION_OUTSIDE_WINDOW');
    duration = { minutes: visitDurationMinutes!, basis: 'user_estimate' };
  }
  const target = SelectedEventTargetSchema.parse({ kind: 'event', ...choice.event_ref,
    ...(duration.basis === 'user_estimate' ? { visit_duration_minutes: duration.minutes } : {}) });
  const { duration_required: _durationRequired, ...facts } = choice;
  const display = SelectedEventDisplaySchema.parse({ ...facts, duration });
  return { target, display, evidence: { date: choice.date, valid_until: choice.source.valid_until, point: { ...choice.point }, display } };
}

export function buildEventPlanningCandidate(choice: EventAvailabilityChoice, binding: {
  activityId: string; dayId: string; localityId: string; regionId: string; visitDurationMinutes?: number; now: number;
}) {
  const selected = resolveEventSelection(choice, binding.visitDurationMinutes, binding.now), free = choice.price.kind === 'free' &&
    choice.price.strict_eligible && choice.price.admission_upper_minor === 0;
  const paid = choice.price.kind === 'bounded' && choice.price.strict_eligible && choice.price.admission_upper_minor !== null && choice.price.admission_upper_minor > 0;
  const upper = free ? 0 : paid ? choice.price.admission_upper_minor : null;
  const id = createHash('sha256').update(JSON.stringify([choice.event_ref.event_id, choice.event_ref.occurrence_key, binding.dayId, binding.activityId])).digest('hex');
  return EventPlanningCandidateSchema.parse({ kind: 'event', id: `event:kudago:${id}`, name: choice.title, location_label: choice.location_label,
    locality_id: binding.localityId, region_id: binding.regionId, date: choice.date, event_ref: choice.event_ref,
    activity_id: binding.activityId, day_id: binding.dayId, point: choice.point, source: choice.source,
    ...(choice.venue_source ? { venue_source: choice.venue_source } : {}), schedule: choice.schedule, duration: selected.display.duration,
    age: { minimum_age: choice.age.state === 'known' ? choice.age.minimum : null },
    price: { expected_minor: upper, upper_minor: upper, basis: free ? 'whole_party' : paid ? 'per_person' : 'unknown',
      estimate_kind: free ? 'verified_admission' : paid ? 'advertised_admission' : 'unknown' }, normalization_warnings: choice.warnings });
}

export type SelectedEventContext = Omit<EventAvailabilityScope, 'now'> & { activityId: string; dayId: string; localityId: string; regionId: string };
export async function resolveSelectedEvent(client: KudagoClient, rawTarget: SelectedEventTarget, context: SelectedEventContext,
  options: { requestBudget?: EventRequestBudget; shouldContinue?: () => boolean; now?: () => number; previousPoint?: Point } = {}) {
  const target = SelectedEventTargetSchema.parse(rawTarget), now = options.now ?? Date.now, started = performance.now();
  const policy = { requestBudget: options.requestBudget, shouldContinue: () => performance.now() - started < 90000 && options.shouldContinue?.() !== false };
  let attempts = 0;
  const missing = (code: string, unavailable = false) => ({ status: unavailable ? 'UNAVAILABLE' as const : 'NEEDS_INPUT' as const, code, attempts });
  const event = await client.getEvent(target.event_id, policy); attempts += event.attempts;
  if (!event.event) return missing(`EVENT_${event.reason ?? 'PROVIDER_ERROR'}`, true);
  if (!event.event.schedule.entries.some(entry => entry.occurrence_key === target.occurrence_key)) return missing('EVENT_SELECTION_CHANGED');
  if (!event.event.venue) return missing('EVENT_VENUE_UNKNOWN');
  const venue = await client.getVenue(event.event.venue.provider_venue_id, policy); attempts += venue.attempts;
  if (!venue.venue) return missing(`EVENT_${venue.reason ?? 'PROVIDER_ERROR'}`, true);
  const availability = resolveEventAvailability(event.event, venue.venue, { ...context, now: now() });
  const choice = availability.choices.find(value => value.event_ref.occurrence_key === target.occurrence_key);
  if (!choice) return missing(availability.unresolved.find(value => value.occurrence_key === target.occurrence_key)?.code ??
    availability.unresolved[0]?.code ?? 'EVENT_SCHEDULE_UNAVAILABLE');
  if (options.previousPoint && (options.previousPoint.lat !== choice.point.lat || options.previousPoint.lon !== choice.point.lon)) return missing('EVENT_LOCATION_CHANGED');
  try {
    const selected = resolveEventSelection(choice, target.visit_duration_minutes, now());
    const candidate = buildEventPlanningCandidate(choice, { ...context, visitDurationMinutes: target.visit_duration_minutes, now: now() });
    return { status: 'READY' as const, candidate, display: selected.display, evidence: selected.evidence, attempts };
  } catch (error) {
    if (error instanceof EventSelectionError) return missing(error.code);
    throw error;
  }
}
