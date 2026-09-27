// A bounded live check of one owner-provided key. No provider payload or key is printed or stored.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DgisClient } from '../dist/server/server/dgis.js';

if (process.argv.slice(2).join(' ') !== '--live') {
  console.error('Использование: node --use-system-ca scripts/probe-2gis-tertiary-key.mjs --live');
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = parseEnv(readFileSync(join(root, '.env.local'), 'utf8'));
const key = env.DGIS_TERTIARY_API_KEY?.trim() ?? '';
if (!/^[A-Za-z0-9:-]{20,120}$/u.test(key) ||
    [env.DGIS_PLACES_API_KEY, env.DGIS_ROUTING_API_KEY, env.DGIS_BACKUP_API_KEY].some(value => value?.trim() === key)) {
  console.error('Третий ключ отсутствует, имеет неожиданный формат или повторяет существующий.');
  process.exit(1);
}

const results = [];
try {
  const url = new URL('https://catalog.api.2gis.com/2.0/catalog/rubric/list');
  url.search = new URLSearchParams({ key, region_id: '32', parent_id: '0', page: '1', page_size: '10000',
    sort: 'name', fields: 'items.region_id,items.rubrics,items.rubrics.region_id' }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  const body = await response.json();
  results.push({ service: 'categories', http_status: response.status,
    provider_code: Number.isSafeInteger(body?.meta?.code) ? body.meta.code : null,
    ok: response.status === 200 && body?.meta?.code === 200 && Array.isArray(body?.result?.items) });
} catch (error) {
  results.push({ service: 'categories', ok: false, error_code: error?.cause?.code ?? error?.name ?? 'UNKNOWN' });
}

const client = new DgisClient({ placesApiKey: key, routingApiKey: key, timeoutMs: 25_000 });
try {
  const places = await client.searchPlaces({ center: { lat: 56.326887, lon: 44.005986 }, query: 'музей', pageSize: 5 });
  results.push({ service: 'places', ok: Array.isArray(places) });
} catch {
  results.push({ service: 'places', ok: false });
}
try {
  await client.buildRoute({ points: [{ lat: 56.326887, lon: 44.005986 },
    { lat: 56.318121, lon: 43.994139 }], transport: 'walking' });
  results.push({ service: 'routing', ok: true });
} catch {
  results.push({ service: 'routing', ok: false });
}
console.log(JSON.stringify({ ok: results.every(result => result.ok), maximum_api_calls: 3,
  key_echoed: false, provider_payload_persisted: false, results }, null, 2));
if (results.some(result => !result.ok)) process.exitCode = 1;
