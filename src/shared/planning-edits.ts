import type { Change, PlanningView } from './planning-form.js';
import { orderWithoutActivity } from './activity-order.js';
type Draft = PlanningView['draft'];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function changesFor(view: PlanningView, draft: Draft): Change[] {
  const original = view.draft, changes: Change[] = [];
  for (const day of draft.days) {
    const before = original.days.find(d => d.day_id === day.day_id)!;
    const removed = before.activities.filter(a => !day.activities.some(value => value.id === a.id)).map(a => a.id);
    const additions = day.activities.filter(a => !before.activities.some(value => value.id === a.id)).map(activity => {
      if (activity.intent_kind === 'event_visit' || !activity.categories.catalog_version) throw new Error('Выберите занятие из доступного каталога.');
      return { activity_id: activity.id, catalog_version: activity.categories.catalog_version,
        choice: activity.intent_kind === 'route_walk' ? { kind: 'walk' as const } : { kind: 'place' as const, category_ids: activity.categories.include_any } };
    });
    if (removed.length || additions.length) changes.push({ op: 'activities', day_id: day.day_id, remove_ids: removed, additions });
    if (day.date !== before.date) changes.push({ op: 'date', day_id: day.day_id, date: day.date });
    for (const activity of day.activities) {
      const previous = before.activities.find(value => value.id === activity.id);
      if (activity.intent_kind !== 'event_visit' && previous?.intent_kind !== 'event_visit' &&
          (activity.duration_minutes !== previous?.duration_minutes || !same(activity.requirements, previous?.requirements ?? [])))
        changes.push({ op: 'activity_details', day_id: day.day_id, activity_id: activity.id,
          duration_minutes: activity.duration_minutes ?? null, requirements: activity.requirements });
    }
    if (day.window && !same(day.window, before.window)) changes.push({ op: 'window', day_ids: [day.day_id], ...day.window });
    const remainingOrder = removed.reduce((order, id) => orderWithoutActivity(order, id), before.order);
    if (!same(day.order, remainingOrder)) changes.push({ op: 'order', day_id: day.day_id,
      activity_ids: day.activities.map(a => a.id), precedence: day.order });
  }
  if (!same(draft.shared.mobility, original.shared.mobility)) changes.push({ op: 'mobility', mode: draft.shared.mobility?.[0] ?? '' });
  if (draft.shared.search_radius_meters !== original.shared.search_radius_meters && draft.shared.search_radius_meters !== undefined)
    changes.push({ op: 'search_radius', meters: draft.shared.search_radius_meters });
  if (!same(draft.shared.budget, original.shared.budget) && draft.shared.budget) changes.push({ op: 'budget', value: draft.shared.budget });
  if (draft.shared.party?.total !== original.shared.party?.total || !same(draft.shared.party?.child_ages, original.shared.party?.child_ages))
    changes.push({ op: 'party', total: draft.shared.party?.total ?? null, child_ages: draft.shared.party?.child_ages ?? null });
  for (const field of ['origin', 'destination'] as const) {
    const point = draft.points[field];
    if (!same(point, original.points[field])) {
      if (point) changes.push({ op: 'point', field, point: { lat: point.lat, lon: point.lon, label: point.label ?? 'Выбранная точка', source: point.source ?? 'place_choice' } });
      else if (field === 'destination') changes.push({ op: 'clear_destination' });
    }
  }
  if (original.shared.destination_text && !draft.shared.destination_text && !draft.points.destination && !changes.some(change => change.op === 'clear_destination')) changes.push({ op: 'clear_destination' });
  return changes;
}
