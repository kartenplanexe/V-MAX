import { expect, it } from 'vitest';
import { DgisClient, DgisRequestBudgetError } from './dgis.js';

const from = { lat: 55.75, lon: 37.62 }, to = { lat: 55.752, lon: 37.622 };
const row = (extra = {}) => ({ id: 'synthetic-1', total_duration: 900, total_distance: 260,
  pedestrian: false, crossing_count: 1, transfer_count: 0, total_walkway_distance: 'не парсить',
  movements: [{ type: 'passage', moving_duration: 600, waiting_duration: 300, distance: 260,
    alternatives: [{ geometry: [{ selection: 'LINESTRING(37.62 55.75,37.622 55.752)' }] }],
    routes: [{ names: ['Учебный 1'], subtype: 'bus' }], waypoint: { name: 'Учебная остановка' } }],
  schedules: [{ type: 'precise', origin_from: 'eta', start_time_utc: 1790000000 }], ...extra });

it('sends exact dated PT request and counts waiting once, preserving transit and geometry facts', async () => {
  let request!: Record<string, unknown>, endpoint = '', attempts = 0;
  const client = new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', fetchImpl: async (url, init) => {
    endpoint = new URL(String(url)).pathname; request = JSON.parse(String(init?.body)); return Response.json([row()]);
  } });
  const result = await client.buildPublicTransportRoute({ from, to, departureUtc: 1790000000,
    requestBudget: { consume: () => { attempts++; } } });
  expect(endpoint).toBe('/public_transport/2.0');
  expect(request).toMatchObject({ source: { point: from }, target: { point: to }, start_time: 1790000000, enable_schedule: true, locale: 'ru' });
  expect(result).toMatchObject({ durationSeconds: 900, distanceMeters: 260,
    transit: { pedestrian: false, waitingSeconds: 300, transferCount: 0, crossingCount: 1, scheduleEvidence: 'predicted' } });
  expect(result?.geometry).toEqual([[[37.62, 55.75], [37.622, 55.752]]]); expect(attempts).toBe(1);
});

it('returns an absent edge on documented 204 and preserves all-walking classification', async () => {
  const unavailable = new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', fetchImpl: async () => new Response(null, { status: 204 }) });
  expect(await unavailable.buildPublicTransportRoute({ from, to, departureUtc: 1790000000 })).toBeNull();
  const walking = new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', fetchImpl: async () => Response.json([
    row({ pedestrian: true, movements: [{ type: 'walkway', moving_duration: 900, waiting_duration: 0 }], schedules: [] })]) });
  expect(await walking.buildPublicTransportRoute({ from, to, departureUtc: 1790000000 })).toMatchObject({
    durationSeconds: 900, transit: { pedestrian: true, waitingSeconds: 0 }, geometry: null });
});

it('charges every denied-key fallback attempt and keeps PT denial separate from walking routing', async () => {
  const calls: { path: string; role: string }[] = []; let used = 0;
  const client = new DgisClient({ placesApiKey: 'primary-synthetic', routingApiKey: 'primary-synthetic', backupApiKey: 'backup-synthetic',
    fetchImpl: async url => { const parsed = new URL(String(url)), role = parsed.searchParams.get('key')!; calls.push({ path: parsed.pathname, role });
      if (parsed.pathname === '/public_transport/2.0') return role === 'primary-synthetic'
        ? Response.json({}, { status: 403 }) : Response.json([row()]);
      return Response.json([{ lat1: from.lat, lon1: from.lon, lat2: to.lat, lon2: to.lon, status: 'OK', duration: 600, distance: 260 }]);
    } });
  await client.buildPublicTransportRoute({ from, to, departureUtc: 1790000000, requestBudget: { consume() { used++; } } });
  expect(used).toBe(2);
  await client.buildRoutePairs({ pairs: [[from, to]], transport: 'walking', departureUtc: 1790000000 });
  expect(calls.at(-1)?.role).toBe('primary-synthetic');
  await expect(client.buildPublicTransportRoute({ from, to, departureUtc: 1790000000,
    requestBudget: { consume() { throw new DgisRequestBudgetError(); } } })).rejects.toBeInstanceOf(DgisRequestBudgetError);
  expect(calls).toHaveLength(3);
});

it('rejects contradictory or malformed transit observations without inventing costs or schedules', async () => {
  for (const value of [row({ total_duration: -1 }), row({ movements: [{ type: 'passage', waiting_duration: 2000 }] }), {}]) {
    const client = new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', fetchImpl: async () => Response.json([value]) });
    await expect(client.buildPublicTransportRoute({ from, to, departureUtc: 1790000000 })).rejects.toThrow();
  }
});

it('bounds provider response bytes before parsing and does not retry an oversized response', async () => {
  let calls = 0, cancelled = false, chunks = 0;
  const client = new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', backupApiKey: 'synthetic-backup',
    fetchImpl: async () => { calls++; return new Response(new ReadableStream({
      pull(controller) { if (chunks++ < 10) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); },
      cancel() { cancelled = true; },
    })); } });
  await expect(client.buildPublicTransportRoute({ from, to, departureUtc: 1790000000 })).rejects.toThrow();
  expect(cancelled).toBe(true); expect(calls).toBe(1);
});

it('chooses one coherent fastest variant, preserves unknown waiting and drops malformed geometry only', async () => {
  const client = new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', fetchImpl: async () => Response.json([
    row({ total_duration: 1800 }), row({ movements: [{ type: 'passage', moving_duration: 600,
      alternatives: [{ geometry: [{ selection: 'LINESTRING(not-valid)' }] }],
      routes: [{ subtype: 'bus', names: ['1'.repeat(500)] }], waypoint: { name: 'x'.repeat(500) } }], schedules: [] }),
  ]) });
  const result = await client.buildPublicTransportRoute({ from, to, departureUtc: 1790000000 });
  expect(result).toMatchObject({ durationSeconds: 900, geometry: null,
    transit: { waitingSeconds: null, scheduleEvidence: 'unknown' } });
  expect(result!.transit.stages[0]!.names[0]).toHaveLength(200);
  expect(result!.transit.stages[0]!.stop).toHaveLength(300);
});

it('keeps each route name attached to its own transport when a movement has mixed alternatives', async () => {
  const client = new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', fetchImpl: async () => Response.json([
    row({ movements: [{ type: 'passage', moving_duration: 600, waiting_duration: 300,
      routes: [{ subtype: 'bus', names: ['6'] }, { subtype: 'trolleybus', names: ['8'] }] }] }),
  ]) });
  const result = await client.buildPublicTransportRoute({ from, to, departureUtc: 1790000000 });
  expect(result!.transit.stages[0]).toMatchObject({ transport: null, names: ['6', '8'],
    routes: [{ transport: 'bus', names: ['6'] }, { transport: 'trolleybus', names: ['8'] }] });
});
