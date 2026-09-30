import { z } from 'zod';
import { EventSearchScopeSchema, EventSearchResultSchema, type EventCard, type EventSearchScope, type EventSearchResult, type EventVenue } from '../shared/event-catalog.js';
import { normalizeKudagoEvent, normalizeKudagoVenue } from './event-normalization.js';

export const KUDAGO_LOCALITIES: Readonly<Record<string, { name: string; timezone: string }>> = Object.freeze({
  nnv: { name: 'Нижний Новгород', timezone: 'Europe/Moscow' }, kzn: { name: 'Казань', timezone: 'Europe/Moscow' },
  msk: { name: 'Москва', timezone: 'Europe/Moscow' }, spb: { name: 'Санкт-Петербург', timezone: 'Europe/Moscow' },
  ekb: { name: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' },
});
export type EventRequestBudget = { consume(): void };
export class EventRequestBudgetError extends Error {
  constructor(readonly code: 'HTTP_BUDGET_EXHAUSTED' | 'DEADLINE_EXCEEDED') { super(code); this.name = 'EventRequestBudgetError'; }
}
type Failure = 'PROVIDER_ERROR' | 'PROVIDER_SCHEMA_ERROR' | 'HTTP_BUDGET_EXHAUSTED' | 'DEADLINE_EXCEEDED';
class EventProviderError extends Error { constructor(readonly code: Failure) { super(code); } }
export type EventRequestOptions = { requestBudget?: EventRequestBudget; shouldContinue?: () => boolean;
  maxRequests?: number; maxPages?: number; pageSize?: number };
type Operation = { attempts: number; consume(): void };
const Page = z.object({ count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  next: z.string().max(4096).nullable(), results: z.array(z.unknown()).max(50) });
const BASE = 'https://kudago.com/public-api/v1.4/';
const EVENT_FIELDS = 'id,title,location,dates,place,categories,age_restriction,price,is_free,site_url';
const VENUE_FIELDS = 'id,title,site_url,coords,is_closed,timetable';
const MAX_BODY_BYTES = 1024 * 1024, TTL_MS = 5 * 60000;

/** No credentials, raw provider logging, redirects, implicit retries or server-side image fetches. */
export class KudagoClient {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  constructor(options: { fetcher?: typeof fetch; now?: () => number } = {}) {
    this.#fetch = options.fetcher ?? fetch; this.#now = options.now ?? Date.now;
  }
  #operation(options: EventRequestOptions): Operation {
    const started = performance.now(), maxRequests = options.maxRequests ?? 4;
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 30) throw new Error('Invalid event request policy.');
    const operation: Operation = { attempts: 0, consume() {
      if (performance.now() - started >= 90000 || options.shouldContinue?.() === false) throw new EventRequestBudgetError('DEADLINE_EXCEEDED');
      if (operation.attempts >= maxRequests) throw new EventRequestBudgetError('HTTP_BUDGET_EXHAUSTED');
      options.requestBudget?.consume();
      operation.attempts++;
    } };
    return operation;
  }
  async #request(url: URL, operation: Operation): Promise<unknown> {
    // External ledgers are per operation. If consume denies, no physical request is dispatched.
    operation.consume();
    let response: Response;
    try { response = await this.#fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { accept: 'application/json' } }); } catch { throw new EventProviderError('PROVIDER_ERROR'); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new EventProviderError('PROVIDER_ERROR'); }
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > MAX_BODY_BYTES) {
      await response.body?.cancel().catch(() => undefined); throw new EventProviderError('PROVIDER_SCHEMA_ERROR');
    }
    if (!response.body) throw new EventProviderError('PROVIDER_SCHEMA_ERROR');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new EventProviderError('PROVIDER_SCHEMA_ERROR'); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof EventProviderError) throw error;
      throw new EventProviderError('PROVIDER_SCHEMA_ERROR');
    } finally { reader.releaseLock(); }
  }
  #failure(error: unknown): Failure {
    if (error instanceof EventProviderError || error instanceof EventRequestBudgetError) return error.code;
    // A shared retrieval ledger may use another provider's typed budget error.
    if (error && typeof error === 'object' && 'code' in error &&
      (error.code === 'HTTP_BUDGET_EXHAUSTED' || error.code === 'DEADLINE_EXCEEDED')) return error.code;
    throw error;
  }
  #context() {
    const now = this.#now();
    return { fetchedAt: new Date(now).toISOString(), validUntil: new Date(now + TTL_MS).toISOString(), dataMode: 'live' as const };
  }

  async search(rawScope: EventSearchScope, options: EventRequestOptions = {}): Promise<EventSearchResult> {
    const scope = EventSearchScopeSchema.parse(rawScope), operation = this.#operation(options);
    const result: EventSearchResult = { items: [], coverage: 'PARTIAL', stop_reason: 'PAGE_LIMIT', attempts: 0, pages: 0,
      rejected: 0, outside_scope: 0, scope };
    if (!Object.hasOwn(KUDAGO_LOCALITIES, scope.location)) return { ...result, coverage: 'UNSUPPORTED_LOCALITY', stop_reason: 'UNSUPPORTED_LOCALITY' };
    const maxPages = options.maxPages ?? 4, pageSize = options.pageSize ?? 50;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 8 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new Error('Invalid event paging policy.');
    }
    const seen = new Set<number>(); let originalCount: number | null = null;
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL('events/', BASE);
      for (const [key, value] of Object.entries({ location: scope.location, fields: EVENT_FIELDS, expand: 'dates,place',
        actual_since: String(scope.starts_at), actual_until: String(scope.ends_at), page_size: String(pageSize), page: String(page) })) url.searchParams.set(key, value);
      if (scope.categories?.length) url.searchParams.set('categories', scope.categories.join(','));
      let raw: unknown;
      try { raw = await this.#request(url, operation); } catch (error) { result.stop_reason = this.#failure(error); break; }
      const parsed = Page.safeParse(raw);
      if (!parsed.success || parsed.data.results.length > pageSize) { result.stop_reason = 'PROVIDER_SCHEMA_ERROR'; break; }
      const data = parsed.data, before = seen.size;
      result.pages++;
      for (const item of data.results) {
        const identity = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).safeParse(item);
        if (!identity.success) { result.rejected++; continue; }
        if (seen.has(identity.data.id)) continue;
        seen.add(identity.data.id);
        try {
          const card = normalizeKudagoEvent(item, this.#context());
          // Drop only events known to fall outside the window; retain unknown-date gaps.
          const entries = card.schedule.entries;
          if (entries.length && entries.every(entry => entry.end_utc !== null && entry.end_utc <= scope.starts_at ||
              entry.start_utc !== null && entry.start_utc >= scope.ends_at)) { result.outside_scope++; continue; }
          result.items.push(card);
        } catch (error) {
          if (!(error instanceof z.ZodError)) throw error;
          result.rejected++;
        }
      }
      if (seen.size > data.count || originalCount !== null && data.count !== originalCount || data.next === null && seen.size !== data.count ||
          data.next !== null && seen.size >= data.count) { result.stop_reason = 'RESULT_COUNT_INCONSISTENT'; break; }
      originalCount ??= data.count;
      if (data.next === null) {
        result.coverage = result.rejected ? 'PARTIAL' : 'BOUNDED_RESULTS';
        result.stop_reason = result.rejected ? 'PROVIDER_SCHEMA_ERROR' : 'RESULTS_EXHAUSTED'; break;
      }
      if (page > 1 && seen.size === before) { result.stop_reason = 'REPEATED_PAGE'; break; }
      if (!data.results.length) { result.stop_reason = 'RESULT_COUNT_INCONSISTENT'; break; }
    }
    result.attempts = operation.attempts;
    return EventSearchResultSchema.parse(result);
  }

  async getEvent(id: string, options: EventRequestOptions = {}): Promise<{
    status: 'OK' | 'UNAVAILABLE'; event: EventCard | null; attempts: number; reason: Failure | null;
  }> {
    z.string().regex(/^[1-9]\d{0,15}$/u).refine(value => Number.isSafeInteger(Number(value))).parse(id);
    const operation = this.#operation(options), url = new URL(`events/${id}/`, BASE);
    url.searchParams.set('fields', EVENT_FIELDS); url.searchParams.set('expand', 'dates,place');
    let raw: unknown;
    try { raw = await this.#request(url, operation); } catch (error) {
      return { status: 'UNAVAILABLE', event: null, attempts: operation.attempts, reason: this.#failure(error) };
    }
    try {
      const event = normalizeKudagoEvent(raw, this.#context());
      if (String(event.provider_event_id) !== id) return { status: 'UNAVAILABLE', event: null, attempts: operation.attempts, reason: 'PROVIDER_SCHEMA_ERROR' };
      return { status: 'OK', event, attempts: operation.attempts, reason: null };
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      return { status: 'UNAVAILABLE', event: null, attempts: operation.attempts, reason: 'PROVIDER_SCHEMA_ERROR' };
    }
  }
  async getVenue(id: number, options: EventRequestOptions = {}): Promise<{
    status: 'OK' | 'UNAVAILABLE'; venue: EventVenue | null; attempts: number; reason: Failure | null;
  }> {
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(id);
    const operation = this.#operation(options), url = new URL(`places/${id}/`, BASE); url.searchParams.set('fields', VENUE_FIELDS);
    let raw: unknown;
    try { raw = await this.#request(url, operation); } catch (error) {
      return { status: 'UNAVAILABLE', venue: null, attempts: operation.attempts, reason: this.#failure(error) };
    }
    try {
      const venue = normalizeKudagoVenue(raw, this.#context());
      if (venue.provider_venue_id !== id) return { status: 'UNAVAILABLE', venue: null, attempts: operation.attempts, reason: 'PROVIDER_SCHEMA_ERROR' };
      return { status: 'OK', venue, attempts: operation.attempts, reason: null };
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      return { status: 'UNAVAILABLE', venue: null, attempts: operation.attempts, reason: 'PROVIDER_SCHEMA_ERROR' };
    }
  }
}
