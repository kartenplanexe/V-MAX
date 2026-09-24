import { describe, expect, it, vi } from 'vitest';

import { DgisClient, DgisProviderError } from './dgis.js';

describe('DgisClient', () => {
  it('searches the supplied regional rubric IDs without a text reinterpretation', async () => {
    const requests: URL[] = [];
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test',
      fetchImpl: async (url) => {
        requests.push(new URL(String(url)));
        return Response.json({ meta: { code: 200 }, result: { items: [{ id: '1', name: 'Кафе' }], total: 7 } });
      },
    });
    const page = await client.searchPlacesByCategories({ center: { lat: 55, lon: 37 },
      regionId: '32', rubricIds: ['161', '162'], page: 2, pageSize: 5 });
    expect(page).toMatchObject({ total: 7, items: [{ id: '1', name: 'Кафе' }] });
    expect(requests[0]?.searchParams.get('rubric_id')).toBe('161,162');
    expect(requests[0]?.searchParams.get('region_id')).toBe('32');
    expect(requests[0]?.searchParams.get('page')).toBe('2');
    expect(requests[0]?.searchParams.has('q')).toBe(false);
    await expect(client.searchPlacesByCategories({ center: { lat: 55, lon: 37 },
      regionId: '32', rubricIds: ['bad'] })).rejects.toThrow('category');
    expect(requests).toHaveLength(1);
  });

  it('sends a bounded Places request and returns normalized items', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        meta: { code: 200 },
        result: {
          items: [{ id: 'place-1', name: 'Музей', point: { lat: 56.32, lon: 44.0 } }],
          total: 1,
        },
      }),
    );
    const client = new DgisClient({
      fetchImpl,
      placesApiKey: 'places-test-key',
      routingApiKey: 'routing-test-key',
    });

    const items = await client.searchPlaces({
      center: { lat: 56.32, lon: 44.0 },
      pageSize: 5,
      query: ' музей ',
      radiusMeters: 5_000,
    });

    expect(items).toHaveLength(1);
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain('q=%D0%BC%D1%83%D0%B7%D0%B5%D0%B9');
    expect(String(url)).toContain('page_size=5');
    expect(String(url)).toContain('radius=5000');
  });

  it('sends only the Routing key to the routing endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ result: [{ id: 'route-1' }], status: 'OK', type: 'result' }),
    );
    const client = new DgisClient({
      fetchImpl,
      placesApiKey: 'places-test-key',
      routingApiKey: 'routing-test-key',
    });

    await client.buildRoute({
      points: [
        { lat: 56.326887, lon: 44.005986 },
        { lat: 56.318121, lon: 43.994139 },
      ],
      transport: 'walking',
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain('key=routing-test-key');
    expect(String(url)).not.toContain('places-test-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      output: 'summary',
      route_mode: 'fastest',
      transport: 'walking',
    });
  });

  it('does not include a secret-bearing URL in provider errors', async () => {
    const client = new DgisClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 })),
      placesApiKey: 'do-not-leak-places',
      routingApiKey: 'do-not-leak-routing',
    });

    const request = client.searchPlaces({
      center: { lat: 56.32, lon: 44.0 },
      query: 'музей',
    });

    await expect(request).rejects.toThrow(DgisProviderError);
    await expect(request).rejects.not.toThrow(/do-not-leak/u);
  });

  it('validates provider limits before making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new DgisClient({
      fetchImpl,
      placesApiKey: 'places-test-key',
      routingApiKey: 'routing-test-key',
    });

    await expect(
      client.searchPlaces({
        center: { lat: 56.32, lon: 44.0 },
        pageSize: 51,
        query: 'музей',
      }),
    ).rejects.toThrow('page size');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
