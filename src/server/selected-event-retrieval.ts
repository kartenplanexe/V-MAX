import { z } from 'zod';
import { FormDraft, isEventActivity } from '../shared/planning-form.js';
import { SelectedEventTargetSchema } from '../shared/event-selection.js';
import { KUDAGO_LOCALITIES, type KudagoClient } from './kudago.js';
import { resolveSelectedEvent } from './event-availability.js';
import type { ResolvePlanEvents } from './place-planning.js';

const Evidence = z.object({ day_id: z.string(), activity_id: z.string(), date: z.string(),
  valid_until: z.string().datetime(), target: SelectedEventTargetSchema,
  point: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }) });
const Area = z.object({ south: z.number(), north: z.number(), west: z.number(), east: z.number() });
const sameTarget = (a: z.infer<typeof SelectedEventTargetSchema>, b: z.infer<typeof SelectedEventTargetSchema>) =>
  a.provider === b.provider && a.event_id === b.event_id && a.occurrence_key === b.occurrence_key && a.visit_duration_minutes === b.visit_duration_minutes;

export function createResolvePlanEvents(client: KudagoClient): ResolvePlanEvents {
  return async (input, options) => {
    const draft = FormDraft.parse(input.intent), evidence = z.array(Evidence).max(120).parse(input.event_evidence ?? []);
    const area = input.point_area === undefined ? undefined : Area.parse(input.point_area);
    const providerLocation = Object.entries(KUDAGO_LOCALITIES).find(([, locality]) =>
      locality.name.toLocaleLowerCase('ru') === draft.locality.name.trim().toLocaleLowerCase('ru') && locality.timezone === draft.locality.timezone)?.[0];
    const result: Awaited<ReturnType<ResolvePlanEvents>> = { candidates: [], issues: [] };
    for (const day of draft.days) for (const activity of day.activities) {
      if (!isEventActivity(activity)) continue;
      const gap = (code: string) => result.issues.push({ day_id: day.day_id, activity_id: activity.id, code });
      if (!providerLocation) { gap('EVENT_LOCALITY_UNSUPPORTED'); continue; }
      const previous = evidence.find(row => row.day_id === day.day_id && row.activity_id === activity.id && row.date === day.date && sameTarget(row.target, activity.target));
      if (!previous || Date.parse(previous.valid_until) <= +options.now()) { gap('EVENT_RECHECK_REQUIRED'); continue; }
      if (!day.window) { gap('WINDOW_REQUIRED'); continue; }
      const resolved = await resolveSelectedEvent(client, activity.target, { activityId: activity.id, dayId: day.day_id,
        date: day.date, window: day.window, localityId: draft.locality.id, regionId: draft.locality.region_id,
        providerLocation, timezone: draft.locality.timezone, ...(area ? { pointArea: area } : {}) },
      { requestBudget: options.requestBudget, shouldContinue: options.shouldContinue, now: () => +options.now(), previousPoint: previous.point });
      if (resolved.status === 'READY') result.candidates.push(resolved.candidate);
      else gap(resolved.code);
    }
    return result;
  };
}
