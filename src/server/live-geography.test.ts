import { expect, it } from 'vitest';
import { boundsFromWkt, LiveGeography, LocalityTokens, visitPolicy } from './live-geography.js';
it('binds locality tokens to signed evidence and expiry', () => {
  let now = 1000; const signer = new LocalityTokens('test-key', () => now);
  const locality = { id: '1', region_id: '32', name: 'Москва', timezone: 'Europe/Moscow',
    center: { lat: 55.75, lon: 37.62 }, area: { south: 55, north: 56, west: 37, east: 38 } };
  const token = signer.sign(locality);
  expect(signer.verify(token)).toEqual(locality);
  expect(() => signer.verify(token.slice(0, -5) + 'xxxxx')).toThrow();
  now += 1_800_001; expect(() => signer.verify(token)).toThrow();
});
it('parses provider bounds, excludes businesses from walks and does not invent durations for unsupported categories', () => {
  expect(boundsFromWkt('POLYGON((37 55,38 55,38 56,37 56,37 55))')).toEqual({ west: 37, east: 38, south: 55, north: 56 });
  expect(() => boundsFromWkt('wrong')).toThrow();
  const policy = visitPolicy([{ id: '10', name: 'Музеи' }, { id: '11', name: 'Кафе' }, { id: '12', name: 'Банки' },
    { id: '168', name: 'Парки' }, { id: '112668', name: 'Природные достопримечательности' },
    { id: '112900', name: 'Памятники и скульптуры' }, { id: '112670', name: 'Интересные здания' },
    { id: '112720', name: 'Фонтаны' }, { id: '112905', name: 'Стрит-арт' },
    { id: '114018', name: 'Туристические маршруты' }]);
  expect(policy.by_category)
    .toEqual({ '10': 90, '11': 60, '168': 60, '112668': 45, '112900': 30,
      '112670': 20, '112720': 15, '112905': 20, '114018': 60 });
  expect(policy.walkable_category_ids).toEqual(['168', '112668', '112900', '112720', '112905', '114018']);
  expect(policy.park_category_ids).toEqual(['168']);
});
it('searches buildings only within the selected city and projects exact address choices', async () => {
  let requested: URL | undefined;
  const mockFetch = async (input: URL | RequestInfo) => {
    requested = new URL(String(input));
    return new Response(JSON.stringify({ meta: { code: 200 }, result: { items: [
      { id: '7001', type: 'building', full_address_name: 'Москва, Тверская улица, 1', point: { lat: 55.757, lon: 37.613 } },
      { id: '7002', type: 'street', name: 'Тверская улица', point: { lat: 55.75, lon: 37.6 } },
      { id: '7003', type: 'building', name: 'Без координат' },
    ] } }), { status: 200 });
  };
  const geography = new LiveGeography('test-key', new LocalityTokens('sign-key'), mockFetch as typeof fetch);
  expect(await geography.searchAddress('Тверская, 1', '32')).toEqual([{ id: '7001',
    label: 'Москва, Тверская улица, 1', point: { lat: 55.757, lon: 37.613 } }]);
  expect(requested?.pathname).toBe('/3.0/items');
  expect(requested?.searchParams.get('city_id')).toBe('32');
  expect(requested?.searchParams.get('type')).toBe('building');
});

it('uses the backup key for a Categories meta 403 without rotating Places', async () => {
  const requests: { path: string; key: string | null }[] = [];
  const mockFetch = async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, key: url.searchParams.get('key') });
    if (url.pathname.includes('/catalog/rubric/') && url.searchParams.get('key') === 'primary')
      return Response.json({ meta: { code: 403 } });
    if (url.pathname.includes('/catalog/rubric/'))
      return Response.json({ meta: { code: 200, issue_date: '20260925', api_version: '2.0.test' },
        result: { total: 1, items: [{ id: '10', name: 'Места', type: 'general_rubric', region_id: '32',
          rubrics: [{ id: '20', name: 'Парки', type: 'rubric', region_id: '32', parent_id: '10' }] }] } });
    return Response.json({ meta: { code: 200 }, result: { items: [] } });
  };
  const tokens = new LocalityTokens('sign-key');
  const token = tokens.sign({ id: '1', name: 'Москва', region_id: '32', timezone: 'Europe/Moscow',
    center: { lat: 55.75, lon: 37.62 }, area: { south: 55, north: 56, west: 37, east: 38 } });
  const geography = new LiveGeography('primary', tokens, mockFetch as typeof fetch, 'backup');
  const context = await geography.context(token);
  expect(context.catalog.rows).toHaveLength(2);
  await geography.searchAddress('Тверская, 1', '32');
  expect(requests.map(request => request.key)).toEqual(['primary', 'backup', 'primary']);
});

it('uses the backup key on an HTTP 429 even when the first response is not JSON', async () => {
  const keys: (string | null)[] = [];
  const geography = new LiveGeography('primary', new LocalityTokens('sign-key'), async input => {
    const key = new URL(String(input)).searchParams.get('key'); keys.push(key);
    return key === 'primary' ? new Response('Too many requests', { status: 429 })
      : Response.json({ meta: { code: 200 }, result: { items: [] } });
  }, 'backup');
  await expect(geography.searchAddress('Тверская, 1', '32')).resolves.toEqual([]);
  expect(keys).toEqual(['primary', 'backup']);
});
