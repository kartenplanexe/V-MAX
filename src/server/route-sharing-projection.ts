import { z } from 'zod';
import { PublicPlan } from '../shared/planning-form.js';
import { SavedUserConditionsV1Schema } from '../shared/saved-conditions.js';
import { SharedConditionsSchema, type SharePreview } from '../shared/route-sharing.js';

export function projectSharedConditions(raw: unknown, includePrivatePoints: boolean) {
  const original = SavedUserConditionsV1Schema.parse(raw), conditions = structuredClone(original);
  if (original.clarifications?.length) throw new Error('SHARE_CLARIFICATION_REQUIRED');
  const omissions: SharePreview['omissions'] = [];
  conditions.queries = {};
  conditions.review_state = 'draft';
  for (const field of ['origin', 'destination'] as const) {
    const present = !!original.points[field] || !!original.queries[field] ||
      original.reconfirmation_required.some(issue => issue.field === `points.${field}`);
    if (includePrivatePoints && conditions.points[field]) continue;
    delete conditions.points[field]; delete conditions.provenance[`points.${field}`];
    if (present) {
      omissions.push(field);
      if (!conditions.reconfirmation_required.some(issue => issue.field === `points.${field}`))
        conditions.reconfirmation_required.push({ code: 'POINT_RECONFIRM_REQUIRED', field: `points.${field}` });
    }
  }
  return { conditions: SharedConditionsSchema.parse(conditions), omissions };
}

const Source = z.object({ provider: z.string(), fetched_at: z.string(), valid_until: z.string(), data_mode: z.string() });

const Transit = z.object({ pedestrian: z.boolean(), waitingSeconds: z.number().nonnegative().nullable(),
  transferCount: z.number().int().nonnegative(), crossingCount: z.number().int().nonnegative(),
  scheduleEvidence: z.enum(['predicted', 'provided', 'unknown']),
  stages: z.array(z.object({ kind: z.enum(['walkway', 'passage']), transport: z.string().max(100).nullable(),
    routes: z.array(z.object({ transport: z.string().max(100).nullable(), names: z.array(z.string().max(200)).max(30) })).max(30).optional(),
    names: z.array(z.string().max(200)).max(30), stop: z.string().max(300).nullable(),
    movingSeconds: z.number().nonnegative().nullable(), waitingSeconds: z.number().nonnegative().nullable() })).max(100),
});
const Segment = z.object({ from_id: z.string(), to_id: z.string(), departure_utc: z.number().int().nonnegative(), mode: z.string(),
  coordinates: z.array(z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(2).max(10000)).max(2000),
  transit: Transit.optional(), source: Source });
type SegmentedDay = { travel_segments?: z.infer<typeof Segment>[] };
const absent = () => ({ result: null, result_expires_at: null });

export function projectSharedResult(raw: unknown, originalExpiry: number, now: number, includePrivatePoints: boolean):
  Pick<SharePreview, 'result' | 'result_expires_at'> {
  if (!raw || !Number.isFinite(originalExpiry) || originalExpiry <= now) return absent();
  const parsed = PublicPlan.safeParse(raw);
  if (!parsed.success || !['AVAILABLE', 'LIMITED'].includes(parsed.data.status)) return absent();
  const plan = parsed.data, deadlines = [originalExpiry, ...(plan.valid_until ? [Date.parse(plan.valid_until)] : [])];
  if (!plan.days.some(day => day.visits.length)) return absent();
  const days = plan.days.map(day => {
    const ids = new Set(day.visits.map(visit => visit.place_id));
    const rawSegments = (day as typeof day & SegmentedDay).travel_segments;
    const allSegments = rawSegments?.map(segment => Segment.parse(segment));

    for (const segment of allSegments ?? []) deadlines.push(Date.parse(segment.source.valid_until));
    const segments = allSegments?.filter(segment => includePrivatePoints || ids.has(segment.from_id) && ids.has(segment.to_id));
    return { day_id: day.day_id, date: day.date, status: day.status, missing_activity_ids: [...day.missing_activity_ids],
      ends_at: day.ends_at, total_safe_travel_minutes: day.total_safe_travel_minutes,
      ...(segments ? { travel_segments: segments } : {}), visits: day.visits.map(visit => {
        deadlines.push(Date.parse(visit.source?.valid_until ?? ''));
        return { activity_id: visit.activity_id, place_id: visit.place_id, name: visit.name, location_label: visit.location_label,
          ...(visit.event ? { event: { provider: visit.event.provider, event_id: visit.event.event_id,
            occurrence_key: visit.event.occurrence_key, schedule_kind: visit.event.schedule_kind,
            duration_basis: visit.event.duration_basis, minimum_age: visit.event.minimum_age,
            ...(visit.event.official_start_utc !== undefined ? { official_start_utc: visit.event.official_start_utc } : {}),
            ...(visit.event.official_end_utc !== undefined ? { official_end_utc: visit.event.official_end_utc } : {}) } } : {}),
          point: visit.point, starts_at: visit.starts_at, ends_at: visit.ends_at, travel_before_minutes: visit.travel_before_minutes,
          distance_before_meters: visit.distance_before_meters, arrival_buffer_minutes: visit.arrival_buffer_minutes,
          price_expected_minor: visit.price_expected_minor, warnings: [...visit.warnings], source: visit.source };
      }) };
  });
  if (!deadlines.every(Number.isFinite) || Math.min(...deadlines) <= now) return absent();
  return { result: PublicPlan.parse({ status: plan.status, data_mode: plan.data_mode, valid_until: plan.valid_until, warnings: [...plan.warnings],
    issues: plan.issues, event_gaps: plan.event_gaps?.map(gap => ({ day_id: gap.day_id, activity_id: gap.activity_id, code: gap.code })),
    total_expected_cost_minor: plan.total_expected_cost_minor, search_scope: plan.search_scope,
    shortlist: plan.shortlist, ...(includePrivatePoints && plan.origin ? { origin: {
      lat: plan.origin.lat, lon: plan.origin.lon, locality_id: plan.origin.locality_id, source: plan.origin.source,
    } } : {}), days }), result_expires_at: new Date(Math.min(...deadlines)).toISOString() };
}
