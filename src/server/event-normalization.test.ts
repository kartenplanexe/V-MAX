import { describe, expect, it } from 'vitest';
import { normalizeKudagoEvent, normalizeKudagoVenue, parseVenueTimetable, resolveEventVisitWindows } from './event-normalization.js';

const fetchedAt = '2026-09-27T09:00:00Z', validUntil = '2026-09-27T09:05:00Z';
const now = { fetchedAt, validUntil, dataMode: 'test' as const };
const start = Date.parse('2026-09-28T10:00:00Z') / 1000;
function date(patch = {}) { return { start, end: start + 3600, is_continuous: false, is_endless: false,
  is_startless: false, use_place_schedule: false, schedules: [], ...patch }; }
function event(patch = {}) { return { id: 123, title: 'Synthetic exhibition', site_url: 'https://kudago.com/nnv/event/synthetic/',
  dates: [date()], place: { id: 44, title: 'Synthetic venue', coords: { lat: 56.32, lon: 44 }, is_closed: false },
  categories: ['exhibitions'], age_restriction: '6+', price: 'от 500 ₽', is_free: false, ...patch }; }
function venue(timetable = 'пн–пт 10:00–18:00, сб, вс 11:00–17:00') {
  return normalizeKudagoVenue({ id: 44, title: 'Synthetic venue', site_url: 'https://kudago.com/nnv/place/synthetic/',
    timetable, coords: { lat: 56.32, lon: 44 }, is_closed: false }, now);
}

describe('source-neutral event facts', () => {
  it('uses a separate event namespace, exact finite session, safe plain display, and no guessed admission price', () => {
    const card = normalizeKudagoEvent(event(), now);
    expect(card.id).toBe('kudago:event:123');
    expect(card.schedule.entries[0]).toMatchObject({ state: 'FIXED', start_utc: start, end_utc: start + 3600 });
    expect(card.price).toMatchObject({ kind: 'text', admission_upper_minor: null, strict_eligible: false });
    expect(card.age).toEqual({ state: 'known', minimum: 6 });
    expect(card.media).toEqual([]);
    expect(card.source).toMatchObject({ provider: 'kudago', data_mode: 'test', valid_until: validUntil });
    expect(JSON.stringify(card)).not.toMatch(/rubric|include_any|body_text/u);
  });
  it.each([
    [date({ end: start }), 'DURATION_UNKNOWN'],
    [{ start, end: start + 3600 }, 'FLAGS_UNKNOWN'],
    [date({ end: start + 15 * 3600 }), 'LONG_INTERVAL_UNSUPPORTED'],
    [date({ schedules: [{ arbitrary: true }] }), 'RECURRENCE_UNSUPPORTED'],
    [date({ is_continuous: true }), 'CONTINUOUS_UNSUPPORTED'],
    [date({ is_endless: true }), 'UNBOUNDED_SESSION'],
  ])('does not invent a session from incomplete or unsupported dates: %j', (raw, reason) => {
    const card = normalizeKudagoEvent(event({ dates: [raw] }), now);
    expect(card.schedule.entries[0]).toMatchObject({ state: 'INCOMPLETE', reasons: expect.arrayContaining([reason]) });
  });
  it('keeps venue-based long periods separate from fixed events and flags absent coordinates', () => {
    const card = normalizeKudagoEvent(event({ place: { id: 44 }, dates: [date({ end: start + 30 * 86400, use_place_schedule: true })] }), now);
    expect(card.schedule.entries[0]?.state).toBe('VENUE_HOURS_REQUIRED');
    expect(card.issues).toContain('VENUE_COORDINATES_UNKNOWN');
    expect(card.venue?.point).toBeNull();
  });
  it('does not turn missing or contradictory price and age into permission', () => {
    expect(normalizeKudagoEvent(event({ price: '', is_free: false, age_restriction: '' }), now)).toMatchObject({
      price: { kind: 'unknown', admission_upper_minor: null }, age: { state: 'unknown', minimum: null } });
    expect(normalizeKudagoEvent(event({ price: 'бесплатно', is_free: true }), now).price).toMatchObject({
      kind: 'free', admission_upper_minor: 0, strict_eligible: true });
    expect(normalizeKudagoEvent(event({ price: '500', is_free: true }), now).price).toMatchObject({ kind: 'conflict', strict_eligible: false });
    expect(normalizeKudagoEvent(event({ age_restriction: 'детям до 12' }), now).age.state).toBe('unknown');
  });
  it('requires explicit rights evidence, attribution and allowed HTTPS host for media', () => {
    const raw = event({ images: [{ image: 'https://media.kudago.com/images/test.jpg', source: { name: 'Synthetic author', link: 'https://example.org/license' } }] });
    expect(normalizeKudagoEvent(raw, now).media).toEqual([]);
    const media = { ...now, mediaLicense: { basis: 'Synthetic licensed fixture', sourcePage: raw.site_url,
      attributionText: 'Synthetic author', attributionUrl: 'https://example.org/license' } };
    expect(normalizeKudagoEvent(raw, media).media[0]).toMatchObject({ kind: 'event_poster', rights_basis: media.mediaLicense.basis });
    expect(normalizeKudagoEvent({ ...raw, images: [{ image: 'https://media.kudago.com.evil.test/a' }] }, media).media).toEqual([]);
    expect(() => normalizeKudagoEvent(event({ site_url: 'https://evil.test/event/' }), now)).toThrow();
    expect(() => normalizeKudagoEvent(event(), { ...now, validUntil: fetchedAt })).toThrow();
  });
});

describe('fully parsed venue timetable and period intersection', () => {
  it('accepts day ranges, day lists, closed days and separate opening intervals', () => {
    const parsed = parseVenueTimetable('пн выходной; вт–пт 10:00–13:00, 14:00–18:00; сб, вс 11:00–17:00');
    expect(parsed.state).toBe('KNOWN');
    expect(parsed.weekly[0]).toEqual([]);
    expect(parsed.weekly[1]).toEqual([{ start: 600, end: 780 }, { start: 840, end: 1080 }]);
    expect(parsed.weekly[6]).toEqual([{ start: 660, end: 1020 }]);
  });
  it.each(['пн–пт 10:00–18:00 кроме праздников', 'ежедневно 10:00–18:00, касса до 17:00',
    'пн–вс 10:00–18:00; пн 12:00–19:00', 'ежедневно 20:00–02:00'])('refuses unknown qualifiers, conflicts and unsupported overnight: %s', text => {
    expect(parseVenueTimetable(text).state).toBe('INCOMPLETE');
  });
  it('intersects the real period with local venue hours and never uses long-period endpoints as daily hours', () => {
    const card = normalizeKudagoEvent(event({ dates: [date({ start: Date.parse('2026-09-28T09:30:00Z') / 1000,
      end: Date.parse('2026-09-29T09:00:00Z') / 1000, use_place_schedule: true })] }), now);
    const result = resolveEventVisitWindows(card, venue(), { fromDate: '2026-09-28', toDate: '2026-09-29', timezone: 'Europe/Moscow' });
    expect(result.state).toBe('READY');
    expect(result.windows.map(w => [new Date(w.start_utc * 1000).toISOString(), new Date(w.end_utc * 1000).toISOString()])).toEqual([
      ['2026-09-28T09:30:00.000Z', '2026-09-28T15:00:00.000Z'], ['2026-09-29T07:00:00.000Z', '2026-09-29T09:00:00.000Z']]);
    expect(result.duration_basis).toBe('USER_ESTIMATE_REQUIRED');
  });
  it('does not route an unrelated/closed venue, unsupported recurrence or unknown holiday-qualified hours', () => {
    const card = normalizeKudagoEvent(event({ dates: [date({ use_place_schedule: true })] }), now);
    const scope = { fromDate: '2026-09-28', toDate: '2026-09-28', timezone: 'Europe/Moscow' };
    expect(resolveEventVisitWindows(card, { ...venue(), provider_venue_id: 99 }, scope).state).toBe('INCOMPLETE');
    expect(resolveEventVisitWindows(card, { ...venue(), is_closed: true }, scope).state).toBe('INCOMPLETE');
    expect(resolveEventVisitWindows(card, venue('ежедневно 10:00–18:00 кроме праздников'), scope).state).toBe('INCOMPLETE');
    const recurring = normalizeKudagoEvent(event({ dates: [date({ use_place_schedule: true, schedules: [{}] })] }), now);
    expect(resolveEventVisitWindows(recurring, venue(), scope).state).toBe('INCOMPLETE');
  });
  it('converts 24:00 to the next local day, handles a real DST offset change, and refuses ambiguous wall time', () => {
    const card = normalizeKudagoEvent(event({ dates: [date({ is_startless: true, is_endless: true, use_place_schedule: true })] }), now);
    const fullDay = resolveEventVisitWindows(card, venue('ежедневно 00:00–24:00'),
      { fromDate: '2026-10-25', toDate: '2026-10-25', timezone: 'Europe/Berlin' });
    expect(fullDay.state).toBe('READY');
    expect(fullDay.windows[0]!.end_utc - fullDay.windows[0]!.start_utc).toBe(25 * 3600);
    const fold = resolveEventVisitWindows(card, venue('ежедневно 02:30–04:00'),
      { fromDate: '2026-10-25', toDate: '2026-10-25', timezone: 'Europe/Berlin' });
    expect(fold).toMatchObject({ state: 'INCOMPLETE', reasons: ['AMBIGUOUS_LOCAL_TIME'] });
    const gap = resolveEventVisitWindows(card, venue('ежедневно 02:30–04:00'),
      { fromDate: '2026-03-29', toDate: '2026-03-29', timezone: 'Europe/Berlin' });
    expect(gap.state).toBe('INCOMPLETE');
    const invalid = resolveEventVisitWindows(card, venue(), { fromDate: '2026-09-28', toDate: '2026-09-28', timezone: 'INVALID' });
    expect(invalid.state).toBe('INCOMPLETE');
  });
  it('preserves known weekdays independently of an unknown day and never calls unknown closed', () => {
    const partial = venue('вт–вс 11:00–19:00');
    expect(partial.hours.state).toBe('PARTIAL');
    expect(partial.hours.known_days).toEqual([false, true, true, true, true, true, true]);
    const card = normalizeKudagoEvent(event({ dates: [date({ is_startless: true, is_endless: true, use_place_schedule: true })] }), now);
    const tuesday = resolveEventVisitWindows(card, partial, { fromDate: '2026-09-29', toDate: '2026-09-29', timezone: 'Europe/Moscow' });
    expect(tuesday.state).toBe('READY'); expect(tuesday.windows).toHaveLength(1);
    const both = resolveEventVisitWindows(card, partial, { fromDate: '2026-09-28', toDate: '2026-09-29', timezone: 'Europe/Moscow' });
    expect(both.state).toBe('PARTIAL'); expect(both.windows).toHaveLength(1);
    expect(both.unresolved).toContainEqual(expect.objectContaining({ code: 'VENUE_DAY_UNKNOWN', dates: ['2026-09-28'] }));
  });
  it('combines valid fixed and venue-based entries, retains unknown entries, and uses only fresh venue coordinates', () => {
    const card = normalizeKudagoEvent(event({ dates: [date(), date({ is_startless: true, is_endless: true, use_place_schedule: true }), date({ end: start })] }), now);
    const fresh = { ...venue(), point: { lat: 56.4, lon: 44.2 } };
    const result = resolveEventVisitWindows(card, fresh, { fromDate: '2026-09-28', toDate: '2026-09-28', timezone: 'Europe/Moscow' });
    expect(result.state).toBe('PARTIAL'); expect(result.windows.map(w => w.kind)).toEqual(['fixed', 'visit_window']);
    expect(result.point).toEqual(fresh.point); expect(result.reasons).toContain('VENUE_LOCATION_UPDATED');
    expect(result.unresolved).toContainEqual(expect.objectContaining({ code: 'DURATION_UNKNOWN' }));
  });
  it('keeps occurrence identities stable across reordering and changes them when slot or venue changes', () => {
    const a = date(), b = date({ start: start + 86400, end: start + 86400 + 3600 });
    const first = normalizeKudagoEvent(event({ dates: [a, b] }), now), reordered = normalizeKudagoEvent(event({ dates: [b, a] }), now);
    expect(first.schedule.entries[0]?.occurrence_key).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.schedule.entries[0]?.occurrence_key).toBe(reordered.schedule.entries[1]?.occurrence_key);
    expect(normalizeKudagoEvent(event({ dates: [date({ end: start + 7200 })] }), now).schedule.entries[0]?.occurrence_key)
      .not.toBe(first.schedule.entries[0]?.occurrence_key);
    expect(normalizeKudagoEvent(event({ place: { id: 45 } }), now).schedule.entries[0]?.occurrence_key)
      .not.toBe(first.schedule.entries[0]?.occurrence_key);
  });
});
