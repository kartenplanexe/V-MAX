import type { Change, PlanningView } from '../src/shared/planning-form.js';

/** Independent acceptance expectations for synthetic utterances, not parser policy. */
export const liveJourneyCases = [
  { text: 'хочу погулять', activityCount: 1, date: 'unspecified', time: 'unspecified', route: 'available' },
  { text: 'хочу погулять, а потом поесть', activityCount: 2, date: 'unspecified', time: 'unspecified', route: 'available' },
  { text: 'Завтра с 16:00 до 16:20 хочу погулять, а потом поесть', activityCount: 2, date: 'tomorrow', time: 'short_window', route: 'infeasible' },
  { text: 'Хочу погулять сегодня в Нижнем Новгороде после 18', activityCount: 1, date: 'today', time: 'after_18', route: 'available' },
] as const;
export type LiveJourneyCase = typeof liveJourneyCases[number];
type InitialDraft = Pick<PlanningView, 'draft' | 'provenance'>;
type ClockContext = { now: string; locality: { timezone: string } };

export function localAcceptanceDate(context: ClockContext, offset = 0): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: context.locality.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(context.now)).map(part => [part.type, part.value]));
  // Calendar arithmetic after resolving the locality's date; adding 24 hours to
  // an instant can select the wrong local day across a daylight-saving change.
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

const mealRubrics = new Set(['кафе', 'рестораны', 'столовые', 'быстрое питание', 'пиццерии',
  'бистро', 'кафе-кондитерские', 'рестораны быстрого питания', 'суши-бары']);

/** Fail before simulated UI input can hide lost text constraints. Codes only. */
export function extractionFidelityErrors(initial: InitialDraft, scenario: LiveJourneyCase,
  context: ClockContext, categoryNames: Record<string, string> = {}): string[] {
  const errors: string[] = [];
  if (initial.draft.days.length !== 1) return ['TEST_DAY_COUNT_MISMATCH'];
  const day = initial.draft.days[0]!;
  if (day.activities.length !== scenario.activityCount) errors.push('TEST_ACTIVITY_COUNT_MISMATCH');
  const walks = day.activities.filter(activity => activity.intent_kind === 'route_walk' || activity.intent_kind === 'area_walk');
  if (walks.length !== 1) errors.push('TEST_WALK_ACTIVITY_MISSING');
  if (scenario.activityCount === 2) {
    const meals = day.activities.filter(activity => activity.intent_kind === 'place_visit' &&
      activity.categories.include_any.length > 0 && activity.categories.include_any.every(id =>
        mealRubrics.has((categoryNames[id] ?? '').trim().toLocaleLowerCase('ru-RU'))));
    if (meals.length !== 1) errors.push('TEST_MEAL_ACTIVITY_OR_CATEGORIES_MISMATCH');
    if (walks.length !== 1 || meals.length !== 1 || day.order.length !== 1 ||
        day.order[0]?.[0] !== walks[0]!.id || day.order[0]?.[1] !== meals[0]!.id)
      errors.push('TEST_ACTIVITY_ORDER_MISMATCH');
  } else if (day.order.length) errors.push('TEST_UNEXPECTED_ACTIVITY_ORDER');
  for (const activity of day.activities) {
    if (activity.intent_kind === 'event_visit' || activity.categories.state !== 'matched' || !activity.categories.include_any.length)
      errors.push('TEST_ACTIVITY_UNRESOLVED');
  }
  if (scenario.date !== 'unspecified') {
    const expected = localAcceptanceDate(context, scenario.date === 'tomorrow' ? 1 : 0);
    if (day.date !== expected) errors.push('TEST_EXPLICIT_DATE_MISMATCH');
    if (initial.provenance[`days.${day.day_id}.date`] !== 'user') errors.push('TEST_EXPLICIT_DATE_NOT_EXTRACTED');
  }
  if (scenario.time !== 'unspecified') {
    if (!day.window) errors.push('TEST_EXPLICIT_WINDOW_MISSING');
    else if ((scenario.time === 'short_window' && (day.window.start !== '16:00' || day.window.end !== '16:20')) ||
             (scenario.time === 'after_18' && day.window.start !== '18:00')) errors.push('TEST_EXPLICIT_TIME_MISMATCH');
    if (initial.provenance[`days.${day.day_id}.window.start`] !== 'user') errors.push('TEST_EXPLICIT_START_NOT_EXTRACTED');
    if (scenario.time === 'short_window' && initial.provenance[`days.${day.day_id}.window.end`] !== 'user')
      errors.push('TEST_EXPLICIT_END_NOT_EXTRACTED');
  }
  return [...new Set(errors)];
}

export function simulatedJourneyChanges(initial: InitialDraft, scenario: LiveJourneyCase,
  context: ClockContext, center: { lat: number; lon: number }): Change[] {
  const dayId = initial.draft.days[0]!.day_id;
  const changes: Change[] = [];
  // Only the two underspecified requests receive these explicit UI choices.
  // Text-supplied dates/windows, including the after-18 end suggestion, survive.
  if (scenario.date === 'unspecified') changes.push({ op: 'date', day_id: dayId, date: localAcceptanceDate(context, 1) });
  if (scenario.time === 'unspecified') changes.push({ op: 'window', day_ids: [dayId], start: '16:00', end: '20:00' });
  changes.push({ op: 'mobility', mode: 'walking' },
    { op: 'point', field: 'origin', point: { ...center, label: 'Центр города — тестовая точка', source: 'user_map' } });
  return changes;
}
