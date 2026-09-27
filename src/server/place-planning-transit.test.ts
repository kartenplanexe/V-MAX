import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DgisClient } from './dgis.js';
import { defaultPlannerPython } from './planner-process.js';
import { demoNow, planningFixture } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';
import { PublicPlan } from '../shared/planning-form.js';

const options = { retrieval: { radiusMeters: 5000, maxPages: 1 }, now: demoNow, dataMode: 'test' as const };
function transitFixture(duration: (departure: number, target: number, count: number) => number | null = () => 900) {
  const f = planningFixture(); f.input.intent.shared.mobility = ['public_transport'];
  f.items.splice(1, 1); // One eligible candidate in each activity; no artificial routing ambiguity.
  const departures: { utc: number; target: number }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    if (!init?.body) return f.defaultFetch(url, init);
    expect(new URL(String(url)).pathname).toBe('/public_transport/2.0');
    const body = JSON.parse(String(init.body));
    expect(body.enable_schedule).toBe(true); expect(body.transport).toContain('bus');
    departures.push({ utc: body.start_time, target: body.target.point.lat });
    const seconds = duration(body.start_time, body.target.point.lat, departures.length);
    if (seconds === null) return new Response(null, { status: 204 });
    return Response.json([{ total_duration: seconds, total_distance: 600, pedestrian: false,
      transfer_count: 0, crossing_count: 1, schedules: [{ origin_from: 'eta' }], movements: [
        { type: 'passage', moving_duration: seconds - 300, waiting_duration: 300,
          routes: [{ names: ['7'], subtype: 'bus' }], waypoint: { name: 'Учебная остановка' } },
      ] }]);
  };
  return { ...f, departures, client: new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', fetchImpl }) };
}
describe.skipIf(!existsSync(defaultPlannerPython()))('public transport through real normalized places and Python solver', () => {
  it('keeps fare unknown, uses one dated HTTP per pair, and exposes verified transit facts without fake geometry', async () => {
    const f = transitFixture();
    const result = await planPlacesWithDgis(f.client, f.input, options) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');
    expect(result.days[0].visits.map((v: any) => v.activity_id)).toEqual(['culture', 'food']);
    expect(result.routing.routing_http_calls).toBe(f.departures.length);
    expect(result.routing.route_pair_calculations).toBe(f.departures.length);
    expect(f.departures.length).toBeLessThanOrEqual(30);
    expect(result.routing.checked_departures.map((r: any) => r.reserved_minutes)).toEqual([25, 25]);
    expect(result.days[0].travel_segments).toHaveLength(2);
    expect(result.days[0].travel_segments[1]).toMatchObject({ coordinates: [], mode: 'public_transport',
      transit: { pedestrian: false, waitingSeconds: 300, scheduleEvidence: 'predicted' } });
    expect(result.days[0].travel_segments[1].departure_utc).toBeGreaterThan(result.days[0].travel_segments[0].departure_utc);
    expect(result.total_expected_cost_minor).toBeNull();
    expect(result.warnings).toEqual(expect.arrayContaining(['TRANSIT_PRICE_UNKNOWN', 'PT_SCHEDULE_SEARCH_BOUNDED', 'ROUTE_TIME_IS_ESTIMATE']));
    expect(PublicPlan.parse(result).days[0]!.travel_segments).toHaveLength(2);
    expect(result.valid_until).toBe('2026-09-24T09:35:00.000Z');
  }, 30_000);

  it('re-solves when the actual later departure has more waiting and checks the new schedule', async () => {
    const start = Date.parse('2026-09-25T13:00:00Z') / 1000;
    const f = transitFixture((utc, target) => target === 55.752 && utc > start && utc < start + 2 * 3600 ? 1500 : 900);
    const result = await planPlacesWithDgis(f.client, f.input, options) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE'); expect(result.routing.replans).toBe(1);
    expect(result.routing.checked_departures[1].reserved_minutes).toBe(35);
    expect(result.routing.checked_departures[1].observed_seconds).toBe(1500);
  }, 30_000);

  it('never returns the stale schedule after a second unstable exact check', async () => {
    const start = Date.parse('2026-09-25T13:00:00Z') / 1000; let exact = 0;
    const f = transitFixture((utc, target) => target === 55.752 && utc > start && utc < start + 2 * 3600
      ? (++exact === 1 ? 1500 : 2400) : 900);
    const result = await planPlacesWithDgis(f.client, f.input, { ...options, maxRoutingHttpCalls: 7 }) as Record<string, any>;
    expect(result.status).toBe('ERROR'); expect(result.days).toEqual([]);
    expect(result.issues).toEqual(['ROUTE_RECHECK_FAILED']);
  }, 30_000);

  it('fails a finite total budget before any provider request instead of pricing transit at zero', async () => {
    const f = transitFixture();
    Object.assign(f.input.intent.shared, { budget: { kind: 'limit', amount_rub: 5000, basis: 'whole_party', period: 'whole_trip' } });
    const result = await planPlacesWithDgis(f.client, f.input, options);
    expect(result.status).toBe('NEEDS_INPUT'); expect(result.issues).toContain('TRANSPORT_COST_POLICY_REQUIRED');
    expect(f.requests).toEqual([]); expect(f.departures).toEqual([]);
  }, 15_000);

  it('counts key fallback attempts against singlepair allowance and preserves final check reserves', async () => {
    const f = planningFixture(); f.input.intent.shared.mobility = ['public_transport']; f.items.splice(1, 1);
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'synthetic', routingApiKey: 'synthetic', backupApiKey: 'synthetic-backup',
      fetchImpl: async (url, init) => {
        if (!init?.body) return f.defaultFetch(url, init);
        calls++;
        return calls === 1 ? Response.json({}, { status: 403 }) : Response.json([{ total_duration: 900, total_distance: 600,
          pedestrian: false, transfer_count: 0, crossing_count: 0, movements: [
            { type: 'passage', moving_duration: 900, waiting_duration: 0 },
          ] }]);
      } });
    const result = await planPlacesWithDgis(client, f.input, { ...options, maxRoutingHttpCalls: 7 }) as Record<string, any>;
    expect(result.status).toBe('ERROR'); expect(result.issues).toEqual(['ROUTING_BUDGET_OR_DEADLINE_EXCEEDED']);
    expect(calls).toBe(3); expect(result.routing.routing_http_calls).toBe(calls);
    expect(result.routing.route_pair_calculations).toBe(calls);
  }, 15_000);

  it('uses later bounded samples to recover a transit edge unavailable at the start, then verifies its actual departure', async () => {
    const start = Date.parse('2026-09-25T13:00:00Z') / 1000;
    const f = transitFixture((utc, target) => target === 55.752 && utc === start ? null : 900);
    const result = await planPlacesWithDgis(f.client, f.input, options) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');
    expect(result.days[0].missing_activity_ids).toEqual([]);
    expect(result.routing.transit_extra_samples).toBeGreaterThan(0);
    expect(result.routing.checked_departures[1].departure_utc).toBeGreaterThan(start);
    expect(result.warnings).toContain('PT_SCHEDULE_SEARCH_BOUNDED');
    expect(result.routing.routing_http_calls).toBeLessThanOrEqual(30);
  }, 30_000);
});
