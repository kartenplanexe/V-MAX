import { expect, it } from 'vitest';
import type { PlanningView } from '../shared/planning-form.js';
import { extractionFidelityErrors, liveJourneyCases, localAcceptanceDate, simulatedJourneyChanges } from '../../scripts/live-journey-fidelity.mts';

const context = { now: '2026-09-28T22:30:00Z', locality: { timezone: 'Europe/Moscow' } };
const categories = { park: 'Парки', cafe: 'Кафе', museum: 'Музеи' };
function initial(two = true): Pick<PlanningView, 'draft' | 'provenance'> {
  const activity = (id: string, label: string, kind: 'route_walk' | 'place_visit', category: string) => ({
    id, label, intent_kind: kind, requirements: [], selection: { category_policy: 'related_allowed' as const, named_types: [] },
    categories: { state: 'matched', include_any: [category], exclude: [], region_id: '1', catalog_version: 'synthetic' },
  });
  return { draft: { locality: { id: 'city', name: 'Синтетический город', region_id: '1', timezone: 'Europe/Moscow' },
    shared: {}, points: {}, days: [{ day_id: 'd1', date: '2026-09-30', window: { start: '16:00', end: '16:20' },
      activities: [activity('walk', 'Прогулка', 'route_walk', 'park'), ...(two ? [activity('food', 'Еда', 'place_visit', 'cafe')] : [])],
      order: two ? [['walk', 'food']] : [] }] },
  provenance: { 'days.d1.date': 'user', 'days.d1.window.start': 'user', 'days.d1.window.end': 'user' } };
}

it('rejects a lost explicit window before any simulated UI edits can recreate it', () => {
  const draft = initial(); delete draft.draft.days[0]!.window;
  expect(extractionFidelityErrors(draft, liveJourneyCases[2], context, categories)).toContain('TEST_EXPLICIT_WINDOW_MISSING');
  expect(simulatedJourneyChanges(draft, liveJourneyCases[2], context, { lat: 0, lon: 0 }).map(change => change.op))
    .toEqual(['mobility', 'point']);
});

it('accepts exact extracted short constraints and rejects wider/defaulted replacements', () => {
  const draft = initial(); expect(extractionFidelityErrors(draft, liveJourneyCases[2], context, categories)).toEqual([]);
  draft.draft.days[0]!.window!.end = '20:00';
  expect(extractionFidelityErrors(draft, liveJourneyCases[2], context, categories)).toContain('TEST_EXPLICIT_TIME_MISMATCH');
  draft.draft.days[0]!.window!.end = '16:20'; draft.provenance['days.d1.window.end'] = 'suggested';
  expect(extractionFidelityErrors(draft, liveJourneyCases[2], context, categories)).toContain('TEST_EXPLICIT_END_NOT_EXTRACTED');
});

it('rejects a lost date even when the default happens to equal the requested local today', () => {
  const draft = initial(false); draft.draft.days[0]!.date = '2026-09-29';
  draft.draft.days[0]!.window = { start: '18:00', end: '21:00' }; draft.provenance['days.d1.date'] = 'suggested_today';
  expect(extractionFidelityErrors(draft, liveJourneyCases[3], context, categories)).toContain('TEST_EXPLICIT_DATE_NOT_EXTRACTED');
  draft.provenance['days.d1.date'] = 'user'; draft.draft.days[0]!.date = '2026-09-28';
  expect(extractionFidelityErrors(draft, liveJourneyCases[3], context, categories)).toContain('TEST_EXPLICIT_DATE_MISMATCH');
});

it('preserves after-18 today, including its proposed end, instead of shifting it to tomorrow', () => {
  const draft = initial(false); draft.draft.days[0]!.date = '2026-09-29';
  draft.draft.days[0]!.window = { start: '18:00', end: '21:00' }; draft.provenance['days.d1.window.end'] = 'suggested';
  expect(extractionFidelityErrors(draft, liveJourneyCases[3], context, categories)).toEqual([]);
  const before = structuredClone(draft);
  expect(simulatedJourneyChanges(draft, liveJourneyCases[3], context, { lat: 0, lon: 0 }).map(change => change.op))
    .toEqual(['mobility', 'point']);
  expect(draft).toEqual(before);
  draft.provenance['days.d1.window.start'] = 'suggested';
  expect(extractionFidelityErrors(draft, liveJourneyCases[3], context, categories)).toContain('TEST_EXPLICIT_START_NOT_EXTRACTED');
});

it('catches lost food, unrelated categories and reversed order independently of LLM guards', () => {
  const missing = initial(false);
  expect(extractionFidelityErrors(missing, liveJourneyCases[2], context, categories)).toEqual(expect.arrayContaining([
    'TEST_ACTIVITY_COUNT_MISMATCH', 'TEST_MEAL_ACTIVITY_OR_CATEGORIES_MISMATCH', 'TEST_ACTIVITY_ORDER_MISMATCH',
  ]));
  const unrelated = initial(); const meal = unrelated.draft.days[0]!.activities[1]!;
  if (meal.intent_kind !== 'event_visit') meal.categories.include_any.push('museum');
  expect(extractionFidelityErrors(unrelated, liveJourneyCases[2], context, categories)).toContain('TEST_MEAL_ACTIVITY_OR_CATEGORIES_MISMATCH');
  const reversed = initial(); reversed.draft.days[0]!.order = [['food', 'walk']];
  expect(extractionFidelityErrors(reversed, liveJourneyCases[2], context, categories)).toContain('TEST_ACTIVITY_ORDER_MISMATCH');
});

it('applies explicit simulated tomorrow 16–20 only to underspecified scenarios', () => {
  for (const scenario of liveJourneyCases.slice(0, 2)) {
    expect(simulatedJourneyChanges(initial(), scenario, context, { lat: 0, lon: 0 }).slice(0, 2)).toEqual([
      { op: 'date', day_id: 'd1', date: '2026-09-30' }, { op: 'window', day_ids: ['d1'], start: '16:00', end: '20:00' },
    ]);
  }
});

it('uses the parser context locality date and advances the calendar across a DST transition', () => {
  expect(localAcceptanceDate(context)).toBe('2026-09-29');
  expect(localAcceptanceDate({ now: '2026-10-24T22:30:00Z', locality: { timezone: 'Europe/Berlin' } }, 1)).toBe('2026-10-26');
});
