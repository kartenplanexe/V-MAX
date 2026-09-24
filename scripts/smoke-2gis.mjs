import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(repositoryRoot, '.env.local');
const placesEndpoint = 'https://catalog.api.2gis.com/3.0/items';
const routingEndpoint = 'https://routing.api.2gis.com/routing/7.0.0/global';
const timeoutMs = 15_000;

function parseEnv(source) {
  const parsed = {};
  for (const [index, originalLine] of source.split(/\r?\n/u).entries()) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) throw new Error(`Invalid .env.local syntax at line ${index + 1}.`);
    const [, key] = match;
    let value = match[2].trim();
    if (Object.hasOwn(parsed, key)) throw new Error(`Duplicate ${key} entry in .env.local.`);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, '').trim();
    }
    parsed[key] = value;
  }
  return parsed;
}

async function requestJson(url, init, label) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error(`${label}: request failed or timed out; the key was not printed.`);
  }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}; the key was not printed.`);
  try {
    return { body: await response.json(), status: response.status };
  } catch {
    throw new Error(`${label}: provider returned invalid JSON.`);
  }
}

async function smokePlaces(key, testCase) {
  const url = new URL(placesEndpoint);
  url.search = new URLSearchParams({
    fields:
      'items.point,items.rubrics,items.schedule,items.schedule_special,items.reviews,items.attribute_groups,items.flags,items.congestion,items.has_dynamic_congestion,items.dates.updated_at',
    key,
    page_size: '5',
    point: `${testCase.lon},${testCase.lat}`,
    q: testCase.query,
    radius: String(testCase.radius),
  }).toString();
  const startedAt = performance.now();
  const { body, status } = await requestJson(url, { headers: { Accept: 'application/json' } }, `Places ${testCase.id}`);
  if (body?.meta?.code !== 200 || !Array.isArray(body?.result?.items)) {
    throw new Error(`Places ${testCase.id}: unexpected response schema.`);
  }
  const items = body.result.items;
  const hasAveragePrice = (item) =>
    (item?.attribute_groups ?? []).some((group) =>
      (group?.attributes ?? []).some((attribute) => attribute?.tag === 'food_service_avg_price'),
    );
  return {
    case: testCase.id,
    http_status: status,
    item_count: items.length,
    latency_ms: Math.round(performance.now() - startedAt),
    with_point: items.filter((item) => item?.point).length,
    with_schedule: items.filter((item) => item?.schedule).length,
    with_special_schedule: items.filter((item) => item?.schedule_special).length,
    with_average_price: items.filter(hasAveragePrice).length,
    with_congestion: items.filter((item) => item?.congestion != null).length,
    with_dynamic_congestion: items.filter((item) => item?.has_dynamic_congestion === true).length,
  };
}

async function smokeRoute(key, transport) {
  const url = new URL(routingEndpoint);
  url.searchParams.set('key', key);
  const startedAt = performance.now();
  const { body, status } = await requestJson(
    url,
    {
      body: JSON.stringify({
        locale: 'ru',
        output: 'summary',
        points: [
          { lat: 56.326887, lon: 44.005986, type: 'stop' },
          { lat: 56.318121, lon: 43.994139, type: 'stop' },
        ],
        route_mode: 'fastest',
        transport,
      }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      method: 'POST',
    },
    `Routing ${transport}`,
  );
  if (body?.type !== 'result' || body?.status !== 'OK' || !Array.isArray(body?.result)) {
    throw new Error(`Routing ${transport}: provider did not return a route.`);
  }
  return {
    alternatives: body.result.length,
    http_status: status,
    latency_ms: Math.round(performance.now() - startedAt),
    mode: transport,
    provider_status: body.status,
  };
}

async function main() {
  let localEnv;
  try {
    localEnv = parseEnv(await readFile(envPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Missing .env.local. Run: npm run env:init');
    throw error;
  }
  const placesKey = process.env.DGIS_PLACES_API_KEY?.trim() || localEnv.DGIS_PLACES_API_KEY?.trim();
  const routingKey = process.env.DGIS_ROUTING_API_KEY?.trim() || localEnv.DGIS_ROUTING_API_KEY?.trim();
  if (!placesKey) throw new Error('DGIS_PLACES_API_KEY is empty.');
  if (!routingKey) throw new Error('DGIS_ROUTING_API_KEY is empty.');

  const placeCases = [
    { id: 'regional_center', lat: 56.326887, lon: 44.005986, query: 'музей', radius: 15_000 },
    { id: 'medium_city', lat: 55.39485, lon: 43.815687, query: 'кафе', radius: 12_000 },
    { id: 'small_settlement', lat: 55.04136, lon: 43.24611, query: 'досуг', radius: 15_000 },
  ];

  const places = [];
  for (const testCase of placeCases) places.push(await smokePlaces(placesKey, testCase));
  const routing = [];
  for (const transport of ['walking', 'driving']) routing.push(await smokeRoute(routingKey, transport));

  console.log(
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        no_provider_payload_persisted: true,
        places,
        routing,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`2GIS smoke-test failed: ${error.message}`);
  process.exitCode = 1;
});
