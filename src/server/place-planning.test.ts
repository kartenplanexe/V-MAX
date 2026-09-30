import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { defaultPlannerPython } from './planner-process.js';
import { DgisClient } from './dgis.js';
import { conservativeTravelSeconds, planPlacesWithDgis, safePlanningDiagnostic } from './place-planning.js';
import { demoNow, planningFixture } from './place-planning.fixture.js';

const options = { retrieval: { radiusMeters: 5000, maxPages: 1 }, now: demoNow, dataMode: 'test' as const };
it('never accepts a walking route shorter than its geometry or an implausibly fast walk', () => {
  const pair = { day_id: 'd1', from_id: '@origin', to_id: 'tower',
    from_point: { lat: 56.326919, lon: 43.992346 }, to_point: { lat: 56.335627, lon: 43.974836 },
    date: '2026-09-26', window: { start: '16:00', end: '18:00' }, mode: 'walking' as const };
  expect(conservativeTravelSeconds(pair, { durationSeconds: 420, distanceMeters: 600 })).toBeNull();
  expect(conservativeTravelSeconds(pair, { durationSeconds: 600, distanceMeters: 1600 })).toBeGreaterThan(880);
});
it.each([['cycling', 12.5], ['driving', 44.5]] as const)('checks %s geometry before accepting a provider route', (mode, speed) => {
  const pair = { day_id: 'd1', from_id: '@origin', to_id: 'place',
    from_point: { lat: 55.75, lon: 37.62 }, to_point: { lat: 55.85, lon: 37.62 },
    date: '2026-09-26', window: { start: '16:00', end: '18:00' }, mode };
  expect(conservativeTravelSeconds(pair, { durationSeconds: 1000, distanceMeters: 100 })).toBeNull();
  expect(conservativeTravelSeconds(pair, { durationSeconds: 1, distanceMeters: 12_000 })).toBeNull();
  expect(conservativeTravelSeconds(pair, { durationSeconds: 600, distanceMeters: 12_000 }))
    .toBeGreaterThanOrEqual(12_000 / speed);
});
describe.skipIf(!existsSync(defaultPlannerPython()))('confirmed JSON -> 2GIS HTTP -> real Python solver -> route verification', () => {
  function recoveryFixture(recheckFailure = false) {
    const f = planningFixture(), template = structuredClone(f.items[0]!);
    f.items.splice(0, f.items.length, ...['culture', 'food'].flatMap((activity, group) => Array.from({ length: 25 }, (_, index) => ({
      ...structuredClone(template), id: `${activity}-${String(index).padStart(2, '0')}`, rubrics: [{ id: group ? '200' : '100' }],
      point: { lat: 55.751 + group * 0.001 + index * 0.00001, lon: 37.621 },
    }))));
    const byPoint = new Map(f.items.map(item => [JSON.stringify(item.point), item.id]));
    const selectedFood = recheckFailure ? 14 : 13;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const response = await f.defaultFetch(url, init);
      if (!init?.body) return response;
      const rows = await response.json() as { lat1: number; lon1: number; lat2: number; lon2: number; status: string }[];
      return Response.json(rows.map(row => {
        const target = byPoint.get(JSON.stringify({ lat: row.lat2, lon: row.lon2 })) ?? '';
        const origin = byPoint.get(JSON.stringify({ lat: row.lat1, lon: row.lon1 })) ?? '';
        const blocked = target.startsWith('food-') && Number(target.slice(5)) < selectedFood;
        const initialException = recheckFailure && f.routingBatches() <= 5 && origin === 'culture-00' && target === 'food-00';
        return blocked && !initialException ? { ...row, status: 'NOT_FOUND' } : row;
      }));
    };
    return { ...f, fetch };
  }

  it('recovers a missing ordered activity using one extra candidate within the default 200 physical pair budget', async () => {
    const f = recoveryFixture();
    const result = await planPlacesWithDgis(f.client(f.fetch), f.input, { ...options,
      retrieval: { radiusMeters: 5000, pageSize: 50, maxPages: 1 } }) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');
    expect(result.days[0].missing_activity_ids).toEqual([]);
    expect(result.days[0].visits.map((visit: any) => visit.activity_id)).toEqual(['culture', 'food']);
    expect(result.routing.recovery.added_candidates).toBe(1);
    expect(result.routing.route_pair_calculations).toBeLessThanOrEqual(200);
    expect(result.search_scope).toEqual({ radius_meters: 5000, coverage: 'BOUNDED_RESULTS' });
  }, 30_000);

  it('can backfill outside the original pool after a selected edge fails the first departure recheck', async () => {
    const f = recoveryFixture(true);
    const result = await planPlacesWithDgis(f.client(f.fetch), f.input, { ...options, maxRoutePairs: 240,
      retrieval: { radiusMeters: 5000, pageSize: 50, maxPages: 1 } }) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');
    expect(result.routing.replans).toBe(1);
    expect(result.routing.recovery.added_candidates).toBe(1);
    expect(result.days[0].visits[1].place_id).not.toBe('food-00');
    expect(result.routing.route_pair_calculations).toBeLessThanOrEqual(240);
  }, 30_000);

  it('keeps the feasible prefix and explicit truncation when recovery exhausts its residual allowance', async () => {
    const f = recoveryFixture(), failed = new Map<string, number>();
    const result = await planPlacesWithDgis(f.client(async (url, init) => {
      const response = await f.fetch(url, init);
      if (!init?.body) return response;
      const rows = await response.json() as any[];
      return Response.json(rows.map(row => {
        if (row.lat2 < 55.752) return row;
        const key = JSON.stringify([row.lat1, row.lon1, row.lat2, row.lon2, JSON.parse(String(init.body)).utc]);
        failed.set(key, (failed.get(key) ?? 0) + 1);
        return { ...row, status: 'NOT_FOUND' };
      }));
    }), f.input, { ...options, retrieval: { radiusMeters: 5000, pageSize: 50, maxPages: 1 } }) as Record<string, any>;
    expect(result.status).toBe('LIMITED');
    expect(result.days[0].visits.map((visit: any) => visit.activity_id)).toEqual(['culture']);
    expect(result.days[0].missing_activity_ids).toEqual(['food']);
    expect(result.routing.recovery.stop_reason).toBe('BUDGET_EXHAUSTED');
    expect(result.warnings).toContain('ROUTE_CANDIDATES_TRUNCATED');
    expect(result.routing.route_pair_calculations).toBeLessThanOrEqual(200);
    expect([...failed.values()].every(count => count === 1)).toBe(true);
  }, 30_000);

  it('stops after the shared monotonic deadline and retains partial search evidence', async () => {
    const f = planningFixture(); let elapsed = 0, requests = 0;
    const timer = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const result = await planPlacesWithDgis(f.client(async (url, init) => {
        requests++;
        const response = await f.defaultFetch(url, init); elapsed = 90_001; return response;
      }), f.input, options) as Record<string, any>;
      expect(result.status).toBe('ERROR');
      expect(result.issues).toEqual(['ROUTING_BUDGET_OR_DEADLINE_EXCEEDED']);
      expect(requests).toBe(1); expect(result.routing.routing_http_calls).toBe(0);
      expect(result.search_scope).toEqual({ radius_meters: 5000, coverage: 'PARTIAL' });
      expect(result.routing.places_deadline_stops).toBeGreaterThan(0);
      expect(safePlanningDiagnostic(result)).toMatchObject({ budget_stop_code: 'DEADLINE_EXCEEDED',
        pipeline_stage: 'SHORTLIST', elapsed_ms: 90_001, candidate_counts_available: false });
    } finally { timer.mockRestore(); }
  }, 15_000);

  it('logs only aggregate failure causes, without place identifiers or provider payloads', () => {
    const summary = safePlanningDiagnostic({ status: 'UNAVAILABLE', routing: { places_http_calls: 2, routing_http_calls: 1,
      routing_failed_batches: 1 }, shortlist: { groups: [{ eligible: 3, selected: 2 }] },
    excluded: [{ place_id: 'sensitive-place-id', reasons: ['SCHEDULE_UNKNOWN', 'DROP TABLE'] }],
    days: [{ visits: [] }] });
    expect(summary).toEqual({ status: 'UNAVAILABLE', places_http_calls: 2, places_received: 0, places_rejected_items: 0,
      pipeline_stage: 'UNKNOWN', stop_issue: null, budget_stop_code: null, elapsed_ms: 0,
      route_pair_calculations: 0, max_route_pair_calculations: 0, max_routing_http_calls: 0,
      candidate_counts_available: true,
      event_http_calls: 0, event_candidates: 0, event_unresolved: 0, retrieval_http_calls: 0,
      places_logical_queries: 0, places_unsearched_groups: 0, places_budget_stops: 0, places_deadline_stops: 0,
      places_failed_queries: 0, places_http_4xx: 0, places_http_5xx: 0, places_transport_failures: 0,
      places_provider_4xx: 0, places_schema_failures: 0, places_max_rubric_ids: 0, places_failure_codes: {}, routing_http_calls: 1,
      routing_failed_batches: 1, eligible_options: 3, shortlisted_options: 2, excluded_options: 1,
      transit_extra_samples: 0, transit_selected_segments: 0, transit_pedestrian_segments: 0, transit_unknown_schedules: 0,
      activity_funnel: [{ slot: 1, eligible: 3, shortlisted: 2, scheduled: 0, missing: false }],
      exclusion_reasons: { SCHEDULE_UNKNOWN: 1 }, verified_visits: 0 });
    expect(JSON.stringify(summary)).not.toContain('sensitive-place-id');
  });
  it('charges every fallback routing attempt and its pairs to the same operation', async () => {
    const f = planningFixture(); let attempts = 0, pairs = 0;
    const client = new DgisClient({ placesApiKey: 'synthetic-primary', routingApiKey: 'synthetic-primary',
      backupApiKey: 'synthetic-backup', tertiaryApiKey: 'synthetic-third', fetchImpl: async (url, init) => {
        if (!init?.body) return f.defaultFetch(url, init);
        attempts++; pairs += JSON.parse(String(init.body)).points.length;
        return attempts <= 2 ? Response.json({}, { status: 403 }) : f.defaultFetch(url, init);
      } });
    const result = await planPlacesWithDgis(client, f.input, { ...options, maxRoutePairs: 20 }) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');
    expect(attempts).toBe(5); expect(pairs).toBe(17);
    expect(result.routing.routing_http_calls).toBe(attempts);
    expect(result.routing.route_pair_calculations).toBe(pairs);
  }, 30_000);

  it.each([{ maxRoutePairs: 8, maxRoutingHttpCalls: 30 }, { maxRoutePairs: 200, maxRoutingHttpCalls: 5 }])(
    'blocks a fallback attempt before it consumes reserved verification allowance: %j', async limits => {
      const f = planningFixture(); let attempts = 0, pairs = 0;
      const client = new DgisClient({ placesApiKey: 'synthetic-primary', routingApiKey: 'synthetic-primary',
        backupApiKey: 'synthetic-backup', tertiaryApiKey: 'synthetic-third', fetchImpl: async (url, init) => {
          if (!init?.body) return f.defaultFetch(url, init);
          attempts++; pairs += JSON.parse(String(init.body)).points.length;
          return Response.json({}, { status: 403 });
        } });
      const result = await planPlacesWithDgis(client, f.input, { ...options, ...limits }) as Record<string, any>;
      expect(result.status).toBe('ERROR'); expect(result.days).toEqual([]);
      expect(result.issues).toEqual(['ROUTING_BUDGET_OR_DEADLINE_EXCEEDED']);
      expect(attempts).toBe(1);
      expect(result.routing.routing_http_calls).toBe(attempts);
      expect(result.routing.route_pair_calculations).toBe(pairs);
      expect(result.search_scope.radius_meters).toBe(5000);
      const diagnostic = safePlanningDiagnostic(result);
      expect(diagnostic).toMatchObject({ pipeline_stage: 'MATRIX', candidate_counts_available: true,
        budget_stop_code: limits.maxRoutePairs === 8 ? 'PAIR_BUDGET_EXHAUSTED' : 'HTTP_BUDGET_EXHAUSTED',
        stop_issue: 'ROUTING_BUDGET_OR_DEADLINE_EXCEEDED', route_pair_calculations: pairs });
      expect(diagnostic.eligible_options).toBeGreaterThan(0);
      expect(diagnostic.activity_funnel.length).toBeGreaterThan(0);
    }, 30_000);
  it('reports which requested activity lacks candidates without exposing its identifiers', () => {
    const summary = safePlanningDiagnostic({ status: 'LIMITED', shortlist: { groups: [
      { day_id: 'private-day', activity_id: 'private-walk', eligible: 4, selected: 3 },
      { day_id: 'private-day', activity_id: 'private-food', eligible: 0, selected: 0 },
    ] }, days: [{ day_id: 'private-day', missing_activity_ids: ['private-food'],
      visits: [{ activity_id: 'private-walk', name: 'private-place' }] }] });
    expect(summary.activity_funnel).toEqual([
      { slot: 1, eligible: 4, shortlisted: 3, scheduled: 1, missing: false },
      { slot: 2, eligible: 0, shortlisted: 0, scheduled: 0, missing: true },
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/private-|private-place/u);
  });
  it('rejects arbitrary pipeline labels and exception contents from operator output', () => {
    const summary = safePlanningDiagnostic({ status: 'ERROR', issues: ['PRIVATE_ISSUE'], routing: {
      pipeline_stage: 'PRIVATE_STAGE', budget_stop_code: 'PRIVATE_BUDGET', elapsed_ms: -10,
      route_pair_calculations: -1, message: 'private raw provider data', stack: 'private stack',
    } });
    expect(summary).toMatchObject({ pipeline_stage: 'UNKNOWN', stop_issue: null, budget_stop_code: null,
      elapsed_ms: 0, route_pair_calculations: 0, candidate_counts_available: false });
    expect(JSON.stringify(summary)).not.toMatch(/private|PRIVATE/u);
  });
  it('normalizes places, excludes closures before routing, preserves order, checks exact departures', async () => {
    const f = planningFixture();
    const result = await planPlacesWithDgis(f.client(), f.input, options);
    expect(result.status).toBe('AVAILABLE');
    const output = result as Record<string, any>;
    expect(output.data_mode).toBe('test');
    expect(output.origin).toEqual(f.input.intent.points.origin);
    expect(output.days[0].visits.map((v: any) => v.place_id)).toEqual(['near', 'cafe']);
    expect(output.days[0].visits.map((v: any) => v.distance_before_meters)).toEqual([600, 600]);
    expect(output.days[0].visits.map((v: any) => v.starts_at)).toEqual([977, 1054]);
    expect(output.total_expected_cost_minor).toBeNull();
    expect(output.routing.route_pair_calculations).toBe(7);
    expect(output.routing.llm_calls).toBe(0);
    expect(output.routing.arrival_guaranteed).toBe(false);
    const routing = f.requests.filter(r => r.body);
    expect(routing[0]!.body!.utc).toBe(Date.parse('2026-09-25T13:00:00Z') / 1000);
    expect(routing.at(-1)!.body!.utc).toBe(Date.parse('2026-09-25T14:17:00Z') / 1000);
    expect(JSON.stringify(routing)).not.toContain('55.753');
    expect(routing.every(r => r.body!.traffic_mode === 'statistics' && r.body!.save_route === false)).toBe(true);
  }, 30_000);

  it('keeps an average bill distinct from a strict ceiling and scales an explicit estimate to the whole group', async () => {
    const f = planningFixture();
    Object.assign(f.items.find(item => item.id === 'cafe')!, { attribute_groups: [{ attributes: [
      { tag: 'food_service_avg_price', name: 'Средний чек 1 200 ₽' },
    ] }] });
    const input = structuredClone(f.input);
    const culture = structuredClone(input.intent.days[0]!.activities[0]!);
    input.intent.days[0]!.activities.splice(0, 1);
    input.intent.days[0]!.order = [];
    const budget = { kind: 'limit', amount_rub: 2400, basis: 'whole_party', period: 'whole_trip' };
    Object.assign(input.intent.shared, { budget, party: { total: 2 } });

    const strict = await planPlacesWithDgis(f.client(), input, options) as Record<string, any>;
    expect(strict.status).toBe('UNAVAILABLE');
    expect(strict.issues).toContain('BUDGET_PRICE_DATA_REQUIRED');
    expect(strict.total_expected_cost_minor).toBeNull();
    expect(strict.total_budget_upper_minor).toBeNull();
    expect(strict.days[0].visits).toEqual([]);

    Object.assign(budget, { enforcement: 'estimated', price_basis_assumption: 'per_person', amount_rub: 2399 });
    const tooSmall = await planPlacesWithDgis(f.client(), input, options) as Record<string, any>;
    expect(tooSmall.status).toBe('UNAVAILABLE');
    expect(tooSmall.days[0].visits).toEqual([]);

    budget.amount_rub = 2400;
    const estimate = await planPlacesWithDgis(f.client(), input, options) as Record<string, any>;
    expect(estimate.status).toBe('AVAILABLE');
    expect(estimate.days[0].visits.map((visit: any) => visit.place_id)).toEqual(['cafe']);
    expect(estimate.total_expected_cost_minor).toBe(240000);
    expect(estimate.days[0].visits[0].price_expected_minor).toBe(240000);
    expect(estimate.total_budget_upper_minor).toBeNull();
    expect(estimate.warnings).toEqual(expect.arrayContaining([
      'BUDGET_ESTIMATED_NOT_GUARANTEED', 'AVERAGE_CHECK_BASIS_ASSUMED_PER_PERSON',
    ]));

    input.intent.days[0]!.activities.unshift(culture);
    input.intent.days[0]!.order = [['culture', 'food']];
    const incomplete = await planPlacesWithDgis(f.client(), input, options) as Record<string, any>;
    expect(incomplete.status).toBe('LIMITED');
    expect(incomplete.days[0].missing_activity_ids).toEqual(['culture']);
    expect(incomplete.issues).toContain('BUDGET_PRICE_DATA_REQUIRED');
    expect(incomplete.excluded.some((row: any) => row.activity_id === 'culture' && row.reasons.includes('PRICE_ESTIMATE_UNKNOWN'))).toBe(true);
    expect(incomplete.total_expected_cost_minor).toBe(240000);
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

  it('reduces alternatives while keeping both activities and reserving verification budget', async () => {
    const f = planningFixture();
    const result = await planPlacesWithDgis(f.client(), f.input, { ...options, maxRoutePairs: 8 }) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');
    expect(result.days[0].visits.map((visit: any) => visit.activity_id)).toEqual(['culture', 'food']);
    expect(result.routing.route_pair_calculations).toBeLessThanOrEqual(8);
    expect(result.shortlist.groups.find((group: any) => group.activity_id === 'culture').truncated).toBe(true);
  }, 30_000);

  it('asks to narrow a request before routing when minimum activity coverage cannot fit the allowance', async () => {
    const f = planningFixture();
    const result = await planPlacesWithDgis(f.client(), f.input, { ...options, maxRoutePairs: 6 }) as Record<string, any>;
    expect(result.status).toBe('NEEDS_INPUT');
    expect(result.issues).toEqual(['ROUTING_SCOPE_TOO_LARGE']);
    expect(f.routingBatches()).toBe(0);
  }, 30_000);

  it('routes more than four walk stops through real normalization and same-activity routing edges', async () => {
    const f = planningFixture();
    const template = structuredClone(f.items[0]!);
    f.items.splice(0, f.items.length, ...Array.from({ length: 8 }, (_, index) => ({
      ...structuredClone(template), id: `walk-${index}`, name: `Учебная точка ${index}`,
      point: { lat: 55.751 + index * 0.0001, lon: 37.621 },
    })));
    const input = structuredClone(f.input);
    input.intent.days[0]!.activities.splice(1);
    input.intent.days[0]!.order = [];
    input.intent.days[0]!.window = { start: '12:00', end: '20:00' };
    Object.assign(input.visit_policy, { by_activity: { culture: 25 }, max_stops_by_activity: { culture: 19 } });
    const result = await planPlacesWithDgis(f.client(), input, options) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');

    expect(result.days[0].visits).toHaveLength(6);
    expect(result.days[0].visits.every((visit: any) => visit.duration_minutes === 60)).toBe(true);
    expect(new Set(result.days[0].visits.map((visit: any) => visit.place_id)).size).toBe(6);
    expect(result.routing.checked_departures).toHaveLength(6);
    expect(result.routing.route_pair_calculations).toBeLessThanOrEqual(200);
  }, 30_000);

  it('keeps four unordered activities within the actual routing request allowance', async () => {
    const f = planningFixture();
    const categories = ['100', '200', '300', '400'];
    const template = structuredClone(f.items[0]!);
    f.items.splice(0, f.items.length, ...categories.flatMap((category, group) => Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(template), id: `candidate-${group}-${index}`, rubrics: [{ id: category }],
      point: { lat: 55.751 + (group * 4 + index) * 0.0001, lon: 37.621 },
    }))));
    const input = structuredClone(f.input);
    const activity = structuredClone(input.intent.days[0]!.activities[0]!);
    input.intent.days[0]!.activities = categories.map((category, index) => ({ ...structuredClone(activity), id: `activity-${index}`,
      categories: { ...activity.categories, include_any: [category] } }));
    input.intent.days[0]!.order = [];
    input.intent.days[0]!.window = { start: '12:00', end: '20:00' };
    input.catalog.leaf_ids = categories;
    Object.assign(input.visit_policy.by_category, Object.fromEntries(categories.map(category => [category, 25])));
    const result = await planPlacesWithDgis(f.client(), input, options) as Record<string, any>;
    expect(result.status).toBe('AVAILABLE');
    expect(result.days[0].missing_activity_ids).toEqual([]);
    expect(new Set(result.days[0].visits.map((visit: any) => visit.activity_id)).size).toBe(4);
    expect(result.routing.route_pair_calculations).toBeLessThanOrEqual(200);
    expect(result.routing.routing_http_calls).toBeLessThanOrEqual(30);
  }, 30_000);

  it('validates malformed or unsupported intent before any provider call', async () => {
    const f = planningFixture();
    f.input.intent.shared.mobility = ['teleport'];
    const result = await planPlacesWithDgis(f.client(), f.input, options) as Record<string, any>;
    expect(result.status).toBe('NEEDS_INPUT');
    expect(result.issues).toContain('UNSUPPORTED_TRANSPORT');
    expect(f.requests).toHaveLength(0);
    expect(result.candidate_preview).toBeUndefined();
  }, 30_000);

  it('does not invent a route when all provider requests fail and does not retry HTTP', async () => {
    const f = planningFixture();
    const responseFetch: typeof fetch = async (url, init) => init?.body ? new Response('test-only', { status: 503 }) : f.defaultFetch(url, init);
    const result = await planPlacesWithDgis(f.client(responseFetch), f.input, options) as Record<string, any>;
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.routing.routing_http_calls).toBe(1);
    expect(result.routing.routing_failed_batches).toBe(1);
    expect(result.warnings).toContain('ROUTING_PROVIDER_FAILURE');
    expect(result.candidate_preview.groups.flatMap((group: any) => group.places).length).toBe(3);
    expect(result.days[0].visits).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('test-only');
  }, 30_000);

  it('stops at the matrix when every routing key is denied instead of searching impossible alternatives', async () => {
    const f = planningFixture(); let attempts = 0;
    const client = new DgisClient({ placesApiKey: 'synthetic-primary', routingApiKey: 'synthetic-primary',
      backupApiKey: 'synthetic-backup', tertiaryApiKey: 'synthetic-third', fetchImpl: async (url, init) => {
        if (!init?.body) return f.defaultFetch(url, init);
        attempts++; return Response.json({ message: 'private-provider-marker' }, { status: attempts < 3 ? 429 : 403 });
      } });
    const result = await planPlacesWithDgis(client, f.input, options) as Record<string, any>;
    expect(result).toMatchObject({ status: 'ERROR', issues: ['ROUTING_PROVIDER_UNAVAILABLE'], days: [],
      routing: { pipeline_stage: 'MATRIX', routing_http_calls: 3, routing_failed_batches: 1,
        recovery: { attempts: 0 } } });
    expect(attempts).toBe(3);
    expect(safePlanningDiagnostic(result).stop_issue).toBe('ROUTING_PROVIDER_UNAVAILABLE');
    expect(result.candidate_preview.groups).toEqual([
      expect.objectContaining({ day_id: 'd1', activity_id: 'culture', places: [
        expect.objectContaining({ place_id: 'near', name: 'Учебный музей' }),
        expect.objectContaining({ place_id: 'far', name: 'Учебный музей далеко' }),
      ] }),
      expect.objectContaining({ day_id: 'd1', activity_id: 'food', places: [expect.objectContaining({ place_id: 'cafe' })] }),
    ]);
    expect(JSON.stringify(result.candidate_preview)).not.toContain('Закрыто');
    expect(result.valid_until).toBe('2026-09-24T09:35:00.000Z');
    expect(JSON.stringify(result)).not.toMatch(/private-provider-marker|synthetic-primary|synthetic-backup|synthetic-third/);
  }, 30_000);

  it('keeps a provider-confirmed absent road distinct from a service access failure', async () => {
    const f = planningFixture();
    const responseFetch: typeof fetch = async (url, init) => {
      const response = await f.defaultFetch(url, init);
      if (!init?.body) return response;
      const rows = await response.json() as Record<string, unknown>[];
      return Response.json(rows.map(row => ({ ...row, status: 'ROUTE_NOT_FOUND', duration: null, distance: null })));
    };
    const result = await planPlacesWithDgis(f.client(responseFetch), f.input, options) as Record<string, any>;
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.routing.routing_failed_batches).toBe(0);
    expect(result.days[0].visits).toEqual([]);
    expect(result.issues ?? []).not.toContain('ROUTING_PROVIDER_UNAVAILABLE');
  }, 30_000);

  it('discards a previously solved route when the service denies the final departure check', async () => {
    const f = planningFixture(); let attempts = 0;
    const responseFetch: typeof fetch = async (url, init) => {
      if (init?.body && ++attempts > 1) return Response.json({}, { status: 429 });
      return f.defaultFetch(url, init);
    };
    const result = await planPlacesWithDgis(f.client(responseFetch), f.input, options) as Record<string, any>;
    expect(result).toMatchObject({ status: 'ERROR', issues: ['ROUTING_PROVIDER_UNAVAILABLE'], days: [],
      routing: { pipeline_stage: 'DEPARTURE_CHECKS', replans: 0 } });
    expect(result.candidate_preview.groups.flatMap((group: any) => group.places).length).toBe(3);
    expect(attempts).toBe(2);
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

  it('rejects distant candidates even if the provider returns them for a nearby search', async () => {
    const f = planningFixture();
    f.items.find(item => item.id === 'near')!.point = { lat: 56.25, lon: 37.62 };
    f.items.find(item => item.id === 'far')!.point = { lat: 56.30, lon: 37.65 };
    f.items.find(item => item.id === 'closed')!.point = { lat: 56.27, lon: 37.623 };
    const result = await planPlacesWithDgis(f.client(), f.input, options) as Record<string, any>;
    expect(result.status).toBe('LIMITED');
    expect(result.days[0].missing_activity_ids).toContain('culture');
    expect(result.excluded.filter((row: any) => row.activity_id === 'culture' &&
      ['near', 'far', 'closed'].includes(row.place_id))
      .every((row: any) => row.reasons.includes('OUTSIDE_SEARCH_RADIUS'))).toBe(true);
    expect(result.days[0].visits.map((visit: any) => visit.place_id)).toEqual(['cafe']);
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
    expect(result.candidate_preview).toBeUndefined();
  }, 30_000);
});
