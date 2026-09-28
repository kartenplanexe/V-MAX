import { z } from 'zod';

export const CandidatePlace = z.object({ place_id: z.string().min(1).max(200), name: z.string().min(1).max(500),
  location_label: z.string().max(1000).nullable(),
  source: z.object({ provider: z.enum(['2gis', 'kudago']), url: z.string().url().nullable(),
    fetched_at: z.string().datetime({ offset: true }), valid_until: z.string().datetime({ offset: true }),
    data_mode: z.enum(['live', 'test', 'prepared']) }).strict(),
}).strict();
export const CandidatePreview = z.object({ groups: z.array(z.object({
  day_id: z.string().min(1).max(128), activity_id: z.string().min(1).max(128),
  places: z.array(CandidatePlace).min(1).max(120),
}).strict()).min(1).max(120) }).strict();
