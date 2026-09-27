import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultPlannerPython } from './planner-process.js';
import { demoNow, planningFixture } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';
import { PublicPlan } from '../shared/planning-form.js';

describe.skipIf(!existsSync(defaultPlannerPython()))('final route geometry through the real solver', () => {
  async function run(geometry: boolean, slow = false) {
    const fixture = planningFixture(), requests: any[] = [];
    const client = fixture.client(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.output !== 'detailed') return fixture.defaultFetch(url, init);
      requests.push(body);
      const [a, b] = body.points;
      const middle = `${(a.lon + b.lon) / 2 + .0036} ${(a.lat + b.lat) / 2}`;
      return Response.json({ status: 'OK', type: 'result', query: body,
        result: [{ total_duration: slow ? 900 : 480, total_distance: 600,
          maneuvers: geometry ? [{ outcoming_path: { geometry: [{
            selection: `LINESTRING(${a.lon} ${a.lat},${middle},${b.lon} ${b.lat})`,
          }] } }] : [] }] });
    });
    const result = await planPlacesWithDgis(client, fixture.input, { retrieval: { radiusMeters: 5000, maxPages: 1 },
      now: demoNow, dataMode: 'test', includeGeometry: true });
    return { result: result as Record<string, any>, requests };
  }
  it('delivers only measured paths for actual selected departures, with original observation expiry', async () => {
    const { result, requests } = await run(true);
    expect(result.status).toBe('AVAILABLE');
    const plan = PublicPlan.parse(result), segments = plan.days[0]!.travel_segments!;
    expect(segments).toHaveLength(2);
    expect(segments.map(segment => segment.departure_utc)).toEqual(requests.map(body => body.utc));
    expect(segments[0]!.coordinates[0]![0]).toEqual([37.62, 55.75]);
    expect(segments[1]!.to_id).toBe(plan.days[0]!.visits[1]!.place_id);
    expect(segments.every(segment => segment.source.valid_until === '2026-09-24T09:35:00.000Z')).toBe(true);
    expect(plan.valid_until).toBe('2026-09-24T09:35:00.000Z');
    expect(result.warnings).not.toContain('ROUTE_GEOMETRY_UNAVAILABLE');
    expect(result.routing.routing_http_calls).toBeGreaterThanOrEqual(requests.length);
  }, 30000);
  it('keeps the validated plan with a visible warning when detailed time has no geometry', async () => {
    const { result } = await run(false);
    expect(result.status).toBe('AVAILABLE');
    expect(result.days[0].travel_segments).toEqual([]);
    expect(result.warnings).toContain('ROUTE_GEOMETRY_UNAVAILABLE');
  }, 30000);
  it('replans when the detailed observation is slower and discards paths from the old schedule', async () => {
    const { result, requests } = await run(true, true);
    expect(result.status).toBe('AVAILABLE');
    expect(result.routing.replans).toBe(1);
    expect(requests).toHaveLength(4);
    expect(result.days[0].travel_segments.map((segment: any) => segment.departure_utc))
      .toEqual(requests.slice(-2).map(body => body.utc));
    expect(result.days[0].visits.every((visit: any) => visit.travel_before_minutes >= 15)).toBe(true);
  }, 30000);
});
