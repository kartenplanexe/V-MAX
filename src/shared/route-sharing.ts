import { z } from 'zod';
import { PublicPlan } from './planning-form.js';
import { SavedUserConditionsV1Schema } from './saved-conditions.js';

const Id = z.string().min(1).max(128);
const Event = z.string().min(8).max(128);
const Timestamp = z.string().datetime({ offset: true });
export const ShareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const SharedConditionsSchema = SavedUserConditionsV1Schema.refine(value => Object.keys(value.queries).length === 0,
  { path: ['queries'], message: 'Shared conditions cannot contain address or request queries.' });
export const CreateShareInputSchema = z.object({ draft_id: Id, base_revision: z.number().int().nonnegative(),
  event_id: Event, include_private_points: z.boolean().default(false) }).strict();
export const ResolveShareInputSchema = z.object({ token: ShareTokenSchema }).strict();
export const ImportShareInputSchema = ResolveShareInputSchema.extend({ event_id: Event,
  locality_token: z.string().min(1).max(16000) }).strict();
export const RevokeShareInputSchema = z.object({ share_id: Id, event_id: Event }).strict();
export const ShareCreatedSchema = z.object({ share_id: Id, token: ShareTokenSchema,
  deep_link: z.string().url(), expires_at: Timestamp }).strict();
export const SharePreviewSchema = z.object({ expires_at: Timestamp, conditions: SharedConditionsSchema,
  omissions: z.array(z.enum(['origin', 'destination'])).max(2), result: PublicPlan.nullable(),
  result_expires_at: Timestamp.nullable() }).strict();
export type ShareCreated = z.infer<typeof ShareCreatedSchema>;
export type SharePreview = z.infer<typeof SharePreviewSchema>;
