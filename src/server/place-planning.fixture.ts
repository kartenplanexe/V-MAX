/** Synthetic HTTP fixture used by offline tests/demo only. No real 2GIS payload. */
import { DgisClient } from './dgis.js';

export const demoNow = () => new Date('2026-09-24T09:30:00Z');
export function planningFixture() {
  const activity = (id: string, category: string) => ({ id, label: id,
    selection: { category_policy: 'related_allowed', named_types: [] }, requirements: [],
    categories: { state: 'matched', include_any: [category], exclude: [], region_id: '32', catalog_version: 'synthetic.v1' } });
  const input = { schema_version: 'place-selection.v1',
    intent: { schema_version: 'confirmed-daily-intent.research.v1', session_id: 'synthetic', draft_revision: 1,
      locality: { id: 'mow', region_id: '32', name: 'Учебный город', timezone: 'Europe/Moscow' },
      shared: { mobility: ['walking'] }, points: { origin: { lat: 55.75, lon: 37.62, locality_id: 'mow' } },
      days: [{ day_id: 'd1', date: '2026-09-25', window: { start: '16:00', end: '19:00' },
        activities: [activity('culture', '100'), activity('food', '200')], order: [['culture', 'food']] }] },
    catalog: { version: 'synthetic.v1', region_id: '32', leaf_ids: ['100', '200'] },
    visit_policy: { version: 'synthetic-durations.v1', by_category: { '100': 60, '200': 45 }, arrival_buffer_minutes: 5 },
  };
  const items = [
    { id: 'near', name: 'Учебный музей', rubrics: [{ id: '100' }], point: { lat: 55.751, lon: 37.621 } },
    { id: 'far', name: 'Учебный музей далеко', rubrics: [{ id: '100' }], point: { lat: 55.76, lon: 37.65 } },
    { id: 'cafe', name: 'Учебное кафе', rubrics: [{ id: '200' }], point: { lat: 55.752, lon: 37.622 } },
    { id: 'closed', name: 'Закрыто', rubrics: [{ id: '100' }], point: { lat: 55.753, lon: 37.623 } },
  ].map(item => ({ ...item, region_id: '32', schedule: { Fri: { working_hours: item.id === 'closed' ? [] : [{ from: '10:00', to: '22:00' }] } } }));
  const requests: { url: URL; body: Record<string, unknown> | null }[] = [];
  let routingBatches = 0;
  const defaultFetch: typeof fetch = async (url, init) => {
    const target = new URL(String(url)), body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url: target, body });
    if (target.hostname === 'catalog.api.2gis.com') {
      const rubric = target.searchParams.get('rubric_id');
      const selected = items.filter(item => item.rubrics.some(r => r.id === rubric));
      return Response.json({ meta: { code: 200 }, result: { items: selected, total: selected.length } });
    }
    routingBatches++;
    const pairs = body.points as [{ lat: number; lon: number }, { lat: number; lon: number }][];
    return Response.json(pairs.map(([a, b]) => ({ lat1: a.lat, lon1: a.lon, lat2: b.lat, lon2: b.lon,
      status: 'OK', duration: a.lon === 37.65 || b.lon === 37.65 ? 2400 : 480,
      distance: a.lon === 37.65 || b.lon === 37.65 ? 2500 : 600 })));
  };
  const client = (fetchImpl: typeof fetch = defaultFetch) => new DgisClient({ placesApiKey: 'test-only', routingApiKey: 'test-only', fetchImpl });
  return { input, items, requests, defaultFetch, client, routingBatches: () => routingBatches };
}
