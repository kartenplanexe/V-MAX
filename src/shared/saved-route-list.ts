import { z } from 'zod';
import type { PlanningView } from './planning-form.js';
import type { SavedConditionsView } from './saved-conditions.js';

export const SavedRouteListSchema = z.object({ items: z.array(z.object({ id: z.string(), title: z.string(),
  revision: z.number().int().nonnegative(), updated_at: z.string().datetime(), expires_at: z.string().datetime(),
  active: z.boolean(), can_open: z.boolean(), has_fresh_result: z.boolean() }).strict()).max(50),
  next_cursor: z.string().nullable() }).strict();
export type SavedRouteList = z.infer<typeof SavedRouteListSchema>;
export const ActivateSavedRouteInputSchema = z.object({ event_id: z.string().min(8).max(128) }).strict();
export const DeleteSavedRouteInputSchema = ActivateSavedRouteInputSchema.extend({ base_revision: z.number().int().nonnegative() }).strict();
export type SavedRouteActivation = { view: PlanningView | null; saved?: SavedConditionsView; expiredRoute?: string };
