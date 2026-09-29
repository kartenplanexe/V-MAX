import { z } from 'zod';

export const CandidatePlace = z.object({ place_id: z.string().min(1).max(200), name: z.string().min(1).max(500),
  location_label: z.string().max(1000).nullable(),
  estimated_visit_minutes: z.number().int().min(1).max(1440).optional(),
  event_visit: z.object({ starts_at: z.number().int().min(0).max(1439), ends_at: z.number().int().min(1).max(1440),
    schedule_kind: z.enum(['fixed', 'visit_window']), admission_upper_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  }).strict().refine(value => value.starts_at < value.ends_at).optional(),
  point: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict().optional(),
  source: z.object({ provider: z.enum(['2gis', 'kudago']), url: z.string().url().nullable(),
    fetched_at: z.string().datetime({ offset: true }), valid_until: z.string().datetime({ offset: true }),
    data_mode: z.enum(['live', 'test', 'prepared']) }).strict(),
}).strict();
export const SelectionGaps = z.array(z.object({ day_id: z.string().min(1).max(128),
  activity_id: z.string().min(1).max(128), reason: z.enum(['NO_ELIGIBLE_PLACES', 'COMBINATION_NOT_FOUND']) }).strict()).max(120);
export const CandidatePreview = z.object({ groups: z.array(z.object({
  day_id: z.string().min(1).max(128), activity_id: z.string().min(1).max(128),
  places: z.array(CandidatePlace).min(1).max(120),
}).strict()).min(1).max(120) }).strict();
