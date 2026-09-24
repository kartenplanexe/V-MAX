import { z } from 'zod';

const Id = z.string().min(1).max(128);
export const DateValue = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const Time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/u);
export function minutes(value: string) { return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)); }
const Window = z.object({ start: Time, end: Time }).strict().refine(w => minutes(w.start) < minutes(w.end));
const Coordinates = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const Point = Coordinates.extend({ locality_id: Id, label: z.string().max(160).optional(),
  source: z.enum(['user_geolocation', 'user_map', 'place_choice']).optional() });
export const Mobility = z.enum(['walking', 'driving', 'cycling']);
export const Budget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unspecified') }).strict(), z.object({ kind: z.literal('unlimited') }).strict(),
  z.object({ kind: z.literal('limit'), amount_rub: z.number().min(0).max(100_000_000).multipleOf(0.01),
    basis: z.enum(['per_person', 'whole_party', 'unknown']), period: z.enum(['per_day', 'whole_trip', 'unknown']) }).strict(),
]);
const Activity = z.object({ id: Id, label: z.string().min(1).max(500),
  selection: z.object({ category_policy: z.enum(['related_allowed', 'named_types_only']), named_types: z.array(z.string()).max(100) }),
  requirements: z.array(z.object({ text: z.string().max(1000), strength: z.enum(['required', 'preferred']) })).max(100),
  categories: z.object({ state: z.string(), include_any: z.array(Id).max(2000), exclude: z.array(Id).max(2000),
    region_id: z.string().nullable(), catalog_version: z.string().nullable() }),
});
export const FormDraft = z.object({
  locality: z.object({ id: Id, name: z.string().max(200), region_id: Id, timezone: z.string().max(80) }),
  shared: z.object({ mobility: z.array(z.string()).max(10).optional(), budget: Budget.optional(),
    party: z.object({ total: z.number().int().min(1).max(100).optional(), child_ages: z.array(z.number().int().min(0).max(17)).max(99).optional() }).passthrough().optional(),
  }).passthrough(),
  points: z.object({ origin: Point.optional(), destination: Point.optional() }).strict(),
  days: z.array(z.object({ day_id: Id, date: DateValue, window: Window.optional(),
    activities: z.array(Activity).max(120), order: z.array(z.tuple([Id, Id])).max(1000),
    duration_constraint_minutes: z.number().int().positive().max(1440).optional(),
  })).min(1).max(31),
});
const DayIds = z.array(Id).min(1).max(31).refine(ids => new Set(ids).size === ids.length);
export const FormChange = z.discriminatedUnion('op', [
  z.object({ op: z.literal('window'), day_ids: DayIds, start: Time, end: Time }).strict(),
  z.object({ op: z.literal('date'), day_id: Id, date: DateValue }).strict(),
  z.object({ op: z.literal('mobility'), mode: z.string().min(1).max(40) }).strict(),
  z.object({ op: z.literal('budget'), value: Budget }).strict(),
  z.object({ op: z.literal('party'), total: z.number().int().min(1).max(100).nullable() }).strict(),
  z.object({ op: z.literal('point'), field: z.enum(['origin', 'destination']), point: Coordinates.extend({
    label: z.string().min(1).max(160), source: z.enum(['user_geolocation', 'user_map', 'place_choice']),
  }).strict() }).strict(),
  z.object({ op: z.literal('clear_destination') }).strict(),
  z.object({ op: z.literal('remove_activity'), day_id: Id, activity_id: Id }).strict(),
  z.object({ op: z.literal('order'), day_id: Id, activity_ids: z.array(Id).min(1).max(120) }).strict(),
]);
export const FormEvent = z.object({ base_version: z.number().int().nonnegative(), event_id: z.string().min(8).max(128) }).strict();
export const FormEdit = FormEvent.extend({ changes: z.array(FormChange).min(1).max(32) }).strict();
export const PublicPlan = z.object({ status: z.enum(['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'ERROR', 'NEEDS_INPUT']),
  data_mode: z.string().optional(), warnings: z.array(z.string()).default([]), issues: z.array(z.string()).optional(),
  total_expected_cost_minor: z.number().nullable().optional(),
  shortlist: z.object({ groups: z.array(z.object({ truncated: z.boolean() })) }).optional(),
  days: z.array(z.object({ day_id: Id, date: DateValue, status: z.string(), missing_activity_ids: z.array(Id),
    ends_at: z.number().optional(), total_safe_travel_minutes: z.number().optional(),
    visits: z.array(z.object({ activity_id: Id, place_id: Id, name: z.string(), point: Coordinates.optional(), starts_at: z.number(), ends_at: z.number(),
      travel_before_minutes: z.number(), arrival_buffer_minutes: z.number(), price_expected_minor: z.number().nullable(),
      warnings: z.array(z.string()),
      source: z.object({ provider: z.string(), fetched_at: z.string(), valid_until: z.string(), data_mode: z.string() }).optional(),
    })),
  })).default([]),
});
export interface FormIssue { code: string; field: string }
export interface PlanningView {
  id: string; version: number; phase: 'DRAFT' | 'CONFIRMED' | 'PLANNING' | 'RESULT';
  confirmed_version: number | null; expires_at: string; draft: z.infer<typeof FormDraft>;
  provenance: Record<string, string>; issues: FormIssue[];
  capabilities: { modes: string[]; data_mode: 'test' | 'live'; map_center?: { lat: number; lon: number } };
  result: z.infer<typeof PublicPlan> | null;
}
export type Change = z.infer<typeof FormChange>;
