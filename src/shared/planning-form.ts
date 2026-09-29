import { z } from 'zod';
import { CandidatePreview } from './candidate-preview-schema.js';
import { SelectedEventTargetSchema, type SelectedEventDisplay } from './event-selection.js';
import { ActivityChoiceSchema } from './activity-choice.js';
import { MIN_SEARCH_RADIUS_METERS, MAX_SEARCH_RADIUS_METERS } from './search-radius.js';

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
export const Mobility = z.enum(['walking', 'driving', 'cycling', 'public_transport']);
export const SearchRadiusMeters = z.number().int().min(MIN_SEARCH_RADIUS_METERS).max(MAX_SEARCH_RADIUS_METERS);
export const Budget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unspecified') }).strict(), z.object({ kind: z.literal('unlimited') }).strict(),
  z.object({ kind: z.literal('limit'), amount_rub: z.number().min(0).max(100_000_000).multipleOf(0.01),
    basis: z.enum(['per_person', 'whole_party', 'unknown']), period: z.enum(['per_day', 'whole_trip', 'unknown']),
    enforcement: z.enum(['strict', 'estimated']).optional(),
    price_basis_assumption: z.literal('per_person').optional() }).strict(),
]);
const ActivityCommon = { id: Id, label: z.string().min(1).max(500),
  requirements: z.array(z.object({ text: z.string().max(1000), strength: z.enum(['required', 'preferred']) })).max(100) };
export const PlaceActivitySchema = z.object({ ...ActivityCommon, target: z.never().optional(),
  duration_minutes: z.number().int().min(1).max(1440).optional(),
  intent_kind: z.enum(['route_walk', 'area_walk', 'place_visit']).optional(),
  selection: z.object({ category_policy: z.enum(['related_allowed', 'named_types_only']), named_types: z.array(z.string()).max(100) }),
  categories: z.object({ state: z.string(), include_any: z.array(Id).max(2000), exclude: z.array(Id).max(2000),
    region_id: z.string().nullable(), catalog_version: z.string().nullable() }),
});
export const EventActivitySchema = z.object({ ...ActivityCommon, intent_kind: z.literal('event_visit'),
  target: SelectedEventTargetSchema }).strict();
const Activity = z.union([PlaceActivitySchema, EventActivitySchema]);
export const InputClarification = z.object({ id: Id,
  field: z.enum(['request', 'locality', 'dates', 'time', 'budget', 'mobility', 'origin', 'destination', 'party', 'activities', 'order', 'requirements', 'scope']),
  day_ids: z.array(Id).max(31), text: z.string().min(1).max(4000),
  reason: z.enum(['ambiguous', 'conflict', 'not_representable']),
}).strict();
export type Activity = z.infer<typeof Activity>;
export function isEventActivity(activity: Activity): activity is z.infer<typeof EventActivitySchema> {
  return activity.target?.kind === 'event';
}
export const FormDraft = z.object({
  clarifications: z.array(InputClarification).max(100).optional(),
  locality: z.object({ id: Id, name: z.string().max(200), region_id: Id, timezone: z.string().max(80) }),
  shared: z.object({ mobility: z.array(z.string()).max(10).optional(), budget: Budget.optional(), search_radius_meters: SearchRadiusMeters.optional(),
    party: z.object({ total: z.number().int().min(1).max(100).optional(), child_ages: z.array(z.number().int().min(0).max(17)).max(99).optional() }).passthrough().optional(),
  }).passthrough(),
  points: z.object({ origin: Point.optional(), destination: Point.optional() }).strict(),
  days: z.array(z.object({ day_id: Id, date: DateValue, window: Window.optional(),
    activities: z.array(Activity).max(120), order: z.array(z.tuple([Id, Id])).max(1000),
    duration_constraint_minutes: z.number().int().positive().max(1440).optional(),
  })).min(1).max(31),
}).superRefine((draft, context) => {
  const questions = draft.clarifications ?? [];
  if (new Set(questions.map(question => question.id)).size !== questions.length)
    context.addIssue({ code: 'custom', path: ['clarifications'], message: 'Duplicate clarification IDs.' });
  questions.forEach((question, index) => {
    if (new Set(question.day_ids).size !== question.day_ids.length || question.day_ids.some(id => !draft.days.some(day => day.day_id === id)))
      context.addIssue({ code: 'custom', path: ['clarifications', index, 'day_ids'], message: 'Invalid clarification day references.' });
  });
});
const DayIds = z.array(Id).min(1).max(31).refine(ids => new Set(ids).size === ids.length);
export const FormChange = z.discriminatedUnion('op', [
  z.object({ op: z.literal('activity_details'), day_id: Id, activity_id: Id,
    duration_minutes: z.number().int().min(1).max(1440).nullable(),
    requirements: z.array(z.object({ text: z.string().max(1000), strength: z.enum(['required', 'preferred']) }).strict()).max(100) }).strict(),
  z.object({ op: z.literal('discard_clarification'), clarification_id: Id }).strict(),
  z.object({ op: z.literal('resolve_clarification'), clarification_id: Id }).strict(),
  z.object({ op: z.literal('activity_choice'), day_id: Id, activity_id: Id,
    catalog_version: z.string().min(1).max(200), choice: ActivityChoiceSchema }).strict(),
  z.object({ op: z.literal('window'), day_ids: DayIds, start: Time, end: Time }).strict(),
  z.object({ op: z.literal('date'), day_id: Id, date: DateValue }).strict(),
  z.object({ op: z.literal('mobility'), mode: z.string().min(1).max(40) }).strict(),
  z.object({ op: z.literal('budget'), value: Budget }).strict(),
  z.object({ op: z.literal('search_radius'), meters: SearchRadiusMeters }).strict(),
  z.object({ op: z.literal('party'), total: z.number().int().min(1).max(100).nullable(),
    child_ages: z.array(z.number().int().min(0).max(17)).max(99).nullable().optional() }).strict(),
  z.object({ op: z.literal('point'), field: z.enum(['origin', 'destination']), point: Coordinates.extend({
    label: z.string().min(1).max(160), source: z.enum(['user_geolocation', 'user_map', 'place_choice']),
  }).strict() }).strict(),
  z.object({ op: z.literal('clear_destination') }).strict(),
  z.object({ op: z.literal('remove_activity'), day_id: Id, activity_id: Id }).strict(),
  z.object({ op: z.literal('activities'), day_id: Id,
    remove_ids: z.array(Id).max(120).refine(ids => new Set(ids).size === ids.length),
    additions: z.array(z.object({ activity_id: Id, catalog_version: z.string().min(1).max(200), choice: ActivityChoiceSchema }).strict()).max(120),
  }).strict().refine(value => value.remove_ids.length + value.additions.length > 0),
  z.object({ op: z.literal('order'), day_id: Id, activity_ids: z.array(Id).max(120),
    precedence: z.array(z.tuple([Id, Id])).max(1000).optional() }).strict(),
]);
export const FormEvent = z.object({ base_version: z.number().int().nonnegative(), event_id: z.string().min(8).max(128) }).strict();
export const CalculateInput = FormEvent.extend({ refresh: z.literal(true).optional() }).strict();
export const FormEdit = FormEvent.extend({ changes: z.array(FormChange).min(1).max(160) }).strict();
export const PublicPlan = z.object({ status: z.enum(['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'ERROR', 'NEEDS_INPUT']),
  candidate_preview: CandidatePreview.optional(),
  origin: Point.optional(),
  valid_until: z.string().datetime().optional(),
  data_mode: z.string().optional(), warnings: z.array(z.string()).default([]), issues: z.array(z.string()).optional(),
  event_gaps: z.array(z.object({ day_id: Id, activity_id: Id, code: z.string().regex(/^[A-Z_]{2,80}$/u) }).strict()).max(120).optional(),
  total_expected_cost_minor: z.number().nullable().optional(),
  search_scope: z.object({ radius_meters: z.number().int().min(1).max(50_000),
    coverage: z.enum(['PARTIAL', 'BOUNDED_RESULTS']) }).optional(),
  shortlist: z.object({ groups: z.array(z.object({ truncated: z.boolean() })) }).optional(),
  days: z.array(z.object({ day_id: Id, date: DateValue, status: z.string(), missing_activity_ids: z.array(Id),
    ends_at: z.number().optional(), total_safe_travel_minutes: z.number().optional(),
    travel_segments: z.array(z.object({ from_id: Id, to_id: Id, departure_utc: z.number().int().nonnegative(), mode: Mobility,
      coordinates: z.array(z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(2).max(10000)).max(2000),
      transit: z.object({ pedestrian: z.boolean(), waitingSeconds: z.number().nonnegative().nullable(),
        transferCount: z.number().int().nonnegative(), crossingCount: z.number().int().nonnegative(),
        scheduleEvidence: z.enum(['predicted', 'provided', 'unknown']),
        stages: z.array(z.object({ kind: z.enum(['walkway', 'passage']), transport: z.string().max(100).nullable(),
          routes: z.array(z.object({ transport: z.string().max(100).nullable(), names: z.array(z.string().max(200)).max(30) })).max(30).optional(),
          names: z.array(z.string().max(200)).max(30), stop: z.string().max(300).nullable(),
          movingSeconds: z.number().nonnegative().nullable(), waitingSeconds: z.number().nonnegative().nullable() })).max(100),
      }).optional(),
      source: z.object({ provider: z.string(), fetched_at: z.string(), valid_until: z.string(), data_mode: z.string() }),
    })).max(200).optional(),
    visits: z.array(z.object({ activity_id: Id, place_id: Id, name: z.string(), location_label: z.string().nullable().optional(),
      event: z.object({ provider: z.literal('kudago'), event_id: z.string().regex(/^[1-9]\d*$/u),
        occurrence_key: z.string().regex(/^[0-9a-f]{64}$/u), schedule_kind: z.enum(['fixed', 'visit_window']),
        duration_basis: z.enum(['provider_session', 'user_estimate']), minimum_age: z.number().int().min(0).max(18).nullable(),
        official_start_utc: z.number().int().nonnegative().optional(), official_end_utc: z.number().int().nonnegative().optional(),
      }).strict().optional(),
      point: Coordinates.optional(), starts_at: z.number(), ends_at: z.number(),
      travel_before_minutes: z.number(), distance_before_meters: z.number().nullable().optional(),
      arrival_buffer_minutes: z.number(), price_expected_minor: z.number().nullable(),
      warnings: z.array(z.string()),
      source: z.object({ provider: z.string(), url: z.string().url().nullable().optional(),
        fetched_at: z.string(), valid_until: z.string(), data_mode: z.string() }).optional(),
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
  event_previews?: Record<string, SelectedEventDisplay>;
}
export type Change = z.infer<typeof FormChange>;
