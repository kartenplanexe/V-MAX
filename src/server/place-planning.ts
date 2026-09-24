import { z } from 'zod';
import { DgisClient, DgisProviderError, pairKey, type Coordinates } from './dgis.js';
import { retrievePlaceCandidates } from './place-retrieval.js';
import { runPythonPlanner } from './planner-process.js';

const Point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const Pair = z.object({ day_id: z.string(), from_id: z.string(), to_id: z.string(),
  from_point: Point, to_point: Point, date: z.string(), window: z.object({ start: z.string(), end: z.string() }),
  mode: z.enum(['walking', 'driving', 'cycling']), sample_utc: z.array(z.number().int()).optional(),
});
const Prepared = z.object({ job: z.record(z.string(), z.unknown()), pairs: z.array(Pair),
  shortlist: z.record(z.string(), z.unknown()), maximum_selected_legs: z.number().int().nonnegative() });
const Checks = z.object({ checks: z.array(Pair.extend({ departure_utc: z.number().int(), safe_minutes: z.number().int() })) });
type RoutePair = z.infer<typeof Pair>;
type Query = { pair: RoutePair; utc: number };
type Measurement = { durationSeconds: number; distanceMeters: number } | null;
type Source = { provider: string; fetched_at: string; valid_until: string; data_mode: 'live' | 'test' };
type Leg = RoutePair & { safe_minutes: number; source: Source; cost_upper_minor?: number };
const ROUTING_POLICY = 'dated-routing.v1';

function edgeKey(pair: RoutePair) { return JSON.stringify([pair.day_id, pair.from_id, pair.to_id]); }
function safeMinutes(seconds: number) { return Math.ceil(seconds / 60 * 1.25) + 2; }
function batches(queries: Query[]) {
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
    return Array.from({ length: Math.ceil(entries.length / 50) }, (_, index) => ({
      utc: group.utc, mode: group.mode, entries: entries.slice(index * 50, (index + 1) * 50),
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
  dataMode?: 'live' | 'test';
  now?: () => Date;
  planner?: Parameters<typeof runPythonPlanner>[1];
}) {
  const now = options.now ?? (() => new Date());
  const maxPairs = z.number().int().min(1).max(1000).parse(options.maxRoutePairs ?? 200);
  const maxHttp = z.number().int().min(1).max(100).parse(options.maxRoutingHttpCalls ?? 30);
  const mode = options.dataMode ?? 'live';
  const started = Date.now();
  const counters = { places_http_calls: 0, route_pair_calculations: 0, routing_http_calls: 0, routing_failed_batches: 0, replans: 0 };
  const metadata = () => ({ policy: ROUTING_POLICY, ...counters, llm_calls: 0, provider_payload_persisted: false,
    max_route_pair_calculations: maxPairs, max_routing_http_calls: maxHttp, data_mode: mode });
  const stop = (issue: string) => ({ schema_version: 'place-selection.v1', status: 'ERROR', issues: [issue], days: [], routing: metadata() });
  const run = (job: unknown, operation: 'solve' | 'prepare-routes' | 'route-checks') =>
    runPythonPlanner(job, { ...options.planner, operation });
  const source = (): Source => { const at = now(); return { provider: '2gis', data_mode: mode,
    fetched_at: at.toISOString(), valid_until: new Date(at.getTime() + 300_000).toISOString() }; };
  let shortage = false;
  let incompleteMatrix = false;
  const routingWarnings = () => [
    ...(counters.routing_failed_batches ? ['ROUTING_PROVIDER_FAILURE'] : []),
    ...(incompleteMatrix ? ['ROUTE_MATRIX_INCOMPLETE'] : []),
  ];
  async function measure(queries: Query[]): Promise<Measurement[]> {
    const output: Measurement[] = queries.map(() => null);
    const requests = batches(queries);
    if (counters.route_pair_calculations + requests.reduce((sum, b) => sum + b.entries.length, 0) > maxPairs ||
        counters.routing_http_calls + requests.length > maxHttp) { shortage = true; return output; }
    for (const batch of requests) {
      if (Date.now() - started > 90_000) { shortage = true; return output; }
      counters.route_pair_calculations += batch.entries.length; counters.routing_http_calls++;
      try {
        const rows = await client.buildRoutePairs({ pairs: batch.entries.map(e => e.pair), departureUtc: batch.utc,
          transport: batch.mode === 'cycling' ? 'bicycle' : batch.mode });
        batch.entries.forEach((entry, i) => entry.indices.forEach(index => { output[index] = rows[i] ?? null; }));
      } catch (error) {
        if (!(error instanceof DgisProviderError)) throw error;
        counters.routing_failed_batches++; // No automatic HTTP retries, missing edges stay forbidden.
      }
    }
    return output;
  }
  try {
    // Validate the entire intent, date/timezone, durations and supported modes BEFORE external requests.
    const base = { schema_version: input.schema_version, as_of: now().toISOString(), intent: input.intent,
      catalog: input.catalog, visit_policy: input.visit_policy, budget_policy: input.budget_policy,
      routing_policy: input.routing_policy, places: [], route_legs: [] };
    const preflight = await run(base, 'prepare-routes');
    if (preflight.status !== 'AVAILABLE') return { ...preflight, routing: metadata() };
    const catalog = z.object({ version: z.string() }).parse(input.catalog);
    const fetchedAt = now();
    const retrieval = await retrievePlaceCandidates(client, input.intent, { ...options.retrieval, catalogVersion: catalog.version });
    counters.places_http_calls = retrieval.requests;
    const { places: _empty, ...withoutPlaces } = base;
    const preparedReply = await run({ ...withoutPlaces, as_of: now().toISOString(),
      retrieval: { coverage: retrieval.coverage }, provider_batches: [{ items: retrieval.places, region_id: retrieval.region_id,
        fetched_at: fetchedAt.toISOString(), valid_until: new Date(fetchedAt.getTime() + 900_000).toISOString(), data_mode: mode }] }, 'prepare-routes');
    if (preparedReply.status !== 'AVAILABLE') return { ...preparedReply, routing: metadata() };
    const prepared = Prepared.parse(preparedReply);
    const queries = prepared.pairs.flatMap(pair => (pair.sample_utc ?? []).map(utc => ({ pair, utc })));
    const matrixBatches = batches(queries);
    // Reserve both verification rounds before spending on the matrix. Each route pair can be billed.
    const reserve = prepared.maximum_selected_legs * 2;
    if (queries.length && (matrixBatches.reduce((n, b) => n + b.entries.length, 0) + reserve > maxPairs ||
        matrixBatches.length + reserve > maxHttp)) return stop('ROUTING_BUDGET_EXCEEDED');
    const matrixSource = source(); // Do not refresh older measurements merely because a later HTTP batch completed.
    const measurements = await measure(queries);
    incompleteMatrix = measurements.some(row => row === null);
    if (shortage) return stop('ROUTING_BUDGET_OR_DEADLINE_EXCEEDED');
    const legs = new Map<string, Leg>();
    for (const pair of prepared.pairs) {
      const values = measurements.filter((_, i) => edgeKey(queries[i]!.pair) === edgeKey(pair));
      if (!values.length || values.some(value => value === null)) continue;
      const minutes = safeMinutes(Math.max(...values.map(value => value!.durationSeconds)));
      if (minutes > 1440) continue;
      legs.set(edgeKey(pair), { ...pair, safe_minutes: minutes, source: matrixSource,
        ...(pair.mode === 'walking' ? { cost_upper_minor: 0 } : {}) });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const job = { ...prepared.job, as_of: now().toISOString(), route_legs: [...legs.values()] };
      const result = await run(job, 'solve');
      if (!['AVAILABLE', 'LIMITED'].includes(result.status)) return { ...result,
        warnings: [...(z.array(z.string()).optional().parse(result.warnings) ?? []), ...routingWarnings()],
        shortlist: prepared.shortlist, routing: metadata() };
      const checkReply = await run({ job: { ...job, as_of: now().toISOString() }, result }, 'route-checks');
      if (checkReply.status !== 'AVAILABLE') return stop('PLAN_EXPIRED_OR_INVALID');
      const checks = Checks.parse(checkReply).checks;
      const observations = await measure(checks.map(pair => ({ pair, utc: pair.departure_utc })));
      if (shortage) return stop('ROUTING_BUDGET_OR_DEADLINE_EXCEEDED');
      let changed = false;
      checks.forEach((check, i) => {
        const row = observations[i], key = edgeKey(check), leg = legs.get(key)!;
        if (!row || safeMinutes(row.durationSeconds) > 1440) { legs.delete(key); changed = true; incompleteMatrix = true; }
        else if (safeMinutes(row.durationSeconds) > check.safe_minutes) {
          legs.set(key, { ...leg, safe_minutes: safeMinutes(row.durationSeconds), source: source() }); changed = true;
        }
      });
      if (changed) {
        if (attempt === 0) { counters.replans++; continue; }
        return stop('ROUTE_RECHECK_FAILED'); // Never deliver the old schedule after a failed recheck.
      }
      // Time may have advanced while waiting for HTTP. Check freshness and constraints again without solving.
      const finalCheck = await run({ job: { ...job, as_of: now().toISOString() }, result }, 'route-checks');
      if (finalCheck.status !== 'AVAILABLE') return stop('PLAN_EXPIRED_OR_INVALID');
      return { ...result, warnings: [...new Set([...(z.array(z.string()).parse(result.warnings)), ...routingWarnings(), 'ROUTE_TIME_IS_ESTIMATE'])],
        shortlist: prepared.shortlist, routing: { ...metadata(), verified_at: now().toISOString(),
          checked_departures: checks.map((check, i) => ({ day_id: check.day_id, from_id: check.from_id, to_id: check.to_id,
            departure_utc: check.departure_utc, observed_seconds: observations[i]!.durationSeconds, reserved_minutes: check.safe_minutes })),
          arrival_guaranteed: false } };
    }
    return stop('ROUTE_RECHECK_FAILED');
  } catch {
    return stop('PLANNING_PIPELINE_FAILED'); // Never return provider payload, key URLs, paths or input text.
  }
}
