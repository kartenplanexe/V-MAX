import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultPlannerPython } from './planner-process.js';
import { planPlacesWithDgis } from './place-planning.js';
import { demoNow, planningFixture } from './place-planning.fixture.js';

const options = { retrieval: { radiusMeters: 5000, maxPages: 1 }, now: demoNow, dataMode: 'test' as const };
describe.skipIf(!existsSync(defaultPlannerPython()))('confirmed JSON -> 2GIS HTTP -> real Python solver -> route verification', () => {
  it('normalizes places, excludes closures before routing, preserves order, checks exact departures', async () => {
    const f = planningFixture();
    const result = await planPlacesWithDgis(f.client(), f.input, options);
    expect(result.status).toBe('AVAILABLE');
    const output = result as Record<string, any>;
    expect(output.data_mode).toBe('test');
    expect(output.days[0].visits.map((v: any) => v.place_id)).toEqual(['near', 'cafe']);
    expect(output.days[0].visits.map((v: any) => v.starts_at)).toEqual([977, 1054]);
    expect(output.total_expected_cost_minor).toBeNull(); // Unknown prices are not reported as free.
    expect(output.routing.route_pair_calculations).toBe(7); // 5 matrix + 2 exact checks.
    expect(output.routing.llm_calls).toBe(0);
    expect(output.routing.arrival_guaranteed).toBe(false);
    const routing = f.requests.filter(r => r.body);
    expect(routing[0]!.body!.utc).toBe(Date.parse('2026-09-25T13:00:00Z') / 1000);
    expect(routing.at(-1)!.body!.utc).toBe(Date.parse('2026-09-25T14:17:00Z') / 1000);
    expect(JSON.stringify(routing)).not.toContain('55.753');
    expect(routing.every(r => r.body!.traffic_mode === 'statistics' && r.body!.save_route === false)).toBe(true);
  }, 30_000);

  it('does one bounded replan when a selected route gets slower, then verifies the new departures', async () => {
    const f = planningFixture();
    const responseFetch: typeof fetch = async (url, init) => {
      const response = await f.defaultFetch(url, init);
      if (!init?.body || f.routingBatches() === 1) return response;
      const rows = await response.json() as any[];
      return Response.json(rows.map(row => ({ ...row, duration: 1200 })));
    };
    const result = await planPlacesWithDgis(f.client(responseFetch), f.input, options) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');
    expect(result.routing.replans).toBe(1);
    expect(result.routing.route_pair_calculations).toBe(9);
    expect(result.days[0].visits.every((v: any) => v.travel_before_minutes === 27)).toBe(true);
  }, 30_000);

  it('withholds an unverified plan if route duration keeps changing', async () => {
    const f = planningFixture();
    const responseFetch: typeof fetch = async (url, init) => {
      const response = await f.defaultFetch(url, init);
      if (!init?.body || f.routingBatches() === 1) return response;
      const rows = await response.json() as any[];
      return Response.json(rows.map(row => ({ ...row, duration: f.routingBatches() <= 3 ? 600 : 900 })));
    };
    const result = await planPlacesWithDgis(f.client(responseFetch), f.input, options) as Record<string, any>;
    expect(result.status).toBe('ERROR');
    expect(result.issues).toEqual(['ROUTE_RECHECK_FAILED']);
    expect(result.days).toEqual([]);
    expect(result.routing.replans).toBe(1);
  }, 30_000);

  it('reserves verification budget and makes no routing request if the matrix is too big', async () => {
    const f = planningFixture();
    const result = await planPlacesWithDgis(f.client(), f.input, { ...options, maxRoutePairs: 8 }) as Record<string, any>;
    expect(result.issues).toEqual(['ROUTING_BUDGET_EXCEEDED']);
    expect(f.routingBatches()).toBe(0);
  }, 30_000);

  it('validates malformed or unsupported intent before any provider call', async () => {
    const f = planningFixture();
    f.input.intent.shared.mobility = ['public_transport'];
    const result = await planPlacesWithDgis(f.client(), f.input, options) as Record<string, any>;
    expect(result.status).toBe('NEEDS_INPUT');
    expect(result.issues).toContain('UNSUPPORTED_TRANSPORT');
    expect(f.requests).toHaveLength(0);
  }, 30_000);

  it('does not invent a route when all provider requests fail and does not retry HTTP', async () => {
    const f = planningFixture();
    const responseFetch: typeof fetch = async (url, init) => init?.body ? new Response('test-only', { status: 503 }) : f.defaultFetch(url, init);
    const result = await planPlacesWithDgis(f.client(responseFetch), f.input, options) as Record<string, any>;
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.routing.routing_http_calls).toBe(1);
    expect(result.routing.routing_failed_batches).toBe(1);
    expect(result.warnings).toContain('ROUTING_PROVIDER_FAILURE');
    expect(result.days[0].visits).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('test-only');
  }, 30_000);

  it('samples driving at three planned times and leaves unknown transport cost unknown', async () => {
    const f = planningFixture();
    f.input.intent.shared.mobility = ['driving'];
    const result = await planPlacesWithDgis(f.client(), f.input, options) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');
    expect(result.routing.route_pair_calculations).toBe(17);
    expect(result.warnings).toContain('TRANSPORT_COST_UNKNOWN');
    expect(result.total_budget_upper_minor).toBeNull();
    const matrix = f.requests.filter(r => r.body).slice(0, 3);
    expect(matrix.map(r => r.body!.utc)).toEqual(['13:00', '14:30', '15:59'].map(t => Date.parse(`2026-09-25T${t}:00Z`) / 1000));
    expect(matrix.every(r => r.body!.transport === 'driving')).toBe(true);
  }, 30_000);

  it('uses separate dated matrices for multiple days without repeating Places queries', async () => {
    const f = planningFixture();
    const day = structuredClone(f.input.intent.days[0]!);
    day.day_id = 'd2'; day.date = '2026-09-26'; f.input.intent.days.push(day);
    f.items.forEach(item => { Object.assign(item.schedule, { Sat: item.schedule.Fri }); });
    const result = await planPlacesWithDgis(f.client(), f.input, options) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');
    expect(result.days).toHaveLength(2);
    expect(result.routing.places_http_calls).toBe(2);
    expect(result.routing.route_pair_calculations).toBe(14);
    expect(result.routing.checked_departures.map((r: any) => r.day_id)).toEqual(['d1', 'd1', 'd2', 'd2']);
  }, 30_000);

  it('does not turn missing opening hours into an empty-city claim', async () => {
    const f = planningFixture();
    f.items.forEach(item => { item.schedule = undefined as any; });
    const result = await planPlacesWithDgis(f.client(), f.input, options) as Record<string, any>;
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.excluded.some((p: any) => p.reasons.includes('SCHEDULE_UNKNOWN'))).toBe(true);
    expect(result.coverage_scope).toBe('provided_candidate_pool_only');
    expect(f.routingBatches()).toBe(0);
  }, 30_000);

  it('rejects a plan if observations expire during a provider wait', async () => {
    const f = planningFixture();
    let time = demoNow();
    const responseFetch: typeof fetch = async (url, init) => {
      const response = await f.defaultFetch(url, init);
      if (f.routingBatches() >= 2) time = new Date('2026-09-24T11:00:00Z');
      return response;
    };
    const result = await planPlacesWithDgis(f.client(responseFetch), f.input, { ...options, now: () => time }) as Record<string, any>;
    expect(result.status).toBe('ERROR');
    expect(result.issues).toEqual(['PLAN_EXPIRED_OR_INVALID']);
    expect(result.days).toEqual([]);
  }, 30_000);
});
