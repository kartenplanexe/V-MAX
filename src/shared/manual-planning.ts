import { z } from 'zod';
import { DateValue, Mobility, minutes } from './planning-form.js';
import { ActivityChoiceSchema } from './activity-choice.js';

const LocalityToken = z.string().min(1).max(16000);
const Time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/u);
export const ManualOptionsInput = z.object({ locality_token: LocalityToken }).strict();
export const ManualOptions = z.object({ catalog_version: z.string().min(1), locality_name: z.string(),
  walking_available: z.boolean(), modes: z.array(Mobility),
  categories: z.array(z.object({ id: z.string(), name: z.string(), estimated_visit_minutes: z.number().int().positive() }).strict()).max(2000),
}).strict();
export const ManualRequestInput = z.object({ event_id: z.string().min(8).max(128), locality_token: LocalityToken,
  catalog_version: z.string().min(1).max(200), mobility: Mobility,
  days: z.array(z.object({ date: DateValue, start: Time, end: Time, ordered: z.boolean(),
    activities: z.array(ActivityChoiceSchema).max(120),
  }).strict().refine(day => minutes(day.start) < minutes(day.end))).min(1).max(31)
    .refine(days => new Set(days.map(day => day.date)).size === days.length && days.reduce((sum, day) => sum + day.activities.length, 0) <= 120),
}).strict();
export type ManualRequest = z.infer<typeof ManualRequestInput>;
export type ManualChoices = z.infer<typeof ManualOptions>;
