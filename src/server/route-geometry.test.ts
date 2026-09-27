import { describe, expect, it } from 'vitest';
import { normalizeRouteGeometry, parseRouteLine } from './route-geometry.js';
import { DgisClient } from './dgis.js';

const from = { lat: 55.75, lon: 37.62 }, to = { lat: 55.751, lon: 37.623 };
const wkt = 'LINESTRING(37.62 55.75,37.621 55.7504,37.623 55.751)';
const route = () => ({ total_duration: 240, total_distance: 230,
  maneuvers: [{ outcoming_path: { geometry: [{ selection: wkt }] } }] });
describe('provider route geometry', () => {
  it('reads 2D and elevation WKT without inventing connections', () => {
    expect(parseRouteLine('LINESTRING Z (37.62 55.75 9,37.623 55.751 10)')).toEqual([[37.62, 55.75], [37.623, 55.751]]);
    expect(normalizeRouteGeometry(route(), { from, to, distanceMeters: 230 })).toEqual([
      [[37.62, 55.75], [37.621, 55.7504], [37.623, 55.751]],
    ]);
  });
  it.each(['LINESTRING(181 55,37 55)', 'LINESTRING(NaN 55,37 55)', 'POINT(37 55)',
    'LINESTRING(37 55)', 'LINESTRING(37 55,37 55);alert(1)', 'LINESTRING(37 55 1 2,37 56 1 2)'])('rejects invalid geometry %s', input => {
    expect(parseRouteLine(input)).toBeNull();
  });
  it('rejects unrelated coordinates, discontinuities and contradictory distance', () => {
    expect(normalizeRouteGeometry(route(), { from: { lat: 56, lon: 38 }, to, distanceMeters: 230 })).toBeNull();
    const gap = route(); gap.maneuvers.push({ outcoming_path: { geometry: [{ selection: 'LINESTRING(38 56,38.01 56.01)' }] } });
    expect(normalizeRouteGeometry(gap, { from, to, distanceMeters: 230 })).toBeNull();
    expect(normalizeRouteGeometry(route(), { from, to, distanceMeters: 9000 })).toBeNull();
  });
  it('limits geometry size and does not accept absent geometry', () => {
    expect(parseRouteLine('LINESTRING(' + Array.from({ length: 10001 }, () => '37 55').join(',') + ')')).toBeNull();
    expect(normalizeRouteGeometry({}, { from, to, distanceMeters: 230 })).toBeNull();
  });
  it('measures detailed geometry and time together at the confirmed departure', async () => {
    let posted: any;
    const client = new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', fetchImpl: async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return Response.json({ status: 'OK', type: 'result', query: posted, result: [route()] });
    } });
    const result = await client.buildRouteSegment({ from, to, transport: 'walking', departureUtc: 1790590800 });
    expect(posted).toMatchObject({ output: 'detailed', utc: 1790590800, save_route: false, traffic_mode: 'statistics' });
    expect(result).toMatchObject({ durationSeconds: 240, distanceMeters: 230, geometry: expect.any(Array) });
  });
  it('keeps valid time with an explicit missing-geometry value and rejects mismatched response points', async () => {
    let wrong = false;
    const client = new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', fetchImpl: async (_url, init) => {
      const query = JSON.parse(String(init?.body)); if (wrong) query.points[0].lon = 40;
      return Response.json({ status: 'OK', type: 'result', query,
        result: [{ total_duration: 240, total_distance: 230, maneuvers: [] }] });
    } });
    expect(await client.buildRouteSegment({ from, to, transport: 'walking', departureUtc: 1790590800 })).toEqual({
      durationSeconds: 240, distanceMeters: 230, geometry: null,
    });
    wrong = true;
    await expect(client.buildRouteSegment({ from, to, transport: 'walking', departureUtc: 1790590800 })).rejects.toThrow();
  });
});
