import { z } from 'zod';
import { FormEvent, PublicPlan } from './planning-form.js';

export const AlternativeTargetSchema = z.object({ day_id: z.string().min(1).max(128),
  activity_id: z.string().min(1).max(128), place_id: z.string().min(1).max(256) }).strict();
export const PreviewAlternativeInputSchema = FormEvent.extend(AlternativeTargetSchema.shape).strict();
export const ApplyAlternativeInputSchema = FormEvent.extend({ alternative_id: z.string().uuid() }).strict();
export const AlternativePreviewSchema = z.object({ draft_id: z.string(), base_version: z.number().int().nonnegative(),
  expires_at: z.string().datetime(), target: AlternativeTargetSchema,
  alternatives: z.array(z.object({ id: z.string().uuid(), result: PublicPlan,
    delta: z.object({ ends_at_minutes: z.number().int().nullable(), travel_minutes: z.number().int().nullable(),
      expected_cost_minor: z.number().int().nullable() }).strict() }).strict()).max(1),
  issues: z.array(z.string()),
}).strict();
export type AlternativePreview = z.infer<typeof AlternativePreviewSchema>;
export type AlternativeTarget = z.infer<typeof AlternativeTargetSchema>;
