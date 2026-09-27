import { z } from 'zod';
import { DgisKeyFallback, shouldTryDgisBackup, type DgisService } from './dgis-key-fallback.js';
import { normalizeRouteGeometry } from './route-geometry.js';
import { normalizePublicTransport, publicTransportRequest } from './dgis-public-transport.js';

const PointSchema = z.object({
  lat: z.number(),
  lon: z.number(),
});

const PlaceItemSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  point: PointSchema.extend({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).optional(),
  type: z.string().optional(),
}).passthrough();

const PlacesResponseSchema = z.object({
  meta: z
    .object({
      code: z.number(),
    })
    .passthrough(),
  result: z
    .object({
      items: z.array(z.unknown()).default([]),
      total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .refine(result => result.total === undefined || new Set(result.items.flatMap(item =>
      item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' ? [item.id] : [])).size <= result.total,
      { path: ['total'], message: 'Result count is inconsistent.' })
    .optional(),
});

const RoutingResponseSchema = z
  .object({
    message: z.string().nullable().optional(),
    result: z.array(z.unknown()).nullable().optional(),
    status: z.string(),
    type: z.enum(['result', 'error']),
  })
  .passthrough();

export interface Coordinates {
  lat: number;
  lon: number;
}

export type RouteTransport = 'bicycle' | 'driving' | 'motorcycle' | 'scooter' | 'walking';

export interface DgisClientOptions {
  fetchImpl?: typeof fetch;
  placesApiKey: string;
  routingApiKey: string;
  backupApiKey?: string;
  tertiaryApiKey?: string;
  timeoutMs?: number;
}

export class DgisProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DgisProviderError';
  }
}

/** Owned by one operation, not by the shared client. Called synchronously before
 * every physical HTTP attempt, including denied-key fallback attempts. */
export interface DgisRequestBudget { consume(): void }
export class DgisRequestBudgetError extends Error {
  constructor(readonly code: 'HTTP_BUDGET_EXHAUSTED' | 'PAIR_BUDGET_EXHAUSTED' | 'DEADLINE_EXCEEDED' = 'HTTP_BUDGET_EXHAUSTED') {
    super(code); this.name = 'DgisRequestBudgetError';
  }
}

export class DgisClient {
  readonly #fetch: typeof fetch;
  readonly #placesApiKey: string;
  readonly #routingApiKey: string;
  readonly #placesKeys: DgisKeyFallback;
  readonly #routingKeys: DgisKeyFallback;
  readonly #timeoutMs: number;

  constructor(options: DgisClientOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#placesApiKey = options.placesApiKey.trim();
    this.#routingApiKey = options.routingApiKey.trim();
    const backups = [options.backupApiKey ?? '', options.tertiaryApiKey ?? ''];
    this.#placesKeys = new DgisKeyFallback(this.#placesApiKey, backups);
    this.#routingKeys = new DgisKeyFallback(this.#routingApiKey, backups);
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async searchPlaces(input: {
    center: Coordinates;
    pageSize?: number;
    query: string;
    radiusMeters?: number;
    requestBudget?: DgisRequestBudget;
  }) {
    if (!input.query.trim()) throw new DgisProviderError('2GIS Places query must not be empty.');
    const page = await this.#searchPlacePage(input);
    if (!page.items.length && page.schemaPath) {
      throw new DgisProviderError(`2GIS Places response schema failed at ${page.schemaPath}.`);
    }
    return page.items;
  }

  async searchPlacesByCategories(input: {
    center: Coordinates;
    regionId: string;
    rubricIds: string[];
    page?: number;
    pageSize?: number;
    radiusMeters?: number;
    requestBudget?: DgisRequestBudget;
  }) {
    if (!/^\d+$/u.test(input.regionId) || input.rubricIds.length < 1 || input.rubricIds.length > 100 ||
        input.rubricIds.some(id => !/^\d+$/u.test(id)) || new Set(input.rubricIds).size !== input.rubricIds.length) {
      throw new DgisProviderError('2GIS category search requires regional category IDs.');
    }
    return this.#searchPlacePage(input);
  }

  async #searchPlacePage(input: {
    center: Coordinates;
    query?: string;
    regionId?: string;
    rubricIds?: string[];
    page?: number;
    pageSize?: number;
    radiusMeters?: number;
    requestBudget?: DgisRequestBudget;
  }) {
    validateCoordinates(input.center);
    const page = input.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
      throw new DgisProviderError('2GIS Places page is outside provider limits.');
    }
    const pageSize = input.pageSize ?? 10;
    const radiusMeters = input.radiusMeters ?? 15_000;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new DgisProviderError('2GIS Places page size must be between 1 and 50.');
    }
    if (!Number.isSafeInteger(radiusMeters) || radiusMeters < 0 || radiusMeters > 50_000) {
      throw new DgisProviderError('2GIS Places radius must be between 0 and 50000 meters.');
    }

    const url = new URL('https://catalog.api.2gis.com/3.0/items');
    url.search = new URLSearchParams({
      fields: [
        'items.point',
        'items.adm_div',
        'items.full_address_name',
        'items.city_alias',
        'items.region_id',
        'items.rubrics',
        'items.schedule',
        'items.schedule_special',
        'items.reviews',
        'items.attribute_groups',
        'items.flags',
        'items.dates.updated_at',
      ].join(','),
      key: requireKey(this.#placesApiKey, 'DGIS_PLACES_API_KEY'),
      page_size: String(pageSize),
      page: String(page),
      point: `${input.center.lon},${input.center.lat}`,
      radius: String(radiusMeters),
      sort: 'relevance',
    }).toString();
    if (input.query !== undefined) url.searchParams.set('q', input.query.trim());
    if (input.rubricIds) {
      url.searchParams.set('rubric_id', input.rubricIds.join(','));
      url.searchParams.set('region_id', input.regionId!);
    }

    const body = await this.#request(url, { headers: { Accept: 'application/json' } }, 'places', input.requestBudget);
    const providerCode = z.object({ meta: z.object({ code: z.number().int() }) }).safeParse(body);
    if (providerCode.success && providerCode.data.meta.code !== 200) {
      const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
      const meta = value.meta && typeof value.meta === 'object' ? value.meta as Record<string, unknown> : {};
      const error = meta.error && typeof meta.error === 'object' ? meta.error as Record<string, unknown> : {};
      const diagnostic = [error.message, meta.message, value.error, value.message]
        .filter(value => typeof value === 'string').join(' ').toLowerCase();
      // Only predefined API parameter names may leave this function; never log provider prose or request URLs.
      const hints = ['rubric_id', 'region_id', 'page_size', 'radius', 'point', 'sort', 'fields', 'key', 'query', 'q']
        .filter(name => new RegExp(`(?:^|[^a-z_])${name}(?:$|[^a-z_])`, 'u').test(diagnostic));
      const errorType = typeof error.type === 'string' && /^[a-zA-Z]{1,40}$/u.test(error.type)
        ? error.type.toUpperCase() : 'UNKNOWN';
      throw new DgisProviderError(`2GIS Places provider code ${providerCode.data.meta.code}; type ${errorType}; hints ${hints.join('_') || 'none'}.`);
    }
    const parsed = PlacesResponseSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      // Only a schema path is retained; never include values from the provider response.
      const path = first?.path.map(segment => typeof segment === 'number' ? '*' : String(segment)).join('.') || 'root';
      throw new DgisProviderError(`2GIS Places response schema failed at ${path}.`);
    }
    const rawItems = parsed.data.result?.items ?? [];
    const items: z.infer<typeof PlaceItemSchema>[] = [];
    let schemaPath: string | null = null;
    for (const raw of rawItems) {
      const item = PlaceItemSchema.safeParse(raw);
      if (item.success) items.push(item.data);
      else if (schemaPath === null) {
        const path = item.error.issues[0]?.path.map(segment => typeof segment === 'number' ? '*' : String(segment)).join('.');
        schemaPath = `result.items.*${path ? '.' + path : ''}`;
      }
    }
    // Keep valid rows without treating filtered rows as a short/exhausted page.
    // Only schema paths/counts leave the validation boundary for rejected rows.
    return { items, total: parsed.data.result?.total ?? null, rawItemCount: rawItems.length,
      rejectedItems: rawItems.length - items.length, schemaPath,
      schemaFailure: schemaPath ? `SCHEMA_${schemaPath.replace(/[^A-Za-z0-9]/gu, '_').toUpperCase()}` : null };
  }

  async buildRoute(input: {
    points: [Coordinates, Coordinates, ...Coordinates[]];
    transport: RouteTransport;
    requestBudget?: DgisRequestBudget;
  }) {
    const maximumPoints = input.transport === 'walking' ? 5 : 10;
    if (input.points.length > maximumPoints) {
      throw new DgisProviderError(
        `2GIS Routing accepts at most ${maximumPoints} points for ${input.transport}.`,
      );
    }
    input.points.forEach(validateCoordinates);

    const url = new URL('https://routing.api.2gis.com/routing/7.0.0/global');
    url.searchParams.set('key', requireKey(this.#routingApiKey, 'DGIS_ROUTING_API_KEY'));

    const body = await this.#request(url, {
      body: JSON.stringify({
        locale: 'ru',
        output: 'summary',
        points: input.points.map((point) => ({ ...point, type: 'stop' })),
        route_mode: 'fastest',
        transport: input.transport,
      }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      method: 'POST',
    }, 'routing', input.requestBudget);
    const parsed = RoutingResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.type !== 'result' || parsed.data.status !== 'OK') {
      throw new DgisProviderError('2GIS Routing could not build the requested route.');
    }
    return parsed.data;
  }

  /** One final dated leg: its displayed path and measured time share one observation. */
  async buildRouteSegment(input: {
    from: Coordinates; to: Coordinates; transport: 'walking' | 'driving' | 'bicycle';
    departureUtc: number; requestBudget?: DgisRequestBudget;
  }) {
    validateCoordinates(input.from); validateCoordinates(input.to);
    if (!['walking', 'driving', 'bicycle'].includes(input.transport) ||
        !Number.isSafeInteger(input.departureUtc) || input.departureUtc < 0)
      throw new DgisProviderError('Invalid dated routing segment.');
    const url = new URL('https://routing.api.2gis.com/routing/7.0.0/global');
    url.searchParams.set('key', requireKey(this.#routingApiKey, 'DGIS_ROUTING_API_KEY'));
    const body = await this.#request(url, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: [input.from, input.to].map(point => ({ ...point, type: 'stop' })),
        transport: input.transport, output: 'detailed', locale: 'ru', route_mode: 'fastest',
        traffic_mode: 'statistics', utc: input.departureUtc, save_route: false }),
    }, 'routing', input.requestBudget);
    const parsed = z.object({ status: z.literal('OK'), type: z.literal('result'),
      query: z.object({ points: z.array(PointSchema).length(2) }),
      result: z.array(z.object({ total_duration: z.number().nonnegative(), total_distance: z.number().nonnegative() }).passthrough()).min(1),
    }).safeParse(body);
    if (!parsed.success || pairKey(parsed.data.query.points[0]!, parsed.data.query.points[1]!) !== pairKey(input.from, input.to))
      throw new DgisProviderError('2GIS detailed route does not match the requested segment.');
    const route = parsed.data.result[0]!;
    return { durationSeconds: route.total_duration, distanceMeters: route.total_distance,
      geometry: normalizeRouteGeometry(route, { from: input.from, to: input.to, distanceMeters: route.total_distance }) };
  }

  /** Directed pairs, billed per pair, not per HTTP request. No route storage.
   * utc is the planned departure (seconds), never implicitly today's traffic.
   */
  async buildRoutePairs(input: {
    pairs: [Coordinates, Coordinates][];
    transport: 'walking' | 'driving' | 'bicycle';
    departureUtc: number;
    requestBudget?: DgisRequestBudget;
  }) {
    if (input.pairs.length < 1 || input.pairs.length > 50 ||
        !['walking', 'driving', 'bicycle'].includes(input.transport) ||
        !Number.isSafeInteger(input.departureUtc) || input.departureUtc < 0) {
      throw new DgisProviderError('Invalid dated routing batch.');
    }
    input.pairs.flat().forEach(validateCoordinates);
    const keys = input.pairs.map(([a, b]) => pairKey(a, b));
    if (new Set(keys).size !== keys.length) throw new DgisProviderError('Duplicate coordinate pair.');
    const url = new URL('https://routing.api.2gis.com/routing/7.0.0/global');
    url.searchParams.set('key', requireKey(this.#routingApiKey, 'DGIS_ROUTING_API_KEY'));
    const body = await this.#request(url, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: input.pairs.map(pair => pair.map(p => ({ lat: p.lat, lon: p.lon, type: 'stop' }))),
        transport: input.transport, output: 'summary', locale: 'ru', route_mode: 'fastest',
        traffic_mode: 'statistics', utc: input.departureUtc, save_route: false }),
    }, 'routing', input.requestBudget);
    const parsed = z.array(z.object({
      lat1: z.number(), lon1: z.number(), lat2: z.number(), lon2: z.number(), status: z.string(),
      duration: z.number().nonnegative().nullable().optional(),
      distance: z.number().nonnegative().nullable().optional(),
    })).safeParse(body);
    if (!parsed.success || parsed.data.length !== keys.length) {
      throw new DgisProviderError('2GIS returned an invalid routing batch.');
    }
    const rows = new Map<string, { durationSeconds: number; distanceMeters: number } | null>();
    for (const row of parsed.data) {
      const key = pairKey({ lat: row.lat1, lon: row.lon1 }, { lat: row.lat2, lon: row.lon2 });
      if (!keys.includes(key) || rows.has(key) || (row.status === 'OK' && (row.duration == null || row.distance == null))) {
        throw new DgisProviderError('2GIS routing coordinates or durations do not match the request.');
      }
      rows.set(key, row.status === 'OK' ? { durationSeconds: row.duration!, distanceMeters: row.distance! } : null);
    }
    // Bind by coordinates, not response order. Failure is an absent edge, never zero minutes.
    return keys.map(key => rows.get(key)!);
  }

  async buildPublicTransportRoute(input: { from: Coordinates; to: Coordinates; departureUtc: number; requestBudget?: DgisRequestBudget }) {
    validateCoordinates(input.from); validateCoordinates(input.to);
    if (!Number.isSafeInteger(input.departureUtc) || input.departureUtc < 0)
      throw new DgisProviderError('Invalid dated public transport segment.');
    const url = new URL('https://routing.api.2gis.com/public_transport/2.0');
    url.searchParams.set('key', requireKey(this.#routingApiKey, 'DGIS_ROUTING_API_KEY'));
    const body = await this.#request(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(publicTransportRequest(input.from, input.to, input.departureUtc)) }, 'public_transport', input.requestBudget, true);
    try { return normalizePublicTransport(body, input); }
    catch { throw new DgisProviderError('2GIS returned an invalid public transport route.'); }
  }

  async #request(url: URL, init: RequestInit, service: 'places' | 'routing' | 'public_transport', requestBudget?: DgisRequestBudget,
    allowNoContent = false): Promise<unknown> {
    const keys = service === 'places' ? this.#placesKeys : this.#routingKeys;
    const send = async (key: string) => {
      const requestUrl = new URL(url);
      requestUrl.searchParams.set('key', key);
      // Outside the fetch catch: a budget/deadline stop is not a provider failure.
      requestBudget?.consume();
      let response: Response;
      try {
        response = await this.#fetch(requestUrl, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
      } catch { throw new DgisProviderError('2GIS request failed or timed out.'); }
      if (allowNoContent && response.status === 204) return { status: 204, body: null };
      let body: unknown;
      try { body = await readBoundedJson(response); }
      catch (error) {
        if (error instanceof DgisProviderError) throw error;
        if (response.ok) throw new DgisProviderError('2GIS returned invalid JSON.');
        body = null;
      }
      return { status: response.status, body };
    };
    let selected = keys.current(service as DgisService);
    if (!selected) throw new DgisProviderError('2GIS service keys are temporarily unavailable.');
    let result: Awaited<ReturnType<typeof send>>;
    for (;;) {
      result = await send(selected);
      if (!shouldTryDgisBackup(result.status, result.body)) break;
      const backup = keys.backupAfterDenial(service, selected);
      if (!backup) break;
      selected = backup;
    }
    if (result.status < 200 || result.status >= 300)
      throw new DgisProviderError(`2GIS returned HTTP ${result.status}.`);
    return result.body;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new SyntaxError('Empty response.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new DgisProviderError('2GIS response exceeds the allowed size.');
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export function pairKey(a: Coordinates, b: Coordinates) {
  return JSON.stringify([a.lat, a.lon, b.lat, b.lon]);
}

function requireKey(value: string, name: string) {
  const key = value.trim();
  if (!key) throw new DgisProviderError(`${name} is not configured.`);
  return key;
}

function validateCoordinates(point: Coordinates) {
  if (
    !Number.isFinite(point.lat) ||
    point.lat < -90 ||
    point.lat > 90 ||
    !Number.isFinite(point.lon) ||
    point.lon < -180 ||
    point.lon > 180
  ) {
    throw new DgisProviderError('2GIS coordinates are outside WGS84 bounds.');
  }
}
