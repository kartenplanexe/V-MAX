import { z } from 'zod';
import { EventCardSchema, EventFactSourceSchema, EventSearchResultSchema } from './event-catalog.js';

const Id = z.string().min(1).max(128);
const ProviderId = z.string().regex(/^[1-9]\d{0,15}$/u).refine(value => Number.isSafeInteger(Number(value)));
const Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const Point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict();
const DateValue = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const Epoch = z.number().int().min(0).max(253402300799);
export const EventRefSchema = z.object({ provider: z.literal('kudago'), event_id: ProviderId, occurrence_key: Digest }).strict();
export const SelectedEventTargetSchema = EventRefSchema.extend({ kind: z.literal('event'),
  visit_duration_minutes: z.number().int().min(5).max(720).optional() }).strict();
export type SelectedEventTarget = z.infer<typeof SelectedEventTargetSchema>;
export const EventUtcWindowSchema = z.object({ start_utc: Epoch, end_utc: Epoch }).strict().refine(value => value.start_utc < value.end_utc);
const ScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), windows_utc: z.array(EventUtcWindowSchema).length(1) }).strict(),
  z.object({ kind: z.literal('visit_window'), windows_utc: z.array(EventUtcWindowSchema).min(1).max(16) }).strict(),
]);
export const EventAvailabilityChoiceSchema = z.object({ event_ref: EventRefSchema, title: z.string().min(1).max(500),
  date: DateValue, schedule: ScheduleSchema, point: Point, venue_name: z.string().max(500).nullable(), location_label: z.string().max(1000).nullable(),
  source: EventFactSourceSchema, venue_source: EventFactSourceSchema.optional(),
  duration_required: z.boolean(), age: EventCardSchema.shape.age, price: EventCardSchema.shape.price,
  warnings: z.array(z.string().max(80)).max(30) }).strict();
export type EventAvailabilityChoice = z.infer<typeof EventAvailabilityChoiceSchema>;
const DurationSchema = z.object({ minutes: z.number().int().min(1).max(1440), basis: z.enum(['provider_session', 'user_estimate']) }).strict();
export const SelectedEventDisplaySchema = EventAvailabilityChoiceSchema.omit({ duration_required: true }).extend({ duration: DurationSchema }).strict();
export type SelectedEventDisplay = z.infer<typeof SelectedEventDisplaySchema>;
export const EventAvailabilitySchema = z.object({ status: z.enum(['READY', 'PARTIAL', 'UNAVAILABLE']),
  choices: z.array(EventAvailabilityChoiceSchema).max(366),
  unresolved: z.array(z.object({ occurrence_key: Digest.nullable(), code: z.string().max(80),
    dates: z.array(DateValue).max(31).optional() }).strict()).max(400) }).strict();
export type EventAvailability = z.infer<typeof EventAvailabilitySchema>;

/** Server-owned wire input for Python. Never accepted as an HTTP request body. */
export const EventPlanningCandidateSchema = z.object({ kind: z.literal('event'), id: z.string().regex(/^event:kudago:[0-9a-f]{64}$/u),
  name: z.string().min(1).max(500), location_label: z.string().max(1000).nullable(),
  locality_id: Id, region_id: Id, date: DateValue, event_ref: EventRefSchema, activity_id: Id, day_id: Id,
  point: Point, source: EventFactSourceSchema, venue_source: EventFactSourceSchema.optional(), schedule: ScheduleSchema,
  duration: DurationSchema,
  age: z.object({ minimum_age: z.number().int().min(0).max(18).nullable() }).strict(),
  price: z.object({ expected_minor: z.literal(0).nullable(), upper_minor: z.literal(0).nullable(),
    basis: z.enum(['whole_party', 'unknown']), estimate_kind: z.enum(['verified_admission', 'unknown']) }).strict(),
  normalization_warnings: z.array(z.string().max(80)).max(30),
}).strict().superRefine((value, context) => {
  if ((value.schedule.kind === 'fixed') !== (value.duration.basis === 'provider_session'))
    context.addIssue({ code: 'custom', path: ['duration'], message: 'Duration basis must match the schedule.' });
  const free = value.price.estimate_kind === 'verified_admission';
  if (free && (value.price.expected_minor !== 0 || value.price.upper_minor !== 0 || value.price.basis !== 'whole_party') ||
      !free && (value.price.expected_minor !== null || value.price.upper_minor !== null || value.price.basis !== 'unknown'))
    context.addIssue({ code: 'custom', path: ['price'], message: 'Unknown admission cannot be represented as free.' });
});
export type EventPlanningCandidate = z.infer<typeof EventPlanningCandidateSchema>;

const Action = z.object({ base_version: z.number().int().nonnegative(), event_id: z.string().min(8).max(128) }).strict();
const Opaque = z.string().uuid();
export const SearchEventsInputSchema = Action.extend({ day_id: Id,
  categories: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u)).max(20).optional() }).strict();
export const EventAvailabilityInputSchema = Action.extend({ search_id: Opaque, choice_id: Opaque }).strict();
export const SelectEventInputSchema = Action.extend({ search_id: Opaque, occurrence_choice_id: Opaque, day_id: Id,
  replace_activity_id: Id.optional(), visit_duration_minutes: z.number().int().min(5).max(720).optional() }).strict();
export const RecheckEventInputSchema = Action.extend({ day_id: Id, activity_id: Id }).strict();
export const EventSearchPreviewSchema = z.object({ search_id: Opaque, expires_at: z.iso.datetime(),
  coverage: EventSearchResultSchema.shape.coverage, reason: EventSearchResultSchema.shape.stop_reason,
  cards: z.array(z.object({ choice_id: Opaque, card: EventCardSchema }).strict()).max(50) }).strict();
export const EventAvailabilityPreviewSchema = z.object({ search_id: Opaque, expires_at: z.iso.datetime(),
  status: EventAvailabilitySchema.shape.status,
  choices: z.array(z.object({ occurrence_choice_id: Opaque, choice: EventAvailabilityChoiceSchema }).strict()).max(366),
  unresolved: EventAvailabilitySchema.shape.unresolved }).strict();
export type SearchEventsInput = z.infer<typeof SearchEventsInputSchema>;
export type EventAvailabilityInput = z.infer<typeof EventAvailabilityInputSchema>;
export type SelectEventInput = z.infer<typeof SelectEventInputSchema>;
export type RecheckEventInput = z.infer<typeof RecheckEventInputSchema>;
export type EventSearchPreview = z.infer<typeof EventSearchPreviewSchema>;
export type EventAvailabilityPreview = z.infer<typeof EventAvailabilityPreviewSchema>;
