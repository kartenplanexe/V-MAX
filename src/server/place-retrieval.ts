import { z } from 'zod';
import { DgisClient, DgisProviderError, DgisRequestBudgetError } from './dgis.js';
import { SelectedEventTargetSchema } from '../shared/event-selection.js';

// Projection of the server-confirmed intent; this function does not establish
// MAX authentication or accept a raw LLM response as authority.
const Id = z.string().regex(/^\d+$/u);
const RetrievalIntent = z.object({
  schema_version: z.literal('confirmed-daily-intent.research.v1'),
  locality: z.object({ id: z.string().min(1), region_id: Id }),
  points: z.object({ origin: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), locality_id: z.string() }) }),
  days: z.array(z.object({ day_id: z.string().min(1), activities: z.array(z.union([z.object({
    id: z.string().min(1), target: z.never().optional(), categories: z.object({ state: z.literal('matched'),
      region_id: Id, catalog_version: z.string().min(1),
      include_any: z.array(Id).min(1), exclude: z.array(Id),
    }),
  }), z.object({ id: z.string().min(1), intent_kind: z.literal('event_visit'), target: SelectedEventTargetSchema,
    categories: z.never().optional(), selection: z.never().optional() })])).min(1) })).min(1),
});

type Place = Awaited<ReturnType<DgisClient['searchPlacesByCategories']>>['items'][number];
type BudgetStop = 'HTTP_BUDGET_EXHAUSTED' | 'DEADLINE_EXCEEDED';
export type RetrievalSearch = {
  rubric_ids: string[]; targets: { day_id: string; activity_id: string }[];
  status: 'OK' | 'PROVIDER_ERROR' | 'BUDGET_EXHAUSTED' | 'NOT_SEARCHED'; failure_code: string | null;
  stop_reason: 'RESULTS_EXHAUSTED' | 'PAGE_LIMIT' | BudgetStop | 'PROVIDER_ERROR' | 'TOTAL_UNKNOWN' | 'REPEATED_PAGE' | 'RESULT_COUNT_INCONSISTENT' | 'INVALID_ITEMS' | null;
  truncated: boolean; pages: number; received: number; rejected_items: number; attempts: number;
};

export async function retrievePlaceCandidates(
  client: DgisClient,
  confirmedIntent: unknown,
  options: { catalogVersion: string; radiusMeters: number; pageSize?: number; maxPages?: number; maxRequests?: number;
    shouldContinue?: () => boolean; requestBudget?: { consume(): void } },
) {
  const started = performance.now();
  const intent = RetrievalIntent.parse(confirmedIntent);
  const { pageSize = 20, maxPages = 2, maxRequests = 20, radiusMeters } = options;
  for (const [value, min, max] of [[pageSize, 1, 50], [maxPages, 1, 5], [maxRequests, 1, 30], [radiusMeters, 1, 50_000]]) {
    if (value === undefined || min === undefined || max === undefined || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new DgisProviderError('Invalid bounded retrieval policy.');
    }
  }
  if (intent.points.origin.locality_id !== intent.locality.id) throw new DgisProviderError('Origin locality mismatch.');
  const groups = new Map<string, { rubricIds: string[]; targets: { day_id: string; activity_id: string }[] }>();
  for (const day of intent.days) for (const activity of day.activities) {
    if (activity.target) continue; // Events are resolved by their own provider, never converted to 2GIS rubrics.
    const c = activity.categories;
    if (c.catalog_version !== options.catalogVersion || c.region_id !== intent.locality.region_id ||
        c.include_any.some(id => c.exclude.includes(id))) throw new DgisProviderError('Activity catalog mismatch.');
    const unique = [...new Set(c.include_any)].sort();
    // Chunk the full requested set, never silently discard or reinterpret IDs.
    for (let offset = 0; offset < unique.length; offset += 100) {
      const rubricIds = unique.slice(offset, offset + 100), key = rubricIds.join(',');
      const group = groups.get(key) ?? { rubricIds, targets: [] };
      group.targets.push({ day_id: day.day_id, activity_id: activity.id });
      groups.set(key, group);
    }
  }
  const places = new Map<string, Place & { fetched_at: string }>();
  const states = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => ({
    group, seen: new Set<string>(), total: null as number | null, done: false,
    search: { rubric_ids: group.rubricIds, targets: group.targets, status: 'NOT_SEARCHED', failure_code: null,
      stop_reason: null, truncated: true, pages: 0, received: 0, rejected_items: 0, attempts: 0 } as RetrievalSearch,
  }));
  let calls = 0, queries = 0;
  const stopReason = (): BudgetStop | null => performance.now() - started >= 90_000 || options.shouldContinue?.() === false
    ? 'DEADLINE_EXCEEDED' : calls >= maxRequests ? 'HTTP_BUDGET_EXHAUSTED' : null;
  const stopIncomplete = (reason: BudgetStop) => {
    for (const state of states) if (!state.done) {
      state.search.status = state.search.attempts ? 'BUDGET_EXHAUSTED' : 'NOT_SEARCHED';
      state.search.stop_reason = reason; state.done = true;
    }
  };
  // First pages cover all groups before any second page. The budget is spent
  // only on real dispatches, never a worst-case reservation for unused pages.
  rounds: for (let page = 1; page <= maxPages; page++) {
    for (const state of states) {
      if (state.done) continue;
      const stop = stopReason();
      if (stop) { stopIncomplete(stop); break rounds; }
      const { group, search } = state;
      queries++;
      try {
        const response = await client.searchPlacesByCategories({ center: intent.points.origin,
          regionId: intent.locality.region_id, rubricIds: group.rubricIds, page, pageSize, radiusMeters,
          requestBudget: { consume() {
            const reason = stopReason();
            if (reason) throw new DgisRequestBudgetError(reason);
            options.requestBudget?.consume();
            calls++; search.attempts++;
          } },
        });
        search.status = 'OK'; search.pages++; search.received += response.items.length;
        search.rejected_items += response.rejectedItems;
        if (response.schemaFailure && search.failure_code === null) search.failure_code = response.schemaFailure;
        const previousTotal = state.total;
        if (response.total !== null) state.total = Math.max(state.total ?? 0, response.total);
        const before = state.seen.size;
        const fetchedAt = new Date().toISOString();
        for (const item of response.items) {
          state.seen.add(item.id);
          if (!places.has(item.id)) places.set(item.id, { ...item, fetched_at: fetchedAt });
        }
        // Pages are not an atomic provider snapshot. Contradictory/changing
        // counts cannot prove exhaustion, even though individual rows are usable.
        if (response.total !== null && (state.seen.size > response.total || previousTotal !== null && previousTotal !== response.total)) {
          search.stop_reason = 'RESULT_COUNT_INCONSISTENT'; state.done = true;
        } else if (response.total === null && previousTotal !== null) {
          search.stop_reason = 'TOTAL_UNKNOWN'; state.done = true;
        } else if (state.total !== null && state.seen.size === state.total && search.rejected_items === 0) {
          search.truncated = false; search.stop_reason = 'RESULTS_EXHAUSTED'; state.done = true;
        } else if (page > 1 && response.items.length && state.seen.size === before) {
          search.stop_reason = 'REPEATED_PAGE'; state.done = true;
        } else if (response.rawItemCount < pageSize) {
          search.stop_reason = search.rejected_items > 0 ? 'INVALID_ITEMS'
            : state.total === null ? 'TOTAL_UNKNOWN' : 'RESULT_COUNT_INCONSISTENT'; state.done = true;
        } else if (page === maxPages) {
          search.stop_reason = 'PAGE_LIMIT'; state.done = true;
        }
      } catch (error) {
        if (error instanceof DgisRequestBudgetError && (error.code === 'HTTP_BUDGET_EXHAUSTED' || error.code === 'DEADLINE_EXCEEDED')) {
          stopIncomplete(error.code); break rounds;
        }
        if (!(error instanceof DgisProviderError)) throw error;
        search.status = 'PROVIDER_ERROR'; search.stop_reason = 'PROVIDER_ERROR'; state.done = true;
        const code = /^2GIS returned HTTP (\d{3})\.$/u.exec(error.message)?.[1];
        const providerCode = /^2GIS Places provider code (\d{3}); type ([A-Z]+); hints ([a-z_]+)\.$/u.exec(error.message);
        const schemaPath = /^2GIS Places response schema failed at ([a-zA-Z0-9.*]+)\.$/u.exec(error.message)?.[1];
        search.failure_code = code ? `HTTP_${code}` : providerCode ? `PROVIDER_${providerCode[1]}_${providerCode[2]}_${(providerCode[3] ?? 'none').toUpperCase()}`
          : schemaPath ? `SCHEMA_${schemaPath.replace(/[^A-Za-z0-9]/gu, '_').toUpperCase()}`
          : error.message.includes('timed out') || error.message.includes('request failed')
            ? 'TRANSPORT' : 'INVALID_PROVIDER_RESPONSE';
      }
    }
  }
  const searches = states.map(state => state.search);
  return { places: [...places.values()].sort((a, b) => a.id.localeCompare(b.id)), searches, requests: calls, queries,
    coverage: searches.some(s => s.status !== 'OK' || s.truncated) ? 'PARTIAL' as const : 'BOUNDED_RESULTS' as const,
    region_id: intent.locality.region_id, radius_meters: radiusMeters, catalog_version: options.catalogVersion,
    provider_payload_persisted: false, llm_calls: 0 };
}
