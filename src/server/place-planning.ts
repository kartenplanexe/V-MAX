import { z } from 'zod';
import { DgisClient, DgisProviderError, DgisRoutingUnavailableError, DgisRequestBudgetError, pairKey, type Coordinates } from './dgis.js';
import { retrievePlaceCandidates } from './place-retrieval.js';
import { projectCandidatePreview } from './candidate-preview.js';
import { runPythonPlanner } from './planner-process.js';
import type { RouteLine } from './route-geometry.js';
import type { TransitEvidence } from './dgis-public-transport.js';
import { FormDraft, isEventActivity } from '../shared/planning-form.js';
import { EventPlanningCandidateSchema, type EventPlanningCandidate } from '../shared/event-selection.js';

const EventGap = z.object({ day_id: z.string(), activity_id: z.string(), code: z.string().regex(/^[A-Z_]{2,80}$/u) });
export type EventPlanResolution = { candidates: EventPlanningCandidate[]; issues: z.infer<typeof EventGap>[] };
export type ResolvePlanEvents = (input: Record<string, unknown>, options: {
  requestBudget: { consume(): void }; shouldContinue: () => boolean; now: () => Date;
}) => Promise<EventPlanResolution>;

const Point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const Pair = z.object({ day_id: z.string(), from_id: z.string(), to_id: z.string(),
  from_point: Point, to_point: Point, date: z.string(), window: z.object({ start: z.string(), end: z.string() }),
  mode: z.enum(['walking', 'driving', 'cycling', 'public_transport']), sample_utc: z.array(z.number().int()).optional(),
  search_sample_utc: z.array(z.number().int()).max(2).optional(),
});
const Prepared = z.object({ job: z.record(z.string(), z.unknown()), pairs: z.array(Pair),
  preview_job: z.record(z.string(), z.unknown()).optional(),
  shortlist: z.record(z.string(), z.unknown()), maximum_selected_legs: z.number().int().nonnegative() });
const Checks = z.object({ checks: z.array(Pair.extend({ departure_utc: z.number().int(), safe_minutes: z.number().int() })) });
const Candidate = z.object({ day_id: z.string(), activity_id: z.string(), place_id: z.string() });
const Recovery = z.object({ proposal: z.object({ key: z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]),
  candidate: Candidate, pairs: z.array(Pair) }), maximum_selected_legs: z.number().int().nonnegative() });
type RoutePair = z.infer<typeof Pair>;
type Query = { pair: RoutePair; utc: number };
type Measurement = { durationSeconds: number; distanceMeters: number; geometry?: RouteLine[] | null; transit?: TransitEvidence } | null;
type Source = { provider: string; fetched_at: string; valid_until: string; data_mode: 'live' | 'test' };
type Leg = RoutePair & { safe_minutes: number; distance_meters?: number; source: Source; cost_upper_minor?: number };
const ROUTING_POLICY = 'dated-routing.v3';
const PIPELINE_STAGES = ['PREFLIGHT', 'EVENTS', 'PLACES', 'SHORTLIST', 'MATRIX', 'TRANSIT_SAMPLING',
  'SOLVE', 'RECOVERY', 'DEPARTURE_CHECKS', 'FINAL_VALIDATION'] as const;
const BUDGET_STOP_CODES = ['HTTP_BUDGET_EXHAUSTED', 'PAIR_BUDGET_EXHAUSTED', 'DEADLINE_EXCEEDED', 'SUBSCRIPTION_QUOTA_EXHAUSTED'] as const;
const STOP_ISSUES = ['ROUTING_BUDGET_EXCEEDED', 'ROUTING_BUDGET_OR_DEADLINE_EXCEEDED',
  'PLAN_EXPIRED_OR_INVALID', 'ROUTE_RECHECK_FAILED', 'PLANNING_PIPELINE_FAILED', 'ROUTING_PROVIDER_UNAVAILABLE'] as const;
const allowedCode = (value: unknown, allowed: readonly string[]) =>
  typeof value === 'string' && allowed.includes(value) ? value : null;

/** Aggregate operator evidence only. Never log a place, coordinate, user text or provider response. */
export function safePlanningDiagnostic(value: unknown) {
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const routing = result.routing && typeof result.routing === 'object' ? result.routing as Record<string, unknown> : {};
  const shortlist = result.shortlist && typeof result.shortlist === 'object' ? result.shortlist as Record<string, unknown> : {};
  const groups = Array.isArray(shortlist.groups) ? shortlist.groups : [];
  const exclusions = Array.isArray(result.excluded) ? result.excluded : [];
  const numbers = (field: string) => typeof routing[field] === 'number' && Number.isSafeInteger(routing[field]) && routing[field] >= 0 ? routing[field] : 0;
  const reasonCounts: Record<string, number> = {};
  for (const item of exclusions) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.reasons)) continue;
    for (const reason of item.reasons) if (typeof reason === 'string' && /^[A-Z_]{2,50}$/u.test(reason))
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const days = Array.isArray(result.days) ? result.days : [];
  const preview = result.candidate_preview && typeof result.candidate_preview === 'object'
    ? result.candidate_preview as Record<string, unknown> : {};
  const previewGroups = Array.isArray(preview.groups) ? preview.groups : null;
  // Positional aggregates let us locate a dropped request stage without logging
  // user text, category IDs, activity IDs, place names, or coordinates.
  const activity_funnel = groups.slice(0, 50).map((group, index) => {
    const day = days.find(item => item?.day_id === group?.day_id);
    const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    return { slot: index + 1, eligible: count(group?.eligible), shortlisted: count(group?.selected),
      ...(typeof group?.minimum_visit_minutes === 'number' ? { minimum_visit_minutes: count(group.minimum_visit_minutes) } : {}),
      ...(typeof group?.minimum_start_allowance_minutes === 'number' ? { minimum_start_allowance_minutes: count(group.minimum_start_allowance_minutes) } : {}),
      ...(previewGroups ? { previewed: previewGroups.filter(item => item?.day_id === group?.day_id && item?.activity_id === group?.activity_id)
        .reduce((sum, item) => sum + (Array.isArray(item?.places) ? item.places.length : 0), 0) } : {}),
      scheduled: Array.isArray(day?.visits) ? day.visits.filter((visit: { activity_id?: unknown }) =>
        visit?.activity_id === group?.activity_id).length : 0,
      missing: Array.isArray(day?.missing_activity_ids) && day.missing_activity_ids.includes(group?.activity_id) ||
        Array.isArray(result.selection_gaps) && result.selection_gaps.some((item: { day_id?: unknown; activity_id?: unknown }) =>
          item?.day_id === group?.day_id && item?.activity_id === group?.activity_id) };
  });
  return {
    status: ['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'ERROR', 'NEEDS_INPUT', 'PLACES_FOUND'].includes(String(result.status))
      ? result.status : 'UNKNOWN',
    pipeline_stage: allowedCode(routing.pipeline_stage, PIPELINE_STAGES) ?? 'UNKNOWN',
    budget_stop_code: allowedCode(routing.budget_stop_code, BUDGET_STOP_CODES),
    stop_issue: Array.isArray(result.issues) ? result.issues.map(issue => allowedCode(issue, STOP_ISSUES)).find(Boolean) ?? null : null,
    elapsed_ms: numbers('elapsed_ms'), route_pair_calculations: numbers('route_pair_calculations'),
    max_route_pair_calculations: numbers('max_route_pair_calculations'), max_routing_http_calls: numbers('max_routing_http_calls'),
    candidate_counts_available: Array.isArray(shortlist.groups),
    places_http_calls: numbers('places_http_calls'), routing_http_calls: numbers('routing_http_calls'),
    event_http_calls: numbers('event_http_calls'), event_candidates: numbers('event_candidates'),
    event_unresolved: numbers('event_unresolved'), retrieval_http_calls: numbers('retrieval_http_calls'),
    places_logical_queries: numbers('places_logical_queries'), places_unsearched_groups: numbers('places_unsearched_groups'),
    places_budget_stops: numbers('places_budget_stops'), places_deadline_stops: numbers('places_deadline_stops'),
    places_received: numbers('places_received'), places_rejected_items: numbers('places_rejected_items'),
    places_failed_queries: numbers('places_failed_queries'),
    places_http_4xx: numbers('places_http_4xx'), places_http_5xx: numbers('places_http_5xx'),
    places_transport_failures: numbers('places_transport_failures'),
    places_provider_4xx: numbers('places_provider_4xx'), places_schema_failures: numbers('places_schema_failures'),
    places_max_rubric_ids: numbers('places_max_rubric_ids'),
    places_failure_codes: typeof routing.places_failure_codes === 'object' && routing.places_failure_codes !== null
      ? Object.fromEntries(Object.entries(routing.places_failure_codes).filter(([key, value]) =>
        /^(?:HTTP|PROVIDER)_\d{3}(?:_[A-Z_]+)?$|^SCHEMA_[A-Z0-9_]+$|^(?:TRANSPORT|INVALID_PROVIDER_RESPONSE)$/u.test(key) &&
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) : {},
    routing_failed_batches: numbers('routing_failed_batches'),
    transit_extra_samples: numbers('transit_extra_samples'), transit_selected_segments: numbers('transit_selected_segments'),
    transit_pedestrian_segments: numbers('transit_pedestrian_segments'), transit_unknown_schedules: numbers('transit_unknown_schedules'),
    eligible_options: groups.reduce((sum, group) => sum + (Number.isSafeInteger(group?.eligible) ? group.eligible : 0), 0),
    shortlisted_options: groups.reduce((sum, group) => sum + (Number.isSafeInteger(group?.selected) ? group.selected : 0), 0),
    activity_funnel,
    excluded_options: exclusions.length, exclusion_reasons: reasonCounts,
    verified_visits: Array.isArray(result.days) ? result.days.reduce((sum, day) => sum + (Array.isArray(day?.visits) ? day.visits.length : 0), 0) : 0,
  };
}

function edgeKey(pair: RoutePair) { return JSON.stringify([pair.day_id, pair.from_id, pair.to_id]); }
function safeMinutes(seconds: number, pair: RoutePair, row: Measurement) {
  if (pair.mode === 'public_transport' && !row?.transit?.pedestrian) {
    const minutes = seconds / 60;
    return Math.ceil((minutes + Math.max(10, Math.ceil(minutes * 0.25))) / 5) * 5;
  }
  return Math.ceil(seconds / 60 * 1.25) + 2;
}
/** PT samples are observed search estimates, never an upper bound over all departures. */
function measuredLeg(pair: RoutePair, values: Measurement[]) {
  const usable = values.flatMap(value => {
    const seconds = conservativeTravelSeconds(pair, value);
    return seconds === null ? [] : [{ minutes: safeMinutes(seconds, pair, value), distance: value!.distanceMeters }];
  });
  if (!usable.length || pair.mode !== 'public_transport' && usable.length !== values.length) return null;
  if (pair.mode === 'public_transport') return usable.toSorted((a, b) => a.minutes - b.minutes || a.distance - b.distance)[0]!;
  return { minutes: Math.max(...usable.map(row => row.minutes)), distance: Math.max(...usable.map(row => row.distance)) };
}
function directMeters(a: Coordinates, b: Coordinates) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
/** Reject inconsistent provider geometry and enforce physically plausible
 * upper-speed bounds for every supported mode. This is a conservative product
 * check, not a replacement for the provider's dated travel-time observation.
 */
export function conservativeTravelSeconds(pair: RoutePair, row: Measurement): number | null {
  if (!row || !Number.isFinite(row.durationSeconds) || !Number.isFinite(row.distanceMeters) ||
      row.durationSeconds < 0 || row.distanceMeters < 0) return null;
  const direct = directMeters(pair.from_point, pair.to_point);
  if (row.distanceMeters + 100 < direct * 0.85) return null;
  const maximumMetersPerSecond = row.transit?.pedestrian ? 1.8
    : { walking: 1.8, cycling: 12.5, driving: 44.5, public_transport: 44.5 }[pair.mode];
  const physicalMinimum = Math.max(row.distanceMeters, direct) / maximumMetersPerSecond;
  if (direct > 1000 && row.durationSeconds < physicalMinimum * 0.5) return null;
  return Math.max(row.durationSeconds, physicalMinimum);
}
function batches(queries: Query[], maxBatch = 50) {
  const groups = new Map<string, { utc: number; mode: RoutePair['mode']; entries: Map<string, { pair: [Coordinates, Coordinates]; indices: number[] }> }>();
  queries.forEach((query, index) => {
    const key = `${query.utc}:${query.pair.mode}`;
    const group = groups.get(key) ?? { utc: query.utc, mode: query.pair.mode, entries: new Map() };
    const coordinates = pairKey(query.pair.from_point, query.pair.to_point);
    const entry = group.entries.get(coordinates) ?? { pair: [query.pair.from_point, query.pair.to_point] as [Coordinates, Coordinates], indices: [] };
    entry.indices.push(index); group.entries.set(coordinates, entry); groups.set(key, group);
  });
  return [...groups.values()].flatMap(group => {
    const entries = [...group.entries.values()];
    const size = group.mode === 'public_transport' ? 1 : maxBatch;
    return Array.from({ length: Math.ceil(entries.length / size) }, (_, index) => ({
      utc: group.utc, mode: group.mode, entries: entries.slice(index * size, (index + 1) * size),
    }));
  });
}

/** Internal orchestration only: caller owns confirmed intent/catalog/policies.
 * Does not read .env, call LLM, persist provider data, expose HTTP or deploy.
 * The same-request shortlist is explicit; no claim of an optimum over a city.
 */
export async function planPlacesWithDgis(client: DgisClient, input: Record<string, unknown>, options: {
  retrieval: { radiusMeters: number; pageSize?: number; maxPages?: number; maxRequests?: number };
  maxRoutePairs?: number;
  maxRoutingHttpCalls?: number;
  routingStrategy?: 'progressive';
  routingMode?: 'external' | 'verified';
  consumeRoutingQuota?: (objects: number, remainingMs: number) => Promise<void>;
  dataMode?: 'live' | 'test';
  includeGeometry?: boolean;
  resolveEvents?: ResolvePlanEvents;
  now?: () => Date;
  planner?: Parameters<typeof runPythonPlanner>[1];
}) {
  const now = options.now ?? (() => new Date());
  const maxPairs = z.number().int().min(1).max(1000).parse(options.maxRoutePairs ?? 200);
  const maxHttp = z.number().int().min(1).max(100).parse(options.maxRoutingHttpCalls ?? 30);
  const mode = options.dataMode ?? 'live';
  const started = performance.now();
  let pipelineStage: typeof PIPELINE_STAGES[number] = 'PREFLIGHT';
  let budgetStopCode: DgisRequestBudgetError['code'] | null = null;
  let diagnosticShortlist: Record<string, unknown> | undefined;
  let candidatePreviewJob: Record<string, unknown> | undefined;
  const withinDeadline = () => performance.now() - started < 90_000;
  const maxRetrieval = z.number().int().min(1).max(30).parse(options.retrieval.maxRequests ?? 20);
  const counters = { event_http_calls: 0, event_candidates: 0, event_unresolved: 0, retrieval_http_calls: 0,
    places_http_calls: 0, places_received: 0, places_rejected_items: 0, places_failed_queries: 0,
    places_logical_queries: 0, places_unsearched_groups: 0, places_budget_stops: 0, places_deadline_stops: 0,
    places_http_4xx: 0, places_http_5xx: 0, places_transport_failures: 0,
    places_provider_4xx: 0, places_schema_failures: 0, places_failure_codes: {} as Record<string, number>,
    places_max_rubric_ids: 0,
    route_pair_calculations: 0, routing_http_calls: 0, routing_failed_batches: 0, replans: 0,
    transit_extra_samples: 0, transit_selected_segments: 0, transit_pedestrian_segments: 0, transit_unknown_schedules: 0 };
  const recovery = { attempts: 0, added_candidates: 0, added_pairs: 0, stop_reason: 'NOT_NEEDED' };
  let searchScope: { radius_meters: number; coverage: 'PARTIAL' | 'BOUNDED_RESULTS' } | undefined;
  let eventIssues: z.infer<typeof EventGap>[] = [];
  const scope = () => ({ ...(searchScope ? { search_scope: searchScope } : {}),
    ...(eventIssues.length ? { event_gaps: eventIssues } : {}) });
  const consumeRetrieval = () => {
    if (!withinDeadline()) throw new DgisRequestBudgetError('DEADLINE_EXCEEDED');
    if (counters.retrieval_http_calls >= maxRetrieval) throw new DgisRequestBudgetError('HTTP_BUDGET_EXHAUSTED');
    counters.retrieval_http_calls++;
  };
  const metadata = () => ({ policy: ROUTING_POLICY, ...counters, recovery: { ...recovery }, llm_calls: 0, provider_payload_persisted: false,
    pipeline_stage: pipelineStage, budget_stop_code: budgetStopCode, elapsed_ms: Math.max(0, Math.floor(performance.now() - started)),
    max_route_pair_calculations: maxPairs, max_routing_http_calls: maxHttp, data_mode: mode });
  const stop = (issue: string) => ({ schema_version: 'place-selection.v1', status: 'ERROR', issues: [issue], days: [],
    ...(diagnosticShortlist ? { shortlist: diagnosticShortlist } : {}), routing: metadata(), ...scope(),
    ...projectCandidatePreview(candidatePreviewJob, now()) });
  const run = (job: unknown, operation: 'solve' | 'prepare-routes' | 'route-checks' | 'recover-routes') => {
    if (!withinDeadline()) throw new DgisRequestBudgetError('DEADLINE_EXCEEDED');
    return runPythonPlanner(job, { ...options.planner, operation });
  };
  const source = (): Source => { const at = now(); return { provider: '2gis', data_mode: mode,
    fetched_at: at.toISOString(), valid_until: new Date(at.getTime() + 300_000).toISOString() }; };
  let incompleteMatrix = false;
  let shortlistTruncated = false;
  let hasTransit = false;
  const cache = new Map<string, { value: Measurement; source: Source }>();
  const queryKey = ({ pair, utc }: Query) => JSON.stringify([pair.mode, utc, pair.from_point.lat, pair.from_point.lon,
    pair.to_point.lat, pair.to_point.lon]);
  const routingWarnings = () => [
    ...(counters.routing_failed_batches ? ['ROUTING_PROVIDER_FAILURE'] : []),
    ...(incompleteMatrix ? ['ROUTE_MATRIX_INCOMPLETE'] : []),
    ...(shortlistTruncated ? ['ROUTE_CANDIDATES_TRUNCATED'] : []),
    ...(hasTransit ? ['PT_SCHEDULE_SEARCH_BOUNDED', 'TRANSIT_PRICE_UNKNOWN'] : []),
  ];
  async function measure(queries: Query[], reserve = 0, reuse = false, detailed = false): Promise<Measurement[]> {
    const output: Measurement[] = queries.map(() => null);
    const pending: Query[] = [], indices: number[] = [];
    queries.forEach((query, index) => {
      const previous = cache.get(queryKey(query));
      // A failed exact tuple is never automatically retried. Positive cached
      // matrix samples can serve recovery, but final checks re-observe the route.
      if (previous && (reuse || previous.value === null)) output[index] = previous.value;
      else { pending.push(query); indices.push(index); }
    });
    const grouped = batches(pending, options.consumeRoutingQuota ? 5 : 50);
    const requests = detailed ? grouped.flatMap(batch => batch.entries.map(entry => ({ ...batch, entries: [entry] }))) : grouped;
    if (counters.route_pair_calculations + requests.reduce((sum, b) => sum + b.entries.length, 0) > maxPairs ||
        counters.routing_http_calls + requests.length > maxHttp) throw new DgisRequestBudgetError('PAIR_BUDGET_EXHAUSTED');
    for (const batch of requests) {
      const observedSource = source();
      try {
        const requestBudget = { async consume() {
            if (!withinDeadline()) throw new DgisRequestBudgetError('DEADLINE_EXCEEDED');
            if (counters.route_pair_calculations + batch.entries.length + reserve > maxPairs)
              throw new DgisRequestBudgetError('PAIR_BUDGET_EXHAUSTED');
            if (counters.routing_http_calls + 1 + reserve > maxHttp)
              throw new DgisRequestBudgetError('HTTP_BUDGET_EXHAUSTED');
            await options.consumeRoutingQuota?.(batch.entries.length, 90_000 - (performance.now() - started));
            // Every physical attempt, including a key denial, consumes allowance.
            counters.route_pair_calculations += batch.entries.length; counters.routing_http_calls++;
          } };
        let rows: Measurement[];
        if (batch.mode === 'public_transport') {
          rows = [await client.buildPublicTransportRoute({ from: batch.entries[0]!.pair[0],
            to: batch.entries[0]!.pair[1], departureUtc: batch.utc, requestBudget })];
        } else {
          const transport = batch.mode === 'cycling' ? 'bicycle' : batch.mode;
          rows = detailed ? [await client.buildRouteSegment({ from: batch.entries[0]!.pair[0],
            to: batch.entries[0]!.pair[1], departureUtc: batch.utc, transport, requestBudget })]
            : await client.buildRoutePairs({ pairs: batch.entries.map(e => e.pair), departureUtc: batch.utc, transport, requestBudget });
        }
        batch.entries.forEach((entry, i) => entry.indices.forEach(index => {
          const query = pending[index]!, value = rows[i] ?? null;
          const accepted = conservativeTravelSeconds(query.pair, value) === null ? null : value;
          output[indices[index]!] = accepted; cache.set(queryKey(query), { value: accepted, source: observedSource });
        }));
      } catch (error) {
        if (error instanceof DgisRequestBudgetError) throw error;
        if (!(error instanceof DgisProviderError)) throw error;
        counters.routing_failed_batches++; // No automatic HTTP retries, missing edges stay forbidden.
        if (error instanceof DgisRoutingUnavailableError) throw error;
        batch.entries.forEach(entry => entry.indices.forEach(index => {
          cache.set(queryKey(pending[index]!), { value: null, source: observedSource });
        }));
      }
    }
    return output;
  }
  try {
    // Validate the entire intent, date/timezone, durations and supported modes BEFORE external requests.
    const base = { schema_version: input.schema_version, as_of: now().toISOString(), intent: input.intent,
      catalog: input.catalog, visit_policy: input.visit_policy, budget_policy: input.budget_policy,
      ...(input.replacement === undefined ? {} : { replacement: input.replacement }),
      routing_policy: { ...z.record(z.string(), z.unknown()).parse(input.routing_policy ?? {}),
        ...(options.routingMode === 'external' ? { strategy: 'progressive', external_compact: true } : options.routingStrategy ? { strategy: options.routingStrategy } : {}),
        max_route_pair_calculations: maxPairs, max_routing_http_calls: maxHttp }, places: [], route_legs: [] };
    // The replacement roster needs fresh place facts. The initial structural
    // preflight deliberately contains no places, so check it after retrieval.
    const { replacement: _replacement, ...preflightBase } = base as Record<string, unknown>;
    const preflight = await run(preflightBase, 'prepare-routes');
    if (preflight.status !== 'AVAILABLE') return { ...preflight, routing: metadata() };
    const draft = FormDraft.parse(input.intent);
    const targets = draft.days.flatMap(day => day.activities.filter(isEventActivity).map(activity => ({ day, activity })));
    let events: EventPlanningCandidate[] = [];
    if (targets.length) {
      pipelineStage = 'EVENTS';
      if (options.resolveEvents) {
        const resolved = await options.resolveEvents(input, { shouldContinue: withinDeadline, now,
          requestBudget: { consume() { consumeRetrieval(); counters.event_http_calls++; } } });
        events = z.array(EventPlanningCandidateSchema).max(120).parse(resolved.candidates);
        eventIssues = z.array(EventGap).max(120).parse(resolved.issues);
      } else eventIssues = targets.map(({ day, activity }) => ({ day_id: day.day_id, activity_id: activity.id, code: 'EVENT_PROVIDER_UNAVAILABLE' }));
      counters.event_candidates = events.length; counters.event_unresolved = eventIssues.length;
    }
    const catalog = z.object({ version: z.string() }).parse(input.catalog);
    const fetchedAt = now();
    pipelineStage = 'PLACES';
    const retrieval = await retrievePlaceCandidates(client, input.intent, { ...options.retrieval,
      ...(options.routingMode === 'external' ? { sort: 'distance' as const,
        walkRubricScores: z.record(z.string(), z.number().int().min(0).max(2)).parse(
          (input.visit_policy as Record<string, unknown> | undefined)?.walk_rubric_scores ?? {}) } : {}),
      radiusMeters: draft.shared.search_radius_meters ?? options.retrieval.radiusMeters, catalogVersion: catalog.version,
      shouldContinue: withinDeadline, requestBudget: { consume: consumeRetrieval } });
    searchScope = { radius_meters: retrieval.radius_meters, coverage: retrieval.coverage === 'PARTIAL' ? 'PARTIAL' : 'BOUNDED_RESULTS' };
    counters.places_http_calls = retrieval.requests;
    counters.places_logical_queries = retrieval.queries;
    counters.places_unsearched_groups = retrieval.searches.filter(search => search.status === 'NOT_SEARCHED').length;
    counters.places_budget_stops = retrieval.searches.filter(search => search.stop_reason === 'HTTP_BUDGET_EXHAUSTED').length;
    counters.places_deadline_stops = retrieval.searches.filter(search => search.stop_reason === 'DEADLINE_EXCEEDED').length;
    counters.places_received = retrieval.places.length;
    counters.places_rejected_items = retrieval.searches.reduce((sum, search) => sum + search.rejected_items, 0);
    counters.places_failed_queries = retrieval.searches.filter(search => search.status === 'PROVIDER_ERROR').length;
    counters.places_http_4xx = retrieval.searches.filter(search => /^HTTP_4\d\d$/u.test(search.failure_code ?? '')).length;
    counters.places_http_5xx = retrieval.searches.filter(search => /^HTTP_5\d\d$/u.test(search.failure_code ?? '')).length;
    counters.places_transport_failures = retrieval.searches.filter(search => search.failure_code === 'TRANSPORT').length;
    counters.places_provider_4xx = retrieval.searches.filter(search => /^PROVIDER_4\d\d(?:_|$)/u.test(search.failure_code ?? '')).length;
    counters.places_schema_failures = retrieval.searches.filter(search => search.failure_code?.startsWith('SCHEMA_')).length;
    counters.places_max_rubric_ids = Math.max(0, ...retrieval.searches.map(search => search.rubric_ids.length));
    for (const search of retrieval.searches) if (search.failure_code) {
      counters.places_failure_codes[search.failure_code] = (counters.places_failure_codes[search.failure_code] ?? 0) + 1;
    }
    const { places: _empty, ...withoutPlaces } = base;
    pipelineStage = 'SHORTLIST';
    const preparedReply = await run({ ...withoutPlaces, event_candidates: events, as_of: now().toISOString(),
      retrieval: { coverage: retrieval.coverage, radius_meters: retrieval.radius_meters }, provider_batches: [{ items: retrieval.places, region_id: retrieval.region_id,
        fetched_at: fetchedAt.toISOString(), valid_until: new Date(fetchedAt.getTime() + 900_000).toISOString(), data_mode: mode }] }, 'prepare-routes');
    if (preparedReply.status !== 'AVAILABLE') return { ...preparedReply, routing: metadata(), ...scope() };
    const prepared = Prepared.parse(preparedReply);
    candidatePreviewJob = prepared.preview_job ?? prepared.job;
    diagnosticShortlist = prepared.shortlist;
    // Deliberately stop before any road measurement or route solving. These are
    // individually eligible alternatives, never a verified combined itinerary.
    if (options.routingMode === 'external') {
      const preview = projectCandidatePreview(candidatePreviewJob, now());
      return { schema_version: 'place-selection.v1', status: preview.candidate_preview ? 'PLACES_FOUND' : 'UNAVAILABLE',
        selection_policy: 'external-compact.v4',
        ...(diagnosticShortlist ? { shortlist: diagnosticShortlist } : {}),
        days: [], warnings: [], ...preview, ...scope(), routing: { ...metadata(), policy: 'external-routing-places.v1' } };
    }
    hasTransit = prepared.pairs.some(pair => pair.mode === 'public_transport');
    shortlistTruncated = z.array(z.object({ truncated: z.boolean() })).parse(prepared.shortlist.groups).some(group => group.truncated);
    const queries = prepared.pairs.flatMap(pair => (pair.sample_utc ?? []).map(utc => ({ pair, utc })));
    const matrixBatches = batches(queries, options.consumeRoutingQuota ? 5 : 50);
    // Reserve both verification rounds before spending on the matrix. Each route pair can be billed.
    const reserve = prepared.maximum_selected_legs * 2;
    pipelineStage = 'MATRIX';
    if (queries.length && (matrixBatches.reduce((n, b) => n + b.entries.length, 0) + reserve > maxPairs ||
        matrixBatches.length + reserve > maxHttp)) return stop('ROUTING_BUDGET_EXCEEDED');
    const matrixSource = source(); // Do not refresh older measurements merely because a later HTTP batch completed.
    const measurements = await measure(queries, reserve);
    incompleteMatrix = measurements.some(row => row === null);
    // Spend only the residual allowance after fair candidate allocation and two
    // complete check rounds. Cycle activity groups, then edges, at each anchor.
    const pool = z.array(Candidate).parse(prepared.job.candidate_pool);
    if (hasTransit) pipelineStage = 'TRANSIT_SAMPLING';
    const transitGroups = new Map<string, RoutePair[]>();
    for (const pair of prepared.pairs.filter(pair => pair.mode === 'public_transport')) {
      const activity = pool.find(candidate => candidate.day_id === pair.day_id && candidate.place_id === pair.to_id)?.activity_id ?? '@finish';
      const key = JSON.stringify([pair.day_id, activity]);
      transitGroups.set(key, [...(transitGroups.get(key) ?? []), pair]);
    }
    const fairPairs: RoutePair[] = [];
    const groups = [...transitGroups.values()];
    for (let index = 0; index < Math.max(0, ...groups.map(group => group.length)); index++)
      for (const group of groups) if (group[index]) fairPairs.push(group[index]!);
    let samplingStopped = false;
    for (const anchor of [0, 1]) for (const pair of fairPairs) {
      if (samplingStopped) break;
      // Python resolves wall-clock anchors in the locality timezone, including DST.
      const utc = pair.search_sample_utc?.[anchor];
      if (utc === undefined) continue;
      const query = { pair, utc };
      if (cache.has(queryKey(query))) continue;
      if (counters.route_pair_calculations + 1 + reserve > maxPairs || counters.routing_http_calls + 1 + reserve > maxHttp) {
        samplingStopped = true; break;
      }
      try {
        const [observed] = await measure([query], reserve, true);
        queries.push(query); measurements.push(observed!); counters.transit_extra_samples++;
        if (!observed) incompleteMatrix = true;
      } catch (error) {
        if (!(error instanceof DgisRequestBudgetError) || error.code === 'DEADLINE_EXCEEDED') throw error;
        samplingStopped = true;
      }
    }
    const legs = new Map<string, Leg>();
    for (const pair of prepared.pairs) {
      const values = measurements.filter((_, i) => edgeKey(queries[i]!.pair) === edgeKey(pair));
      const measurement = measuredLeg(pair, values);
      if (!measurement || measurement.minutes > 1440) continue;
      legs.set(edgeKey(pair), { ...pair, safe_minutes: measurement.minutes,
        distance_meters: Math.ceil(measurement.distance), source: matrixSource,
        ...(pair.mode === 'walking' ? { cost_upper_minor: 0 } : {}) });
    }
    let currentJob = prepared.job;
    const attempted: string[][] = [];
    const planningJob = () => ({ ...currentJob, as_of: now().toISOString(), route_legs: [...legs.values()] });
    const score = (reply: Awaited<ReturnType<typeof run>>) => z.object({ optimization: z.object({
      stages: z.array(z.object({ value: z.number() })) }) }).safeParse(reply);
    const isWorse = (next: Awaited<ReturnType<typeof run>>, previous: Awaited<ReturnType<typeof run>>) => {
      const a = score(next), b = score(previous);
      if (!a.success) return true;
      if (!b.success) return false;
      for (let index = 0; index < b.data.optimization.stages.length; index++) {
        const before = b.data.optimization.stages[index]!.value, after = a.data.optimization.stages[index]?.value;
        if (after === undefined) return true;
        if (after !== before) return after < before;
      }
      return false;
    };
    async function recover(initial: Awaited<ReturnType<typeof run>>) {
      pipelineStage = 'RECOVERY';
      let result = initial;
      while (['AVAILABLE', 'LIMITED', 'UNAVAILABLE'].includes(result.status)) {
        const reply = await run({ job: planningJob(), result, attempted }, 'recover-routes');
        if (reply.status === 'DONE') {
          recovery.stop_reason = z.string().parse(reply.stop_reason); break;
        }
        if (reply.status !== 'AVAILABLE') return result;
        const proposal = Recovery.parse(reply);
        attempted.push(proposal.proposal.key); recovery.attempts++;
        const queries = proposal.proposal.pairs.flatMap(pair => (pair.sample_utc ?? []).map(utc => ({ pair, utc })));
        const beforePairs = counters.route_pair_calculations;
        let observed: Measurement[];
        try { observed = await measure(queries, 2 * proposal.maximum_selected_legs, true); }
        catch (error) {
          if (!(error instanceof DgisRequestBudgetError) || error.code === 'DEADLINE_EXCEEDED' || error.code === 'SUBSCRIPTION_QUOTA_EXHAUSTED') throw error;
          recovery.added_pairs += counters.route_pair_calculations - beforePairs;
          recovery.stop_reason = 'BUDGET_EXHAUSTED'; break;
        }
        recovery.added_pairs += counters.route_pair_calculations - beforePairs;
        if (observed.some(row => row === null)) { incompleteMatrix = true; continue; }
        const additions: Leg[] = [];
        for (const pair of proposal.proposal.pairs) {
          const values = observed.filter((_, index) => edgeKey(queries[index]!.pair) === edgeKey(pair));
          const measurement = measuredLeg(pair, values);
          if (!measurement || measurement.minutes > 1440) continue;
          // A reused observation retains its original timestamp. The oldest
          // member of the dated sample bundle determines the leg's freshness.
          const sources = queries.filter(query => edgeKey(query.pair) === edgeKey(pair))
            .map(query => cache.get(queryKey(query))!.source).sort((a, b) => a.fetched_at.localeCompare(b.fetched_at));
          additions.push({ ...pair, safe_minutes: measurement.minutes,
            distance_meters: Math.ceil(measurement.distance), source: sources[0]!,
            ...(pair.mode === 'walking' ? { cost_upper_minor: 0 } : {}) });
        }
        if (additions.length !== proposal.proposal.pairs.length) { incompleteMatrix = true; continue; }
        additions.forEach(leg => legs.set(edgeKey(leg), leg));
        const candidate = proposal.proposal.candidate;
        currentJob = { ...currentJob, candidate_pool: [...z.array(Candidate).parse(currentJob.candidate_pool), candidate] };
        candidatePreviewJob = prepared.preview_job ?? currentJob;
        recovery.added_candidates++;
        const groups = z.array(z.object({ day_id: z.string(), activity_id: z.string(), eligible: z.number(), selected: z.number(),
          truncated: z.boolean() }).passthrough()).parse(prepared.shortlist.groups);
        for (const group of groups) if (group.day_id === candidate.day_id && group.activity_id === candidate.activity_id) {
          group.selected++; group.truncated = group.selected < group.eligible;
        }
        prepared.shortlist.groups = groups;
        shortlistTruncated = groups.some(group => group.truncated);
        pipelineStage = 'SOLVE';
        const next = await run(planningJob(), 'solve');
        pipelineStage = 'RECOVERY';
        if (isWorse(next, result)) {
          const stillValid = await run({ job: planningJob(), result }, 'route-checks');
          if (stillValid.status !== 'AVAILABLE') return next;
        } else result = next;
      }
      return result;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      pipelineStage = 'SOLVE';
      let result = await run(planningJob(), 'solve');
      result = await recover(result);
      const job = planningJob();
      if (!['AVAILABLE', 'LIMITED'].includes(result.status)) return { ...result,
        warnings: [...(z.array(z.string()).optional().parse(result.warnings) ?? []), ...routingWarnings()],
        shortlist: prepared.shortlist, routing: metadata(), ...scope(),
        ...(result.status === 'UNAVAILABLE' && counters.routing_failed_batches ? projectCandidatePreview(candidatePreviewJob, now()) : {}) };
      pipelineStage = 'DEPARTURE_CHECKS';
      const checkReply = await run({ job: { ...job, as_of: now().toISOString() }, result }, 'route-checks');
      if (checkReply.status !== 'AVAILABLE') return stop('PLAN_EXPIRED_OR_INVALID');
      const checks = Checks.parse(checkReply).checks;
      const observations = await measure(checks.map(pair => ({ pair, utc: pair.departure_utc })), 0, false, options.includeGeometry);
      let changed = false;
      checks.forEach((check, i) => {
        const row = observations[i], key = edgeKey(check), leg = legs.get(key)!;
        const seconds = row ? conservativeTravelSeconds(check, row) : null;
        const minutes = seconds === null ? Infinity : safeMinutes(seconds, check, row!);
        if (minutes > 1440) { legs.delete(key); changed = true; incompleteMatrix = true; }
        else if (minutes > check.safe_minutes) {
          legs.set(key, { ...leg, safe_minutes: minutes,
            distance_meters: Math.max(leg.distance_meters ?? 0, Math.ceil(row!.distanceMeters)),
            source: cache.get(queryKey({ pair: check, utc: check.departure_utc }))!.source }); changed = true;
        }
      });
      if (changed) {
        if (attempt === 0) { counters.replans++; continue; }
        return stop('ROUTE_RECHECK_FAILED'); // Never deliver the old schedule after a failed recheck.
      }
      // Time may have advanced while waiting for HTTP. Check freshness and constraints again without solving.
      pipelineStage = 'FINAL_VALIDATION';
      const finalCheck = await run({ job: { ...job, as_of: now().toISOString() }, result }, 'route-checks');
      if (finalCheck.status !== 'AVAILABLE') return stop('PLAN_EXPIRED_OR_INVALID');
      const geometryWarnings = options.includeGeometry && observations.some(row => !row?.geometry?.length)
        ? ['ROUTE_GEOMETRY_UNAVAILABLE'] : [];
      const transit = observations.flatMap(row => row?.transit ? [row.transit] : []);
      counters.transit_selected_segments = transit.length;
      counters.transit_pedestrian_segments = transit.filter(row => row.pedestrian).length;
      counters.transit_unknown_schedules = transit.filter(row => !row.pedestrian && row.scheduleEvidence === 'unknown').length;
      const transitWarnings = [ ...(counters.transit_pedestrian_segments ? ['PT_WALKING_SEGMENT'] : []),
        ...(counters.transit_unknown_schedules ? ['PT_SCHEDULE_UNVERIFIED'] : []) ];
      const days = z.array(z.object({ day_id: z.string() }).passthrough()).parse(result.days);
      const displayDays = options.includeGeometry || hasTransit ? days.map(day => ({ ...day,
        travel_segments: checks.flatMap((check, index) => check.day_id === day.day_id &&
          (observations[index]?.geometry?.length || observations[index]?.transit)
          ? [{ from_id: check.from_id, to_id: check.to_id, departure_utc: check.departure_utc, mode: check.mode,
            coordinates: observations[index]!.geometry ?? [],
            ...(observations[index]!.transit ? { transit: observations[index]!.transit } : {}),
            source: cache.get(queryKey({ pair: check, utc: check.departure_utc }))!.source }] : []),
      })) : days;
      const sourceExpiry = [
        ...checks.map(check => Date.parse(legs.get(edgeKey(check))!.source.valid_until)),
        ...checks.map(check => Date.parse(cache.get(queryKey({ pair: check, utc: check.departure_utc }))!.source.valid_until)),
        ...z.array(z.object({ visits: z.array(z.object({ source: z.object({ valid_until: z.string() }) })) }))
          .parse(result.days).flatMap(day => day.visits.map(visit => Date.parse(visit.source.valid_until))),
      ];
      const validUntil = Math.min(...sourceExpiry);
      if (!Number.isFinite(validUntil) || validUntil <= now().getTime()) return stop('PLAN_EXPIRED_OR_INVALID');
      return { ...result, days: displayDays, valid_until: new Date(validUntil).toISOString(),
        warnings: [...new Set([...(z.array(z.string()).parse(result.warnings)), ...routingWarnings(), ...geometryWarnings, ...transitWarnings, 'ROUTE_TIME_IS_ESTIMATE'])],
        shortlist: prepared.shortlist, ...scope(), routing: { ...metadata(), verified_at: now().toISOString(),
          checked_departures: checks.map((check, i) => ({ day_id: check.day_id, from_id: check.from_id, to_id: check.to_id,
            departure_utc: check.departure_utc, observed_seconds: observations[i]!.durationSeconds, reserved_minutes: check.safe_minutes })),
          arrival_guaranteed: false } };
    }
    return stop('ROUTE_RECHECK_FAILED');
  } catch (error) {
    if (error instanceof DgisRoutingUnavailableError) return stop('ROUTING_PROVIDER_UNAVAILABLE');
    if (error instanceof DgisRequestBudgetError) {
      budgetStopCode = error.code;
      return stop('ROUTING_BUDGET_OR_DEADLINE_EXCEEDED');
    }
    return stop('PLANNING_PIPELINE_FAILED'); // Never return provider payload, key URLs, paths or input text.
  }
}
