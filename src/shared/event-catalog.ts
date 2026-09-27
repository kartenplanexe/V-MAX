import { z } from 'zod';

const Epoch = z.number().int().min(0).max(253402300799);
const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict();
export const EventSourceUrlSchema = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'kudago.com' && !url.username && !url.password && !url.port && !url.hash;
});
export const EventFactSourceSchema = z.object({ provider: z.literal('kudago'), url: EventSourceUrlSchema,
  fetched_at: z.iso.datetime(), valid_until: z.iso.datetime(), data_mode: z.enum(['live', 'test']) }).strict()
  .refine(value => Date.parse(value.valid_until) > Date.parse(value.fetched_at));
const DateEntry = z.object({ id: z.string().max(100), occurrence_key: z.string().regex(/^[0-9a-f]{64}$/u), state: z.enum(['FIXED', 'VENUE_HOURS_REQUIRED', 'INCOMPLETE']),
  start_utc: Epoch.nullable(), end_utc: Epoch.nullable(), reasons: z.array(z.string().max(80)).max(20) }).strict();
export const EventMediaSchema = z.object({ url: z.url().max(2048), attribution_text: z.string().min(1).max(500),
  attribution_url: z.url().max(2048), source_page: EventSourceUrlSchema, rights_basis: z.string().min(1).max(500),
  kind: z.literal('event_poster'), provider: z.literal('kudago'), fetched_at: z.iso.datetime(), valid_until: z.iso.datetime() }).strict();
export const EventCardSchema = z.object({ id: z.string().regex(/^kudago:event:[1-9]\d*$/u), provider: z.literal('kudago'),
  provider_event_id: Id, title: z.string().min(1).max(500), source: EventFactSourceSchema,
  provider_location: z.string().max(30).nullable(),
  venue: z.object({ provider_venue_id: Id, name: z.string().max(500).nullable(), address: z.string().max(1000).nullable(),
    point: Point.nullable(), is_closed: z.boolean().nullable() }).strict().nullable(),
  categories: z.array(z.string().max(100)).max(100),
  price: z.object({ display: z.string().max(1000).nullable(), kind: z.enum(['free', 'text', 'unknown', 'conflict']),
    admission_upper_minor: z.literal(0).nullable(), basis: z.literal('admission'), strict_eligible: z.boolean() }).strict(),
  age: z.object({ state: z.enum(['known', 'unknown']), minimum: z.number().int().min(0).max(18).nullable() }).strict(),
  schedule: z.object({ entries: z.array(DateEntry).max(366) }).strict(),
  media: z.array(EventMediaSchema).max(10), issues: z.array(z.string().max(80)).max(30),
}).strict();
export type EventCard = z.infer<typeof EventCardSchema>;

const Opening = z.object({ start: z.number().int().min(0).max(1439), end: z.number().int().min(1).max(1440) }).strict()
  .refine(value => value.start < value.end);
export const EventVenueSchema = z.object({ provider: z.literal('kudago'), provider_venue_id: Id,
  title: z.string().max(500), point: Point.nullable(), is_closed: z.boolean().nullable(), source: EventFactSourceSchema,
  timetable: z.string().max(4000).nullable(), hours: z.object({ state: z.enum(['KNOWN', 'PARTIAL', 'INCOMPLETE']), known_days: z.array(z.boolean()).length(7),
    weekly: z.array(z.array(Opening).max(8)).length(7), reasons: z.array(z.string().max(80)).max(10),
    policy_version: z.literal('kudago-weekly-hours.v2') }).strict() }).strict();
export type EventVenue = z.infer<typeof EventVenueSchema>;
export const EventSearchScopeSchema = z.object({ location: z.string().min(1).max(30), starts_at: Epoch, ends_at: Epoch,
  categories: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u)).max(20).optional() }).strict()
  .refine(value => value.ends_at > value.starts_at && value.ends_at - value.starts_at <= 31 * 86400);
export type EventSearchScope = z.infer<typeof EventSearchScopeSchema>;
export const EventSearchResultSchema = z.object({ items: z.array(EventCardSchema).max(400),
  coverage: z.enum(['BOUNDED_RESULTS', 'PARTIAL', 'UNSUPPORTED_LOCALITY']),
  stop_reason: z.enum(['RESULTS_EXHAUSTED', 'PAGE_LIMIT', 'HTTP_BUDGET_EXHAUSTED', 'DEADLINE_EXCEEDED',
    'PROVIDER_ERROR', 'PROVIDER_SCHEMA_ERROR', 'RESULT_COUNT_INCONSISTENT', 'REPEATED_PAGE', 'UNSUPPORTED_LOCALITY']),
  attempts: z.number().int().min(0).max(30), pages: z.number().int().min(0).max(8),
  rejected: z.number().int().min(0), outside_scope: z.number().int().min(0),
  scope: EventSearchScopeSchema,
}).strict();
export type EventSearchResult = z.infer<typeof EventSearchResultSchema>;
