import { expect, it } from 'vitest';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';
import { DgisRequestBudgetError } from './dgis.js';

it('covers ordered activities with measured roads and departure checks inside ten paid objects', async () => {
  const f = planningFixture(); let objects = 0;
  const result = await planPlacesWithDgis(f.client(), f.input, { retrieval: { radiusMeters: 5000 }, now: demoNow,
    dataMode: 'test', routingStrategy: 'progressive', maxRoutePairs: 10,
    consumeRoutingQuota: async count => { objects += count; } });
  expect(result.status).toBe('AVAILABLE');
  expect(result.days[0]?.visits.map((v: { activity_id: string }) => v.activity_id)).toEqual(['culture', 'food']);
  expect(objects).toBeGreaterThan(0); expect(objects).toBeLessThanOrEqual(10);
  expect(result.routing.route_pair_calculations).toBe(objects);
  expect(result.routing).toHaveProperty('verified_at');
}, 30_000);
it('keeps eligible places visible when the global allowance refuses the first road', async () => {
  const f = planningFixture();
  const result = await planPlacesWithDgis(f.client(), f.input, { retrieval: { radiusMeters: 5000 }, now: demoNow,
    dataMode: 'test', routingStrategy: 'progressive', maxRoutePairs: 10,
    consumeRoutingQuota: async () => { throw new DgisRequestBudgetError('SUBSCRIPTION_QUOTA_EXHAUSTED'); } });
  expect(result.status).not.toBe('AVAILABLE');
  expect(result).toHaveProperty('candidate_preview.groups');
  expect(result.routing.route_pair_calculations).toBe(0);
}, 30_000);
