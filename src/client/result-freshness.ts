import type { PlanningView } from '../shared/planning-form';

// Older checkpoints may not carry the aggregate deadline. Visible sources may
// shorten it; neither a new render nor a longer draft TTL renews provider data.
export function resultValidUntil(view: Pick<PlanningView, 'expires_at' | 'result'>): string {
  const deadlines = [Date.parse(view.expires_at)];
  const plan = view.result;
  if (plan?.valid_until) deadlines.push(Date.parse(plan.valid_until));
  for (const day of plan?.days ?? []) {
    for (const source of [...day.visits.map(visit => visit.source), ...(day.travel_segments ?? []).map(segment => segment.source)]) {
      if (!source) { deadlines.push(0); continue; }
      deadlines.push(Date.parse(source.valid_until), Date.parse(source.fetched_at) + 5 * 60_000);
    }
  }
  return new Date(deadlines.every(Number.isFinite) ? Math.min(...deadlines) : 0).toISOString();
}
