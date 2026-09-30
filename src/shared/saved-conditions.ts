import { z } from 'zod';
import { Budget, DateValue, minutes, SearchRadiusMeters, InputClarification } from './planning-form.js';
import { SelectedEventTargetSchema } from './event-selection.js';

const Id = z.string().min(1).max(128);
const Text = z.string().min(1).max(1000);
const Timestamp = z.string().datetime({ offset: true });
const Time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/u);
const Provenance = z.enum(['user', 'user_form', 'inferred_walk', 'suggested', 'suggested_today',
  'derived_from_suggested_today', 'derived_from_duration', 'user_map', 'user_geolocation', 'policy_restore']);
const Issue = z.object({ code: z.enum(['SAVED_CATEGORY_RECONFIRM_REQUIRED', 'SAVED_EXCLUSIONS_RECONFIRM_REQUIRED',
  'SAVED_SEMANTIC_POLICY_CHANGED', 'SAVED_UNSUPPORTED_CONDITIONS', 'BUDGET_ASSUMPTION_RECONFIRM_REQUIRED',
  'POINT_RECONFIRM_REQUIRED', 'EVENT_RECHECK_REQUIRED']), field: z.string().min(1).max(256) }).strict();
const Point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180),
  source: z.enum(['user_map', 'user_geolocation']), saved_at: Timestamp }).strict();
const PlaceActivity = z.object({ id: Id, label: z.string().min(1).max(500), target: z.never().optional(),
  duration_minutes: z.number().int().min(1).max(1440).optional(),
  intent_kind: z.enum(['route_walk', 'area_walk', 'place_visit']).optional(),
  selection: z.object({ category_policy: z.enum(['related_allowed', 'named_types_only']),
    named_types: z.array(z.string().min(1).max(500)).max(100) }).strict(),
  requirements: z.array(z.object({ text: z.string().max(1000), strength: z.enum(['required', 'preferred']) }).strict()).max(100),
  semantic_key: z.enum(['route_walk', 'area_walk', 'food', 'named_types', 'unresolved']),
  category_reconfirmation_required: z.boolean(),
  category_selection_pending: z.literal(true).optional(),
}).strict();
const EventActivity = z.object({ id: Id, label: z.literal('Выбранное событие'), intent_kind: z.literal('event_visit'),
  requirements: z.array(z.object({ text: z.string().max(1000), strength: z.enum(['required', 'preferred']) }).strict()).max(100),
  target: SelectedEventTargetSchema, semantic_key: z.literal('selected_event') }).strict();
const Activity = z.union([PlaceActivity, EventActivity]);

const SavedUserConditionsV1Base = z.object({
  schema_version: z.literal('saved-user-conditions.v1'),
  clarifications: z.array(InputClarification).max(100).optional(),
  conditions_revision: z.number().int().nonnegative(), updated_at: Timestamp,
  review_state: z.enum(['draft', 'user_confirmed']), semantic_policy_version: z.string().min(1).max(80),
  shared: z.object({ budget: Budget.optional(), mobility: z.array(z.string().min(1).max(40)).max(10).optional(),
    search_radius_meters: SearchRadiusMeters.optional(),
    party: z.object({ total: z.number().int().min(1).max(100).optional(),
      child_ages: z.array(z.number().int().min(0).max(17)).max(99).optional() }).strict().optional(),
  }).strict(),
  queries: z.object({ locality: Text.optional(), origin: Text.optional(), destination: Text.optional() }).strict(),
  points: z.object({ origin: Point.optional(), destination: Point.optional() }).strict(),
  days: z.array(z.object({ day_id: Id, date: DateValue,
    window: z.object({ start: Time, end: Time }).strict().refine(value => minutes(value.start) < minutes(value.end)).optional(),
    duration_constraint_minutes: z.number().int().positive().max(1440).optional(),
    activities: z.array(Activity).max(120), order: z.array(z.tuple([Id, Id])).max(1000),
  }).strict()).min(1).max(31),
  provenance: z.record(z.string().min(1).max(256), Provenance),
  reconfirmation_required: z.array(Issue).max(200).default([]),
}).strict();
export const SavedUserConditionsV1Schema = SavedUserConditionsV1Base.superRefine((value, context) => {
  const questions = value.clarifications ?? [];
  if (new Set(questions.map(question => question.id)).size !== questions.length ||
      questions.some(question => question.day_ids.some(id => !value.days.some(day => day.day_id === id))))
    context.addIssue({ code: 'custom', path: ['clarifications'], message: 'Invalid saved clarification references.' });
  const ownPaths = new Set(['shared.budget', 'shared.mobility', 'shared.search_radius_meters', 'shared.party', 'shared.party.total', 'shared.party.child_ages',
    ...(['origin', 'destination'] as const).filter(field => value.points[field]).map(field => `points.${field}`),
    ...value.days.flatMap(day => ['date', 'window', 'window.start', 'window.end', 'duration_constraint_minutes', 'activities', 'order']
      .map(field => `days.${day.day_id}.${field}`)),
  ]);
  for (const path of Object.keys(value.provenance)) if (!ownPaths.has(path))
    context.addIssue({ code: 'custom', path: ['provenance', path], message: 'Only saved own-field provenance is allowed.' });
  const issuePaths = new Set(['shared', 'shared.party', 'shared.budget', 'days', 'points.origin', 'points.destination',
    ...value.days.flatMap(day => day.activities.map(activity => `days.${day.day_id}.activities.${activity.id}`)),
  ]);
  value.reconfirmation_required.forEach((issue, index) => {
    if (!issuePaths.has(issue.field)) context.addIssue({ code: 'custom', path: ['reconfirmation_required', index, 'field'], message: 'Unknown saved-condition field.' });
  });
  if (new Set(value.days.map(day => day.day_id)).size !== value.days.length)
    context.addIssue({ code: 'custom', path: ['days'], message: 'Duplicate saved day IDs.' });
  value.days.forEach((day, index) => {
    const ids = new Set(day.activities.map(activity => activity.id));
    if (ids.size !== day.activities.length || day.order.some(([a, b]) => a === b || !ids.has(a) || !ids.has(b)))
      context.addIssue({ code: 'custom', path: ['days', index], message: 'Invalid saved activity references.' });
  });
});
export type SavedUserConditionsV1 = z.infer<typeof SavedUserConditionsV1Schema>;

export const SavedConditionsViewSchema = z.object({ id: Id, revision: z.number().int().nonnegative(),
  expires_at: Timestamp, conditions: SavedUserConditionsV1Schema }).strict();
export type SavedConditionsView = z.infer<typeof SavedConditionsViewSchema>;
