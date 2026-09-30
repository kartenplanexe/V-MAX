import { z } from 'zod';
import { createHash } from 'node:crypto';
import { EventCardSchema, EventVenueSchema, EventFactSourceSchema, type EventCard, type EventVenue } from '../shared/event-catalog.js';

export type EventNormalizationContext = { fetchedAt: string; validUntil: string; dataMode?: 'live' | 'test';
  /** Opt-in only after an operator verifies the particular material's rights. Never inferred from a CDN URL. */
  mediaLicense?: { basis: string; sourcePage: string; attributionText: string; attributionUrl: string } };
const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const VenueFacts = z.object({ id: Id, title: z.string().max(500).optional(), address: z.string().max(1000).optional(),
  coords: Point.nullable().optional(), is_closed: z.boolean().optional() });
const EventInput = z.object({ id: Id, title: z.string().min(1).max(500), site_url: z.string().max(2048),
  dates: z.array(z.unknown()).max(366), place: z.unknown().optional(), categories: z.array(z.string().max(100)).max(100).optional(),
  location: z.union([z.string().max(30), z.object({ slug: z.string().max(30) })]).nullable().optional(),
  price: z.string().max(1000).nullable().optional(), is_free: z.boolean().optional(), age_restriction: z.string().max(200).nullable().optional(),
  images: z.array(z.unknown()).max(100).optional() });
const DateInput = z.object({ start: z.number().int().safe().optional(), end: z.number().int().safe().optional(),
  is_continuous: z.boolean().optional(), is_endless: z.boolean().optional(), is_startless: z.boolean().optional(),
  use_place_schedule: z.boolean().optional(), schedules: z.array(z.unknown()).max(366).optional() });
const plain = (value: string | null | undefined) => value?.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim() || null;
const epoch = (value: number | undefined) => value !== undefined && value >= 0 && value <= 253402300799 ? value : null;
function source(url: string, context: EventNormalizationContext) {
  return EventFactSourceSchema.parse({ provider: 'kudago', url, fetched_at: context.fetchedAt,
    valid_until: context.validUntil, data_mode: context.dataMode ?? 'live' });
}

function dateEntry(raw: unknown, eventId: number, venueId: number | null): EventCard['schedule']['entries'][number] {
  const parsed = DateInput.safeParse(raw), date = parsed.success ? parsed.data : null;
  // Date reordering preserves identity; changed time or venue requires a new choice.
  const occurrence_key = createHash('sha256').update(JSON.stringify(['kudago-occurrence.v1', String(eventId), venueId,
    date?.is_startless ? null : date?.start ?? null, date?.is_endless ? null : date?.end ?? null,
    date?.is_continuous ?? null, date?.is_endless ?? null, date?.is_startless ?? null, date?.use_place_schedule ?? null,
    date?.schedules?.length ? 'unsupported_recurrence' : date?.schedules ? 'no_recurrence' : 'unknown_recurrence'])).digest('hex');
  const id = `kudago:date:${occurrence_key}`;
  const incomplete = (reasons: string[], start: number | null = null, end: number | null = null) => ({ id, occurrence_key,
    state: 'INCOMPLETE' as const, start_utc: start, end_utc: end, reasons });
  if (!parsed.success) return incomplete(['INVALID_DATE']);
  const d = parsed.data, start = d.is_startless ? null : epoch(d.start), end = d.is_endless ? null : epoch(d.end);
  if ([d.is_continuous, d.is_endless, d.is_startless, d.use_place_schedule].some(flag => typeof flag !== 'boolean') || !d.schedules) {
    return incomplete(['FLAGS_UNKNOWN'], start, end);
  }
  if (d.schedules.length) return incomplete(['RECURRENCE_UNSUPPORTED'], start, end);
  if (!d.is_startless && start === null || !d.is_endless && end === null) return incomplete(['DATE_BOUND_UNKNOWN'], start, end);
  if (start !== null && end !== null && end <= start) return incomplete(['DURATION_UNKNOWN'], start, end);
  if (d.use_place_schedule) return { id, occurrence_key, state: 'VENUE_HOURS_REQUIRED', start_utc: start, end_utc: end, reasons: ['VENUE_HOURS_REQUIRED'] };
  if (d.is_endless || d.is_startless) return incomplete(['UNBOUNDED_SESSION'], start, end);
  if (d.is_continuous) return incomplete(['CONTINUOUS_UNSUPPORTED'], start, end);
  if (start === null || end === null) return incomplete(['DATE_BOUND_UNKNOWN'], start, end);
  // A multi-day exhibition interval is not an official duration or daily opening window.
  if (end - start > 12 * 3600) return incomplete(['LONG_INTERVAL_UNSUPPORTED'], start, end);
  return { id, occurrence_key, state: 'FIXED', start_utc: start, end_utc: end, reasons: [] };
}

export function admissionPriceUpper(display: string | null): number | null {
  if (!display) return null;
  const amount = '(\\d{1,3}(?:[ \\u00a0]\\d{3})+|\\d+)(?:[.,](\\d{1,2}))?';
  const currency = '(?:₽|руб\\.?|рублей|рубля|рубль)';
  const range = new RegExp(`^(?:от\\s+)?${amount}\\s*(?:до|[–—-])\\s*${amount}\\s*${currency}$`, 'iu').exec(display);
  const exact = new RegExp(`^${amount}\\s*${currency}$`, 'iu').exec(display);
  const minor = (whole: string, fraction?: string) => Number(whole.replace(/\s/gu, '')) * 100 + Number((fraction ?? '').padEnd(2, '0'));
  const upper = range ? minor(range[3]!, range[4]) : exact ? minor(exact[1]!, exact[2]) : null;
  if (upper === null || !Number.isSafeInteger(upper) || upper <= 0 || upper > 100_000_000 || range && minor(range[1]!, range[2]) > upper) return null;
  return upper;
}

export function normalizeKudagoEvent(raw: unknown, context: EventNormalizationContext): EventCard {
  const input = EventInput.parse(raw), factSource = source(input.site_url, context), issues: string[] = [];
  const parsedVenue = VenueFacts.safeParse(input.place), v = parsedVenue.success ? parsedVenue.data : null;
  const venue = v ? { provider_venue_id: v.id, name: plain(v.title), address: plain(v.address), point: v.coords ?? null,
    is_closed: v.is_closed ?? null } : null;
  if (!venue?.point) issues.push('VENUE_COORDINATES_UNKNOWN');
  if (venue?.is_closed === true) issues.push('VENUE_CLOSED');
  if (venue?.is_closed === null) issues.push('VENUE_STATUS_UNKNOWN');
  const display = plain(input.price), freeText = !display || /^(?:бесплатно|вход свободный|0(?:[.,]00)?(?:\s*(?:₽|руб\.?))?)$/iu.test(display);
  const free = input.is_free === true && freeText, conflict = input.is_free === true && !freeText;
  const upper = conflict || free ? null : admissionPriceUpper(display);
  const price = { display, kind: free ? 'free' as const : conflict ? 'conflict' as const : upper !== null ? 'bounded' as const : display ? 'text' as const : 'unknown' as const,
    admission_upper_minor: free ? 0 : upper, basis: 'admission' as const, strict_eligible: free || upper !== null };
  if (!free && upper === null) issues.push(conflict ? 'PRICE_CONFLICT' : 'PRICE_UNVERIFIED');
  const ageMatch = /^(0|6|12|16|18)\+$/u.exec(plain(input.age_restriction) ?? '');
  const age = ageMatch ? { state: 'known' as const, minimum: Number(ageMatch[1]) } : { state: 'unknown' as const, minimum: null };
  if (!ageMatch) issues.push('AGE_UNKNOWN');
  const entries = [...new Map(input.dates.map(date => {
    const entry = dateEntry(date, input.id, v?.id ?? null); return [entry.occurrence_key, entry] as const;
  })).values()];
  if (!entries.length) issues.push('DATES_UNKNOWN');
  const media: EventCard['media'] = [];
  if (context.mediaLicense && context.mediaLicense.sourcePage === input.site_url) {
    const license = context.mediaLicense;
    for (const image of input.images ?? []) {
      if (media.length === 10) break;
      const result = z.object({ image: z.url().max(2048) }).safeParse(image);
      if (!result.success) continue;
      const url = new URL(result.data.image), attribution = new URL(license.attributionUrl);
      if (url.protocol !== 'https:' || !['media.kudago.com', 'kudago.com'].includes(url.hostname) || url.username || url.password || url.port ||
          attribution.protocol !== 'https:' || attribution.username || attribution.password) continue;
      media.push({ url: url.href, attribution_text: license.attributionText, attribution_url: license.attributionUrl,
        source_page: license.sourcePage, rights_basis: license.basis, kind: 'event_poster', provider: 'kudago',
        fetched_at: context.fetchedAt, valid_until: context.validUntil });
    }
  }
  return EventCardSchema.parse({ id: `kudago:event:${input.id}`, provider: 'kudago', provider_event_id: input.id,
    provider_location: typeof input.location === 'string' ? input.location : input.location?.slug ?? null,
    title: plain(input.title), source: factSource, venue, categories: [...new Set(input.categories ?? [])], price, age,
    schedule: { entries }, media, issues });
}

const Days = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
export function parseVenueTimetable(raw: string | null | undefined): EventVenue['hours'] {
  const weekly: EventVenue['hours']['weekly'] = Array.from({ length: 7 }, () => []);
  const fail = (reason: string): EventVenue['hours'] => ({ state: 'INCOMPLETE', weekly: Array.from({ length: 7 }, () => []),
    known_days: Array(7).fill(false) as boolean[], reasons: [reason], policy_version: 'kudago-weekly-hours.v2' });
  if (!raw || raw.length > 4000) return fail('HOURS_UNKNOWN');
  const value = raw.toLowerCase().replace(/[–—−]/gu, '-').replace(/\s+/gu, ' ').trim()
    .replace(/(\d{2}:\d{2}|выходной|закрыто),\s*(?=[а-я])/gu, '$1;');
  const assigned = new Set<number>();
  for (const clause of value.split(';').map(s => s.trim()).filter(Boolean)) {
    const match = /^(ежедневно|(?:пн|вт|ср|чт|пт|сб|вс)(?:\s*(?:-|,|и)\s*(?:пн|вт|ср|чт|пт|сб|вс))*)\s+(.+)$/u.exec(clause);
    if (!match) return fail('HOURS_SYNTAX_UNSUPPORTED');
    const days = new Set<number>();
    if (match[1] === 'ежедневно') Days.forEach((_, i) => days.add(i));
    else for (const part of match[1]!.split(/\s*(?:,|и)\s*/u)) {
      const range = part.split(/\s*-\s*/u), first = Days.indexOf(range[0]!), last = Days.indexOf(range[1] ?? range[0]!);
      if (first < 0 || last < first) return fail('HOURS_SYNTAX_UNSUPPORTED');
      for (let i = first; i <= last; i++) days.add(i);
    }
    const hours: { start: number; end: number }[] = [];
    if (!/^(выходной|закрыто)$/u.test(match[2]!)) {
      for (const interval of match[2]!.split(',')) {
        const time = /^\s*([0-2]?\d):([0-5]\d)\s*-\s*([0-2]?\d):([0-5]\d)\s*$/u.exec(interval);
        if (!time) return fail('HOURS_SYNTAX_UNSUPPORTED');
        const start = Number(time[1]) * 60 + Number(time[2]), end = Number(time[3]) * 60 + Number(time[4]);
        if (start >= 1440 || end > 1440 || end <= start || hours.length >= 8) return fail('HOURS_INTERVAL_UNSUPPORTED');
        hours.push({ start, end });
      }
      hours.sort((a, b) => a.start - b.start);
      if (hours.some((h, i) => i > 0 && h.start < hours[i - 1]!.end)) return fail('HOURS_CONFLICT');
    }
    for (const day of days) {
      if (assigned.has(day)) return fail('HOURS_CONFLICT');
      assigned.add(day); weekly[day] = hours.map(h => ({ ...h }));
    }
  }
  // Retain proven weekdays independently; an omitted day is not a closed day.
  return { state: assigned.size === 7 ? 'KNOWN' : 'PARTIAL', weekly, known_days: Days.map((_, i) => assigned.has(i)),
    reasons: assigned.size === 7 ? [] : ['HOURS_DAYS_UNKNOWN'], policy_version: 'kudago-weekly-hours.v2' };
}

export function normalizeKudagoVenue(raw: unknown, context: EventNormalizationContext): EventVenue {
  const input = VenueFacts.extend({ title: z.string().max(500), site_url: z.string().max(2048), timetable: z.string().max(4000).nullable().optional() }).parse(raw);
  return EventVenueSchema.parse({ provider: 'kudago', provider_venue_id: input.id, title: plain(input.title) ?? '', point: input.coords ?? null,
    is_closed: input.is_closed ?? null, source: source(input.site_url, context), timetable: plain(input.timetable), hours: parseVenueTimetable(input.timetable) });
}

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
/** Converts only unique real wall-clock instants; DST gaps and folds remain incomplete. */
export function localEventInstant(date: string, minutes: number, formatter: Intl.DateTimeFormat): number | null {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * 60000;
  const partsAt = (ms: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  };
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) { const sample = wall + hours * 3600000; offsets.add(partsAt(sample) - sample); }
  const matches = [...offsets].map(offset => wall - offset).filter(candidate => partsAt(candidate) === wall);
  return matches.length === 1 ? matches[0]! / 1000 : null;
}

export function resolveEventVisitWindows(card: EventCard, venue: EventVenue,
  scope: { fromDate: string; toDate: string; timezone: string }) {
  type Resolved = { date: string; start_utc: number; end_utc: number; entry_id: string; occurrence_key: string; kind: 'fixed' | 'visit_window' };
  type Unresolved = { occurrence_key: string | null; code: string; dates?: string[] };
  const fail = (reason: string) => ({ state: 'INCOMPLETE' as const, windows: [] as Resolved[], unresolved: [{ occurrence_key: null, code: reason }] as Unresolved[],
    point: null as EventVenue['point'], reasons: [reason], duration_basis: 'USER_ESTIMATE_REQUIRED' as const, valid_until: null as string | null });
  EventCardSchema.parse(card); EventVenueSchema.parse(venue);
  if (!CalendarDate.safeParse(scope.fromDate).success || !CalendarDate.safeParse(scope.toDate).success) return fail('INVALID_SCOPE');
  const begin = Date.parse(`${scope.fromDate}T00:00:00Z`), end = Date.parse(`${scope.toDate}T00:00:00Z`);
  if (end < begin || end - begin >= 31 * 86400000) return fail('INVALID_SCOPE');
  if (card.venue?.provider_venue_id !== venue.provider_venue_id) return fail('VENUE_MISMATCH');
  if (venue.is_closed !== false || card.venue.is_closed === true) return fail('VENUE_UNAVAILABLE');
  if (!venue.point) return fail('VENUE_COORDINATES_UNKNOWN');
  if (!card.schedule.entries.length) return fail('EVENT_SCHEDULE_UNSUPPORTED');
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: scope.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch { return fail('TIMEZONE_UNSUPPORTED'); }
  const windows: Resolved[] = [], unresolved: Unresolved[] = [], reasons: string[] = [];
  if (card.venue.point && (card.venue.point.lat !== venue.point.lat || card.venue.point.lon !== venue.point.lon)) reasons.push('VENUE_LOCATION_UPDATED');
  for (const entry of card.schedule.entries) {
    if (entry.state === 'INCOMPLETE') { unresolved.push(...entry.reasons.map(code => ({ occurrence_key: entry.occurrence_key, code }))); continue; }
    for (let day = begin; day <= end; day += 86400000) {
      const date = new Date(day).toISOString().slice(0, 10), weekday = (new Date(day).getUTCDay() + 6) % 7;
      const dayStart = localEventInstant(date, 0, formatter), dayEnd = localEventInstant(date, 1440, formatter);
      if (dayStart === null || dayEnd === null) { unresolved.push({ occurrence_key: entry.occurrence_key, code: 'AMBIGUOUS_LOCAL_TIME', dates: [date] }); continue; }
      if (entry.end_utc !== null && entry.end_utc <= dayStart || entry.start_utc !== null && entry.start_utc >= dayEnd) continue;
      if (entry.state === 'FIXED') {
        if (entry.start_utc === null || entry.end_utc === null || entry.start_utc < dayStart || entry.end_utc > dayEnd) {
          unresolved.push({ occurrence_key: entry.occurrence_key, code: 'CROSS_DAY_SESSION_UNSUPPORTED', dates: [date] }); continue;
        }
        windows.push({ date, start_utc: entry.start_utc, end_utc: entry.end_utc, entry_id: entry.id, occurrence_key: entry.occurrence_key, kind: 'fixed' });
        continue;
      }
      if (!venue.hours.known_days[weekday]) { unresolved.push({ occurrence_key: entry.occurrence_key,
        code: venue.hours.state === 'INCOMPLETE' ? 'VENUE_HOURS_UNKNOWN' : 'VENUE_DAY_UNKNOWN', dates: [date] }); continue; }
      const entryWindows: Resolved[] = []; let ambiguous = false;
      for (const opening of venue.hours.weekly[weekday]!) {
        const start = localEventInstant(date, opening.start, formatter), finish = localEventInstant(date, opening.end, formatter);
        if (start === null || finish === null) { ambiguous = true; break; }
        const start_utc = Math.max(start, entry.start_utc ?? start), end_utc = Math.min(finish, entry.end_utc ?? finish);
        if (start_utc < end_utc) entryWindows.push({ date, start_utc, end_utc, entry_id: entry.id, occurrence_key: entry.occurrence_key, kind: 'visit_window' });
      }
      if (ambiguous) unresolved.push({ occurrence_key: entry.occurrence_key, code: 'AMBIGUOUS_LOCAL_TIME', dates: [date] });
      else windows.push(...entryWindows);
    }
  }
  reasons.push(...new Set(unresolved.map(item => item.code)));
  if (!windows.length && !unresolved.length) reasons.push('NO_WINDOWS_IN_SCOPE');
  return { state: unresolved.length ? windows.length ? 'PARTIAL' as const : 'INCOMPLETE' as const : 'READY' as const, windows, unresolved,
    point: { ...venue.point }, reasons,
    duration_basis: 'USER_ESTIMATE_REQUIRED' as const,
    valid_until: new Date(Math.min(Date.parse(card.source.valid_until), Date.parse(venue.source.valid_until))).toISOString() };
}
