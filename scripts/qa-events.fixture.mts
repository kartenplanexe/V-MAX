/** Explicit synthetic loopback fixture; imported only by qa-ui-local.mts.
 * Uses real event normalization/selection/coordinator, never provider HTTP. */
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PlanningAuthenticator } from '../src/server/planning-routes.js';
import { PlanningSessions, PlanningSessionError } from '../src/server/planning-sessions.js';
import { FormDraft, type PlanningView } from '../src/shared/planning-form.js';
import { EventCardSchema, EventVenueSchema } from '../src/shared/event-catalog.js';
import { SearchEventsInputSchema, EventAvailabilityInputSchema, SelectEventInputSchema, RecheckEventInputSchema,
  type EventAvailabilityChoice, type EventSearchPreview } from '../src/shared/event-selection.js';
import { resolveEventAvailability, resolveEventSelection, buildEventPlanningCandidate } from '../src/server/event-availability.js';
import type { ResolvePlanEvents } from '../src/server/place-planning.js';

const point = { lat: 55.751, lon: 37.621 };
function fixture(id: number, date: string) {
  const source = { provider: 'kudago', url: `https://kudago.com/msk/event/qa-synthetic-${id}/`, fetched_at: new Date().toISOString(), valid_until: new Date(Date.now() + 300000).toISOString(), data_mode: 'test' };
  const occurrence_key = createHash('sha256').update(`fixture:${id}:${date}`).digest('hex');
  const start_utc = Date.parse(`${date}T${id === 1 ? '15' : '14'}:00:00+03:00`) / 1000, end_utc = Date.parse(`${date}T${id === 1 ? '16' : '20'}:00:00+03:00`) / 1000;
  const card = EventCardSchema.parse({ id: `kudago:event:${id}`, provider: 'kudago', provider_event_id: id,
    title: id === 1 ? 'Учебный концерт камерного оркестра' : id === 2 ? 'Учебная выставка городской фотографии' : 'Учебное событие без подтверждённых часов', source, provider_location: 'msk',
    venue: { provider_venue_id: 10, name: 'Учебный культурный центр', address: 'Учебная площадь, 2', point, is_closed: false }, categories: ['exhibition'],
    price: id === 1 ? { display: 'Бесплатно', kind: 'free', admission_upper_minor: 0, basis: 'admission', strict_eligible: true } : { display: 'От 300 ₽, условия на странице события', kind: 'text', admission_upper_minor: null, basis: 'admission', strict_eligible: false },
    age: { state: 'known', minimum: 6 }, schedule: { entries: [{ id: 'entry', occurrence_key, state: id === 1 ? 'FIXED' : 'VENUE_HOURS_REQUIRED', start_utc, end_utc, reasons: [] }] }, media: [], issues: [] });
  const venue = EventVenueSchema.parse({ provider: 'kudago', provider_venue_id: 10, title: 'Учебный культурный центр', point, is_closed: false, source: { ...source, url: 'https://kudago.com/msk/place/qa-synthetic/' }, timetable: id === 3 ? null : 'ежедневно 14:00–20:00',
    hours: { state: id === 3 ? 'INCOMPLETE' : 'KNOWN', known_days: Array(7).fill(id !== 3), weekly: Array(7).fill(id === 3 ? [] : [{ start: 840, end: 1200 }]), reasons: id === 3 ? ['VENUE_HOURS_UNKNOWN'] : [], policy_version: 'kudago-weekly-hours.v2' } });
  return { card, venue };
}
function available(id: number, day: PlanningView['draft']['days'][number], timezone: string) {
  const { card, venue } = fixture(id, day.date);
  return resolveEventAvailability(card, venue, { date: day.date, window: day.window!, timezone, providerLocation: 'msk', now: Date.now() });
}
export const resolveQaEvents: ResolvePlanEvents = async input => {
  const draft = FormDraft.parse(input.intent), candidates = [];
  for (const day of draft.days) for (const activity of day.activities) if (activity.intent_kind === 'event_visit') {
    const choice = available(Number(activity.target.event_id), day, draft.locality.timezone).choices.find(value => value.event_ref.occurrence_key === activity.target.occurrence_key);
    if (choice) candidates.push(buildEventPlanningCandidate(choice, { activityId: activity.id, dayId: day.day_id, localityId: draft.locality.id, regionId: draft.locality.region_id, visitDurationMinutes: activity.target.visit_duration_minutes, now: Date.now() }));
  }
  return { candidates, issues: [] };
};
export function registerQaEvents(app: FastifyInstance, sessions: PlanningSessions, authenticate: PlanningAuthenticator, remember: (owner: string, view: PlanningView) => void) {
  type Preview = { owner: string; id: string; version: number; dayId: string; search: EventSearchPreview; choices: Map<string, EventAvailabilityChoice> };
  const previews = new Map<string, Preview>();
  const current = (owner: string, id: string, version: number) => { const view = sessions.get(owner, id); if (view.version !== version) throw new PlanningSessionError('EVENT_PREVIEW_STALE', 409); return view; };
  const preview = (owner: string, id: string, version: number, searchId: string) => { current(owner, id, version); const value = previews.get(searchId); if (!value || value.owner !== owner || value.id !== id) throw new PlanningSessionError('EVENT_PREVIEW_NOT_FOUND', 404);
    if (value.version !== version) throw new PlanningSessionError('EVENT_PREVIEW_STALE', 409); if (Date.parse(value.search.expires_at) <= Date.now()) throw new PlanningSessionError('EVENT_PREVIEW_EXPIRED', 410); return value; };
  app.post<{ Params: { id: string } }>('/api/planning/drafts/:id/events/search', async request => {
    const input = SearchEventsInputSchema.parse(request.body), owner = authenticate(request)!, view = current(owner, request.params.id, input.base_version), day = view.draft.days.find(value => value.day_id === input.day_id)!;
    const search: EventSearchPreview = { search_id: randomUUID(), expires_at: new Date(Date.now() + 290000).toISOString(), coverage: 'PARTIAL', reason: 'PAGE_LIMIT', cards: [1, 2, 3].map(id => ({ choice_id: randomUUID(), card: fixture(id, day.date).card })) };
    previews.set(search.search_id, { owner, id: view.id, version: view.version, dayId: day.day_id, search, choices: new Map() }); return search;
  });
  app.post<{ Params: { id: string } }>('/api/planning/drafts/:id/events/availability', async request => {
    const input = EventAvailabilityInputSchema.parse(request.body), owner = authenticate(request)!, value = preview(owner, request.params.id, input.base_version, input.search_id);
    const card = value.search.cards.find(value => value.choice_id === input.choice_id)!.card, view = sessions.get(owner, value.id), day = view.draft.days.find(day => day.day_id === value.dayId)!;
    const result = available(card.provider_event_id, day, view.draft.locality.timezone);
    return { search_id: value.search.search_id, expires_at: value.search.expires_at, status: result.status, unresolved: result.unresolved, choices: result.choices.map(choice => { const id = randomUUID(); value.choices.set(id, choice); return { occurrence_choice_id: id, choice }; }) };
  });
  app.post<{ Params: { id: string } }>('/api/planning/drafts/:id/events/select', async request => {
    const input = SelectEventInputSchema.parse(request.body), owner = authenticate(request)!, value = preview(owner, request.params.id, input.base_version, input.search_id), choice = value.choices.get(input.occurrence_choice_id)!;
    const selected = resolveEventSelection(choice, input.visit_duration_minutes, Date.now());
    const view = sessions.selectEvent(owner, value.id, { base_version: input.base_version, event_id: input.event_id, day_id: input.day_id, ...(input.replace_activity_id ? { replace_activity_id: input.replace_activity_id } : {}), target: selected.target, evidence: selected.evidence }); remember(owner, view); return view;
  });
  app.post<{ Params: { id: string } }>('/api/planning/drafts/:id/events/recheck', async request => {
    const input = RecheckEventInputSchema.parse(request.body), owner = authenticate(request)!, before = current(owner, request.params.id, input.base_version), day = before.draft.days.find(value => value.day_id === input.day_id)!, activity = day.activities.find(value => value.id === input.activity_id)!;
    if (activity.intent_kind !== 'event_visit') throw new PlanningSessionError('UNKNOWN_EVENT_ACTIVITY', 422);
    const choice = available(Number(activity.target.event_id), day, before.draft.locality.timezone).choices.find(value => value.event_ref.occurrence_key === activity.target.occurrence_key)!;
    const selected = resolveEventSelection(choice, activity.target.visit_duration_minutes, Date.now()), view = sessions.recheckEvent(owner, before.id, { ...input, evidence: selected.evidence }); remember(owner, view); return view;
  });
}
