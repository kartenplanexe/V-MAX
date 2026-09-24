import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { collectCatalog } from './intent/category-catalog.mjs';
import { InitialIntentError, type InitialContext, type CatalogRow } from './intent-start.js';
import type { PlanningContext } from './planning-sessions.js';

const Point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const Locality = z.object({ id: z.string().min(1), region_id: z.string().regex(/^\d+$/u), name: z.string().min(1), timezone: z.string(),
  center: Point, area: z.object({ south: z.number(), north: z.number(), west: z.number(), east: z.number() }) });
export type VerifiedLocality = z.infer<typeof Locality>;
export class LocalityTokens {
  constructor(private key: string, private now = Date.now) {}
  private mac(payload: string) { return createHmac('sha256', this.key).update('locality.v1:' + payload).digest(); }
  sign(locality: VerifiedLocality) {
    const body = Buffer.from(JSON.stringify({ locality: Locality.parse(locality), expires: this.now() + 1_800_000 })).toString('base64url');
    return body + '.' + this.mac(body).toString('base64url');
  }
  verify(token: string): VerifiedLocality {
    try {
      const [body, signature, extra] = token.split('.');
      if (!body || !signature || extra || token.length > 16000) throw new Error();
      const actual = Buffer.from(signature, 'base64url'), expected = this.mac(body);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!Number.isFinite(data.expires) || this.now() >= data.expires) throw new Error();
      return Locality.parse(data.locality);
    } catch { throw new InitialIntentError('LOCALITY_SELECTION_EXPIRED'); }
  }
}
export function boundsFromWkt(wkt: string) {
  if (!/^POLYGON\(\(/u.test(wkt)) throw new InitialIntentError('LOCALITY_UNAVAILABLE', 503);
  const pairs = [...wkt.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/gu)].map(m => ({ lon: Number(m[1]), lat: Number(m[2]) }));
  if (pairs.length < 4 || pairs.some(p => !Point.safeParse(p).success)) throw new InitialIntentError('LOCALITY_UNAVAILABLE', 503);
  return { south: Math.min(...pairs.map(p => p.lat)), north: Math.max(...pairs.map(p => p.lat)),
    west: Math.min(...pairs.map(p => p.lon)), east: Math.max(...pairs.map(p => p.lon)) };
}

// Versioned visit-duration estimates, not provider facts. Full catalog still goes to Alice.
// Unmapped categories are not assigned an invented default duration by the planner.
const visitMinutes: Record<string, number> = {
  'музеи': 90, 'художественные галереи': 60, 'выставочные центры': 90, 'выставки': 90,
  'кафе': 60, 'кофейни': 45, 'рестораны': 90, 'столовые': 45, 'быстрое питание': 30,
  'бары': 90, 'пабы': 90, 'парки культуры и отдыха': 60, 'скверы': 45, 'набережные': 60,
  'достопримечательности': 45, 'ботанические сады': 90, 'зоопарки': 120,
};
export function visitPolicy(items: { id: string; name: string }[]): PlanningContext['visit_policy'] {
  const by_category: Record<string, number> = {};
  for (const item of items) { const duration = visitMinutes[item.name.trim().toLocaleLowerCase('ru-RU')]; if (duration) by_category[item.id] = duration; }
  return { version: 'visit-duration-estimates.v1', by_category, arrival_buffer_minutes: 5 };
}

export class LiveGeography {
  constructor(readonly key: string, readonly tokens: LocalityTokens, readonly fetchImpl: typeof fetch = fetch) {}
  private async json(path: string, params: Record<string, string>) {
    const url = new URL(path, 'https://catalog.api.2gis.com');
    url.search = new URLSearchParams({ ...params, key: this.key, locale: 'ru_RU' }).toString();
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(12000), redirect: 'error' });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(part.value); }
      } finally { reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.meta?.code !== 200) throw new Error();
      return body;
    } catch { throw new InitialIntentError('GEOGRAPHY_UNAVAILABLE', 503); }
  }
  async search(query: string) {
    const q = z.string().trim().min(2).max(100).parse(query);
    const found = await this.json('/3.0/items', { q, type: 'adm_div.city,adm_div.settlement',
      fields: 'items.point,items.region_id,items.adm_div', page_size: '5' });
    const choices: (VerifiedLocality & { token: string })[] = [];
    const regions = new Map<string, unknown>(); // Request-scoped only; never a reusable provider cache.
    for (const item of found.result?.items ?? []) {
      if (item.type !== 'adm_div' || !['city', 'settlement'].includes(item.subtype) || !/^\d+$/u.test(item.region_id ?? '') || !Point.safeParse(item.point).success) continue;
      if (!regions.has(item.region_id)) {
        const region = await this.json('/2.0/region/get', { id: item.region_id, fields: 'items.time_zone,items.bounds,items.country_code' });
        regions.set(item.region_id, region.result?.items?.[0]);
      }
      const region = regions.get(item.region_id) as { country_code?: string; bounds?: string; time_zone?: string | { name?: string } } | undefined;
      if (region?.country_code !== 'ru' || typeof region.bounds !== 'string') continue;
      const timezone = typeof region.time_zone === 'string' ? region.time_zone : region.time_zone?.name;
      if (!timezone) continue;
      try { new Intl.DateTimeFormat('ru', { timeZone: timezone }); } catch { continue; }
      const locality = Locality.parse({ id: item.id, name: item.name, region_id: item.region_id, timezone,
        center: item.point, area: boundsFromWkt(region.bounds) });
      choices.push({ ...locality, token: this.tokens.sign(locality) });
    }
    return choices;
  }
  async context(token: string): Promise<InitialContext & { planning: PlanningContext }> {
    const location = this.tokens.verify(token), deadline = Date.now() + 60_000;
    const result = await collectCatalog({ regionId: location.region_id, maxCalls: 40,
      fetchPage: async ({ regionId, parentId, page, pageSize }: { regionId: string; parentId: string; page: number; pageSize: number }) => {
        if (Date.now() >= deadline) throw new Error('Catalog deadline');
        return { http_status: 200, body: await this.json('/2.0/catalog/rubric/list', {
          region_id: regionId, parent_id: parentId, page: String(page), page_size: String(pageSize), sort: 'name',
          fields: 'items.region_id,items.rubrics,items.rubrics.region_id' }) };
      } });
    if (!result.catalog || !result.summary.complete) throw new InitialIntentError('CATALOG_UNAVAILABLE', 503);
    const { items, ...metadata } = result.catalog;
    const rows: CatalogRow[] = items.map((item: { id: string; name: string; parent_ids: string[]; declared_parent_ids: string[]; type: string; caption: string | null }) => {
      const extra: Record<string, unknown> = {};
      if (item.type !== 'rubric') extra.type = item.type;
      if (item.caption !== item.name) extra.caption = item.caption;
      if (JSON.stringify(item.parent_ids) !== JSON.stringify(item.declared_parent_ids)) extra.declared_parent_ids = item.declared_parent_ids;
      return [item.id, item.name, item.parent_ids, ...(Object.keys(extra).length ? [extra] : [])] as CatalogRow;
    });
    const catalog = { ...metadata, format: '2gis-category-catalog.defaults.v2',
      defaults: { type: 'rubric', caption: '$name', declared_parent_ids: '$parent_ids' }, columns: ['id', 'name', 'parent_ids', 'optional_overrides'], rows };
    return { now: new Date().toISOString(), locality: { id: location.id, name: location.name, region_id: location.region_id, timezone: location.timezone }, catalog,
      planning: { catalog: { version: catalog.version, region_id: catalog.region_id, leaf_ids: rows.filter(r => (r[3]?.type ?? 'rubric') === 'rubric').map(r => r[0]) },
        visit_policy: visitPolicy(items), point_area: location.area, map_center: location.center, modes: ['walking', 'driving', 'cycling'], data_mode: 'live' } };
  }
}
