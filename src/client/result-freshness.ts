import type { PlanningView } from '../shared/planning-form';

/** A warning deadline; opening a retained snapshot never refreshes its facts. */
export function placesStaleAt(plan: PlanningView['result']): string {
  const observed = plan?.candidate_preview?.groups.flatMap(group => group.places.map(place => Date.parse(place.source.fetched_at))) ?? [];
  return new Date(observed.length && observed.every(Number.isFinite) ? Math.min(...observed) + 30 * 60_000 : 0).toISOString();
}

// Older checkpoints lack an aggregate deadline; derive it from source timestamps.
export function resultValidUntil(view: Pick<PlanningView, 'expires_at' | 'result'>): string {
  const deadlines = [Date.parse(view.expires_at)];
  const plan = view.result;
  if (plan?.valid_until) deadlines.push(Date.parse(plan.valid_until));
  for (const group of plan?.candidate_preview?.groups ?? []) for (const place of group.places)
    deadlines.push(Date.parse(place.source.valid_until), Date.parse(place.source.fetched_at) + 5 * 60_000);
  for (const day of plan?.days ?? []) {
    for (const source of [...day.visits.map(visit => visit.source), ...(day.travel_segments ?? []).map(segment => segment.source)]) {
      if (!source) { deadlines.push(0); continue; }
      deadlines.push(Date.parse(source.valid_until), Date.parse(source.fetched_at) + 5 * 60_000);
    }
  }
  return new Date(deadlines.every(Number.isFinite) ? Math.min(...deadlines) : 0).toISOString();
}
