import type { z } from 'zod';
import type { PublicPlan } from '../shared/planning-form.js';
import type { AlternativeTarget } from '../shared/route-alternatives.js';

type Plan = z.infer<typeof PublicPlan>;
/** These identities restrict a NEW provider request; old facts are never copied. */
export function replacementRoster(result: Plan, target: AlternativeTarget) {
  const matches = result.days.flatMap(day => day.visits.map(visit => ({ ...visit, day_id: day.day_id })))
    .filter(visit => visit.day_id === target.day_id && visit.activity_id === target.activity_id && visit.place_id === target.place_id);
  if (matches.length !== 1) return null;
  return { version: 'stop-replacement.v1', target,
    days: result.days.map(day => ({ day_id: day.day_id,
      visits: day.visits.map(({ activity_id, place_id }) => ({ activity_id, place_id })) })) };
}
export function matchesReplacement(before: Plan, after: Plan, target: AlternativeTarget) {
  if (!['AVAILABLE', 'LIMITED'].includes(after.status) || before.days.length !== after.days.length) return false;
  return before.days.every((day, i) => {
    const next = after.days[i]!;
    if (day.day_id !== next.day_id || day.date !== next.date || day.visits.length !== next.visits.length) return false;
    return day.visits.every((visit, j) => {
      const changed = next.visits[j]!;
      const targetSlot = day.day_id === target.day_id && visit.activity_id === target.activity_id && visit.place_id === target.place_id;
      return visit.activity_id === changed.activity_id && (targetSlot
        ? changed.place_id !== target.place_id && !day.visits.some(old => old.place_id === changed.place_id)
        : visit.place_id === changed.place_id);
    });
  });
}
export function planFreshUntil(result: Plan): number {
  const visits = result.days.flatMap(day => day.visits);
  if (!visits.length) return 0;
  const dates = [...(result.valid_until ? [Date.parse(result.valid_until)] : []), ...visits.map(visit => Date.parse(visit.source?.valid_until ?? '')),
    ...result.days.flatMap(day => (day.travel_segments ?? []).map(segment => Date.parse(segment.source.valid_until)))];
  return dates.every(Number.isFinite) ? Math.min(...dates) : 0;
}
export function alternativeDelta(before: Plan, after: Plan, target: AlternativeTarget) {
  const difference = (a: number | null | undefined, b: number | null | undefined) =>
    typeof a === 'number' && typeof b === 'number' ? b - a : null;
  const travel = (plan: Plan) => plan.days.every(day => typeof day.total_safe_travel_minutes === 'number')
    ? plan.days.reduce((sum, day) => sum + day.total_safe_travel_minutes!, 0) : null;
  return { ends_at_minutes: difference(before.days.find(day => day.day_id === target.day_id)?.ends_at,
    after.days.find(day => day.day_id === target.day_id)?.ends_at),
  travel_minutes: difference(travel(before), travel(after)),
  expected_cost_minor: difference(before.total_expected_cost_minor, after.total_expected_cost_minor) };
}
