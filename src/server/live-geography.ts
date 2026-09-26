import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { collectEmbeddedCatalog } from './intent/category-catalog.mjs';
import { DgisKeyFallback, shouldTryDgisBackup, type DgisService } from './dgis-key-fallback.js';
import { InitialIntentError, type InitialContext, type CatalogRow } from './intent-start.js';
import type { PlanningContext } from './planning-sessions.js';

const Point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const Locality = z.object({ id: z.string().min(1), region_id: z.string().regex(/^\d+$/u), name: z.string().min(1), timezone: z.string(),
  center: Point, area: z.object({ south: z.number(), north: z.number(), west: z.number(), east: z.number() }) });
export type VerifiedLocality = z.infer<typeof Locality>;
export type AddressChoice = { id: string; label: string; point: { lat: number; lon: number } };
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
  'бары': 90, 'пабы': 90, 'парки культуры и отдыха': 60, 'парки': 60, 'скверы': 45, 'набережные': 60,
  'достопримечательности': 45, 'природные достопримечательности': 45, 'памятники и скульптуры': 30,
  // Walkable POI categories from the 2GIS "Места" catalog. These are product
  // visit-time estimates, never claims about a place's official opening hours.
  'интересные здания': 20, 'фонтаны': 15, 'памятные доски': 15, 'стрит-арт': 20,
  'водопады': 30, 'руины': 30, 'усадьбы': 45, 'сады / цветники': 45,
  'мост': 20, 'родники': 20, 'вершины гор': 45, 'выставочные экспонаты': 30,
  'религиозные объекты': 30, 'точки интереса': 20, 'авиапамятники': 20,
  'скалы': 30, 'туристические маршруты': 60,
  'смотровые площадки': 30, 'заповедники': 90, 'пляжи': 60,
  'ботанические сады': 90, 'ботанический сад': 90, 'зоопарки': 120, 'зоопарк': 120,
};
// Positive eligibility for a general outdoor walk. An LLM category proposal can
// broaden retrieval, but cannot turn a hotel, restaurant or shop into a walk stop.
const walkableNames = new Set([
  'парки', 'парки культуры и отдыха', 'скверы', 'набережные', 'смотровые площадки',
  'заповедники', 'природные достопримечательности', 'памятники и скульптуры',
  'памятные доски', 'стрит-арт', 'фонтаны', 'водопады', 'руины',
  'сады / цветники', 'мост', 'родники', 'вершины гор', 'точки интереса',
  'авиапамятники', 'скалы', 'туристические маршруты', 'ботанический сад', 'пляжи',
]);
export function visitPolicy(items: { id: string; name: string }[]): PlanningContext['visit_policy'] {
  const by_category: Record<string, number> = {};
  const walkable_category_ids: string[] = [];
  const park_category_ids: string[] = [];
  for (const item of items) {
    const name = item.name.trim().toLocaleLowerCase('ru-RU');
    const duration = visitMinutes[name]; if (duration) by_category[item.id] = duration;
    if (walkableNames.has(name)) walkable_category_ids.push(item.id);
    if (name === 'парки' || name === 'парки культуры и отдыха') park_category_ids.push(item.id);
  }
  return { version: 'visit-duration-estimates.v3', by_category, walkable_category_ids, park_category_ids,
    arrival_buffer_minutes: 5 };
}

export class LiveGeography {
  private readonly keys: DgisKeyFallback;
  constructor(readonly key: string, readonly tokens: LocalityTokens, readonly fetchImpl: typeof fetch = fetch,
    backupKey = '') { this.keys = new DgisKeyFallback(key, backupKey); }
  private async json(path: string, params: Record<string, string>) {
    const service: DgisService = path.includes('/catalog/rubric/') ? 'categories'
      : path.includes('/region/') ? 'regions' : 'places';
    const request = async (key: string) => {
      const keyRole = key === this.key ? 'primary' : 'backup';
      const url = new URL(path, 'https://catalog.api.2gis.com');
      url.search = new URLSearchParams({ ...params, key, locale: 'ru_RU' }).toString();
      let response: Response;
      try { response = await this.fetchImpl(url, { signal: AbortSignal.timeout(12000), redirect: 'error' }); }
      catch (error) {
        if (service === 'categories') console.info(JSON.stringify({ msg: '2GIS catalog request outcome', key_role: keyRole,
          transport_error: error instanceof Error && ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)
            ? error.name : 'OTHER' }));
        throw error;
      }
      if (!response.body) throw new Error();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(part.value); }
      } finally { reader.releaseLock(); }
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { if (response.ok) throw new Error(); body = null; }
      if (service === 'categories') console.info(JSON.stringify({ msg: '2GIS catalog request outcome', key_role: keyRole,
        http_status: response.status, provider_code: Number.isSafeInteger(body?.meta?.code) ? body.meta.code : null,
        fallback_eligible: shouldTryDgisBackup(response.status, body) }));
      return { status: response.status, body };
    };
    try {
      const selected = this.keys.current(service);
      let result = await request(selected);
      if (shouldTryDgisBackup(result.status, result.body)) {
        const backup = this.keys.backupAfterDenial(service, selected);
        if (backup) result = await request(backup);
      }
      if (result.status !== 200 || !result.body || typeof result.body !== 'object' ||
          !('meta' in result.body) || (result.body as { meta?: { code?: number } }).meta?.code !== 200) throw new Error();
      return result.body;
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
  async searchAddress(query: string, cityId: string): Promise<AddressChoice[]> {
    const q = z.string().trim().min(4).max(120).parse(query);
    const city_id = z.string().regex(/^\d+$/u).parse(cityId);
    const found = await this.json('/3.0/items', { q, city_id, type: 'building',
      fields: 'items.point,items.full_address_name', page_size: '5' });
    const choices: AddressChoice[] = [];
    for (const item of found.result?.items ?? []) {
      if (item.type !== 'building' || typeof item.id !== 'string' || !/^\d+$/u.test(item.id) ||
          !Point.safeParse(item.point).success) continue;
      const label = typeof item.full_address_name === 'string' ? item.full_address_name
        : typeof item.address_name === 'string' ? item.address_name : item.name;
      if (typeof label !== 'string' || !label.trim()) continue;
      choices.push({ id: item.id, label: label.trim().slice(0, 160), point: Point.parse(item.point) });
    }
    return choices;
  }
  async context(token: string): Promise<InitialContext & { planning: PlanningContext }> {
    const location = this.tokens.verify(token);
    const result = await collectEmbeddedCatalog({ regionId: location.region_id,
      fetchRoot: async ({ regionId }: { regionId: string }) => ({ http_status: 200,
        body: await this.json('/2.0/catalog/rubric/list', {
          region_id: regionId, parent_id: '0', page: '1', page_size: '10000', sort: 'name',
          fields: 'items.region_id,items.rubrics,items.rubrics.region_id' }) }) });
    if (!result.catalog || !result.summary.complete) {
      const errorCode = 'error_code' in result.summary && typeof result.summary.error_code === 'string'
        ? result.summary.error_code : 'UNKNOWN';
      console.info(JSON.stringify({ msg: '2GIS catalog validation outcome', error_code: errorCode }));
      throw new InitialIntentError('CATALOG_UNAVAILABLE', 503);
    }
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
