import { describe, expect, it, vi } from 'vitest';

import { DgisClient, DgisProviderError, DgisRequestBudgetError } from './dgis.js';

describe('DgisClient', () => {
  it('honors a per-call physical request budget before dispatch including key fallback', async () => {
    let calls = 0, consumed = 0;
    const stop = new DgisRequestBudgetError('HTTP_BUDGET_EXHAUSTED');
    const client = new DgisClient({ placesApiKey: 'primary', routingApiKey: 'test', backupApiKey: 'backup', fetchImpl: async () => {
      calls++; return new Response(null, { status: 403 });
    } });
    await expect(client.searchPlacesByCategories({ center: { lat: 55, lon: 37 }, regionId: '32', rubricIds: ['1'],
      requestBudget: { consume() { if (consumed >= 1) throw stop; consumed++; } },
    })).rejects.toBe(stop);
    expect(calls).toBe(1); expect(consumed).toBe(1);
  });

  it('isolates budgets for concurrent calls sharing a client', async () => {
    let calls = 0;
    const stop = new Error('operation-a-stopped');
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => {
      calls++; return Response.json({ meta: { code: 200 }, result: { total: 1, items: [{ id: '1', name: 'Synthetic' }] } });
    } });
    let consumed = 0;
    const results = await Promise.allSettled([
      client.searchPlaces({ center: { lat: 55, lon: 37 }, query: 'a', requestBudget: { consume() { throw stop; } } }),
      client.searchPlaces({ center: { lat: 55, lon: 37 }, query: 'b', requestBudget: { consume() { consumed++; } } }),
    ]);
    expect(results[0]).toEqual({ status: 'rejected', reason: stop });
    expect(results[1]?.status).toBe('fulfilled'); expect(calls).toBe(1); expect(consumed).toBe(1);
  });

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
    expect(requests[0]?.searchParams.get('sort')).toBe('relevance');
    expect(requests[0]?.searchParams.has('q')).toBe(false);
    await expect(client.searchPlacesByCategories({ center: { lat: 55, lon: 37 },
      regionId: '32', rubricIds: ['bad'] })).rejects.toThrow('category');
    expect(requests).toHaveLength(1);
  });

  it('can request the closest rubric matches without changing the radius or adding Routing', async () => {
    let requested: URL | undefined;
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async url => {
      requested = new URL(String(url));
      return Response.json({ meta: { code: 200 }, result: { items: [], total: 0 } });
    } });
    await client.searchPlacesByCategories({ center: { lat: 55, lon: 37 }, regionId: '32',
      rubricIds: ['161'], radiusMeters: 5000, sort: 'distance' });
    expect(requested?.hostname).toBe('catalog.api.2gis.com');
    expect(requested?.searchParams.get('sort')).toBe('distance');
    expect(requested?.searchParams.get('point')).toBe('37,55');
    expect(requested?.searchParams.get('radius')).toBe('5000');
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

  it('falls back once on an explicit Places quota error without moving Routing', async () => {
    const requests: URL[] = [];
    const client = new DgisClient({ placesApiKey: 'primary-places', routingApiKey: 'primary-routing',
      backupApiKey: 'backup', fetchImpl: async input => {
        const url = new URL(String(input)); requests.push(url);
        if (url.hostname === 'routing.api.2gis.com')
          return Response.json({ result: [], status: 'OK', type: 'result' });
        if (url.searchParams.get('key') === 'primary-places')
          return Response.json({ meta: { code: 403, error: { type: 'quotaExceeded' } } }, { status: 403 });
        return Response.json({ meta: { code: 200 }, result: { items: [{ id: '1', name: 'Парк' }] } });
      } });
    const input = { center: { lat: 55, lon: 37 }, query: 'парк' };
    await expect(client.searchPlaces(input)).resolves.toHaveLength(1);
    await expect(client.searchPlaces(input)).resolves.toHaveLength(1);
    await client.buildRoute({ points: [{ lat: 55, lon: 37 }, { lat: 55.01, lon: 37.01 }], transport: 'walking' });
    expect(requests.map(url => url.searchParams.get('key')))
      .toEqual(['primary-places', 'backup', 'backup', 'primary-routing']);
  });

  it('tries a backup for a denied key but does not loop if both keys are denied', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ meta: { code: 403, error: { type: 'invalidKey' } } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ meta: { code: 429 } }, { status: 429 }));
    const client = new DgisClient({ placesApiKey: 'primary', routingApiKey: 'primary', backupApiKey: 'backup', fetchImpl });
    const input = { center: { lat: 55, lon: 37 }, query: 'парк' };
    await expect(client.searchPlaces(input)).rejects.toThrow('HTTP 429');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses the third key only after explicit denial of both earlier Places keys', async () => {
    const requests: string[] = [];
    const client = new DgisClient({ placesApiKey: 'primary', routingApiKey: 'routing',
      backupApiKey: 'backup', tertiaryApiKey: 'third', fetchImpl: async input => {
        const url = new URL(String(input));
        const key = url.searchParams.get('key') ?? '';
        requests.push(key);
        return key === 'third'
          ? Response.json({ meta: { code: 200 }, result: { items: [{ id: '1', name: 'Парк' }] } })
          : Response.json({ meta: { code: 403 } });
      } });
    const input = { center: { lat: 55, lon: 37 }, query: 'парк' };
    await expect(client.searchPlaces(input)).resolves.toHaveLength(1);
    await expect(client.searchPlaces(input)).resolves.toHaveLength(1);
    expect(requests).toEqual(['primary', 'backup', 'third', 'third']);
  });

  it('keeps valid category results when one provider row has no usable name', async () => {
    const client = new DgisClient({ placesApiKey: 'secret', routingApiKey: 'secret', fetchImpl: async () =>
      Response.json({ meta: { code: 200 }, result: { total: 3, items: [
        { id: '1', name: 'Synthetic cafe', point: { lat: 55, lon: 37 } },
        { id: '2', private_note: 'not for diagnostics' },
        { id: '3', name: '   ' },
      ] } }) });
    const page = await client.searchPlacesByCategories({ center: { lat: 55, lon: 37 }, regionId: '32', rubricIds: ['1'] });
    expect(page).toMatchObject({ total: 3, rawItemCount: 3, rejectedItems: 2,
      schemaFailure: 'SCHEMA_RESULT_ITEMS___NAME', items: [{ id: '1', name: 'Synthetic cafe' }] });
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('not for diagnostics');
  });

  it('distinguishes a provider application code from a response-shape error without exposing payloads', async () => {
    const client = new DgisClient({ placesApiKey: 'secret', routingApiKey: 'secret',
      fetchImpl: vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ meta: { code: 400 }, error: 'sensitive provider detail' }))
        .mockResolvedValueOnce(Response.json({ meta: { code: 200 }, result: { items: [{ id: '1', name: 'Кафе', point: null }] } })),
    });
    const input = { center: { lat: 56.32, lon: 44.0 }, query: 'кафе' };
    await expect(client.searchPlaces(input)).rejects.toThrow('provider code 400');
    await expect(client.searchPlaces(input)).rejects.toThrow('schema failed at result.items.*.point');
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
