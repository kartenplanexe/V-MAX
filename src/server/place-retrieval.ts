import { z } from 'zod';
import { DgisClient, DgisProviderError } from './dgis.js';

// Projection of the server-confirmed intent; this function does not establish
// MAX authentication or accept a raw LLM response as authority.
const Id = z.string().regex(/^\d+$/u);
const RetrievalIntent = z.object({
  schema_version: z.literal('confirmed-daily-intent.research.v1'),
  locality: z.object({ id: z.string().min(1), region_id: Id }),
  points: z.object({ origin: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), locality_id: z.string() }) }),
  days: z.array(z.object({ day_id: z.string().min(1), activities: z.array(z.object({
    id: z.string().min(1), categories: z.object({ state: z.literal('matched'),
      region_id: Id, catalog_version: z.string().min(1),
      include_any: z.array(Id).min(1), exclude: z.array(Id),
    }),
  })).min(1) })).min(1),
});

type Place = Awaited<ReturnType<DgisClient['searchPlacesByCategories']>>['items'][number];

export async function retrievePlaceCandidates(
  client: DgisClient,
  confirmedIntent: unknown,
  options: { catalogVersion: string; radiusMeters: number; pageSize?: number; maxPages?: number; maxRequests?: number },
) {
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
  if (groups.size * maxPages > maxRequests) throw new DgisProviderError('Retrieval exceeds the explicit request budget.');
  const places = new Map<string, Place & { fetched_at: string }>();
  const searches: { rubric_ids: string[]; targets: { day_id: string; activity_id: string }[];
    status: 'OK' | 'PROVIDER_ERROR'; truncated: boolean; pages: number; received: number }[] = [];
  let calls = 0;
  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    let status: 'OK' | 'PROVIDER_ERROR' = 'OK', truncated = true, received = 0, pages = 0;
    for (let page = 1; page <= maxPages; page++) {
      calls++;
      try {
        const response = await client.searchPlacesByCategories({ center: intent.points.origin,
          regionId: intent.locality.region_id, rubricIds: group.rubricIds, page, pageSize, radiusMeters });
        pages++; received += response.items.length;
        const fetchedAt = new Date().toISOString();
        for (const item of response.items) if (!places.has(item.id)) places.set(item.id, { ...item, fetched_at: fetchedAt });
        if (response.items.length < pageSize || (response.total !== null && page * pageSize >= response.total)) {
          truncated = false; break;
        }
      } catch (error) {
        if (!(error instanceof DgisProviderError)) throw error;
        status = 'PROVIDER_ERROR'; break;
      }
    }
    searches.push({ rubric_ids: group.rubricIds, targets: group.targets, status, truncated, pages, received });
  }
  return { places: [...places.values()].sort((a, b) => a.id.localeCompare(b.id)), searches, requests: calls,
    coverage: searches.some(s => s.status === 'PROVIDER_ERROR' || s.truncated) ? 'PARTIAL' as const : 'BOUNDED_RESULTS' as const,
    region_id: intent.locality.region_id, radius_meters: radiusMeters, catalog_version: options.catalogVersion,
    provider_payload_persisted: false, llm_calls: 0 };
}
