import { describe, expect, it } from 'vitest';
import { DgisClient } from './dgis.js';

const a = { lat: 55.75, lon: 37.62 }, b = { lat: 55.751, lon: 37.621 }, c = { lat: 55.752, lon: 37.622 };
const request = { pairs: [[a, b], [b, c]] as [typeof a, typeof a][], transport: 'walking' as const, departureUtc: 1790341200 };
const row = (from = a, to = b) => ({ lat1: from.lat, lon1: from.lon, lat2: to.lat, lon2: to.lon, status: 'OK', duration: 480, distance: 600 });
const client = (fetchImpl: typeof fetch) => new DgisClient({ placesApiKey: 'secret-marker', routingApiKey: 'secret-marker', fetchImpl });

describe('2GIS dated routing pairs wire contract', () => {
  it('binds reordered responses by coordinates and sends UTC/statistics without saving routes', async () => {
    let body: any;
    const instance = client(async (_, init) => { body = JSON.parse(String(init!.body)); return Response.json([row(b, c), row()]); });
    expect(await instance.buildRoutePairs(request)).toEqual([{ durationSeconds: 480, distanceMeters: 600 }, { durationSeconds: 480, distanceMeters: 600 }]);
    expect(body.utc).toBe(request.departureUtc);
    expect(body.traffic_mode).toBe('statistics');
    expect(body.save_route).toBe(false);
    expect(body.points).toEqual([[{ ...a, type: 'stop' }, { ...b, type: 'stop' }], [{ ...b, type: 'stop' }, { ...c, type: 'stop' }]]);
  });

  it('represents an explicitly unavailable route as absent, not zero', async () => {
    const instance = client(async () => Response.json([row(), { ...row(b, c), status: 'ROUTE_NOT_FOUND', duration: null, distance: null }]));
    expect((await instance.buildRoutePairs(request))[1]).toBeNull();
  });

  it.each([
    [row()], [row(), row()], [row(), row(c, a)],
    [row(), { ...row(b, c), duration: null }],
    [row(), { ...row(b, c), duration: -1 }],
    { type: 'result', status: 'OK', result: [row()] },
  ].map(response => [response]))('rejects a mismatched or invalid response', async (response) => {
    // Wrap parameter data: the schema must reject every malformed batch.
    const instance = client(async () => Response.json(response));
    await expect(instance.buildRoutePairs(request)).rejects.toThrow('2GIS');
  });

  it('sanitizes invalid JSON instead of leaking provider text', async () => {
    const instance = client(async () => new Response('secret-marker-not-json', { status: 200 }));
    await expect(instance.buildRoutePairs(request)).rejects.toThrow('2GIS returned invalid JSON.');
  });

  it('rejects oversized or duplicate pairs before HTTP', async () => {
    let called = false;
    const instance = client(async () => { called = true; return Response.json([]); });
    await expect(instance.buildRoutePairs({ ...request, pairs: Array.from({ length: 51 }, () => [a, b]) })).rejects.toThrow();
    await expect(instance.buildRoutePairs({ ...request, pairs: [[a, b], [a, b]] })).rejects.toThrow();
    expect(called).toBe(false);
  });
});
