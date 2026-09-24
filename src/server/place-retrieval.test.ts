import { describe, expect, it } from 'vitest';
import { DgisClient } from './dgis.js';
import { retrievePlaceCandidates } from './place-retrieval.js';

function intent() {
  const activity = { id: 'a1', categories: { state: 'matched', include_any: ['161', '162'], exclude: [], region_id: '32', catalog_version: 'v1' } };
  return { schema_version: 'confirmed-daily-intent.research.v1', locality: { id: 'mow', region_id: '32' },
    points: { origin: { lat: 55, lon: 37, locality_id: 'mow' } },
    days: [{ day_id: 'd1', activities: [activity] }, { day_id: 'd2', activities: [activity] }] };
}

describe('regional candidate retrieval', () => {
  it('shares identical category searches across days only within this request', async () => {
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => {
      calls++;
      return Response.json({ meta: { code: 200 }, result: { total: 2, items: [{ id: '1', name: 'Кафе' }, { id: '2', name: 'Ресторан' }] } });
    } });
    const result = await retrievePlaceCandidates(client, intent(), { catalogVersion: 'v1', radiusMeters: 5000 });
    expect(calls).toBe(1);
    expect(result.places.map(p => p.id)).toEqual(['1', '2']);
    expect(result.searches[0]?.targets).toHaveLength(2);
    expect(result.coverage).toBe('BOUNDED_RESULTS');
    await retrievePlaceCandidates(client, intent(), { catalogVersion: 'v1', radiusMeters: 5000 });
    expect(calls).toBe(2); // No production cross-request cache.
  });

  it('labels truncation, preserves partial results on provider failure and never fabricates places', async () => {
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => {
      calls++;
      if (calls === 2) return new Response(null, { status: 503 });
      return Response.json({ meta: { code: 200 }, result: { total: 100, items: [{ id: '1', name: 'Кафе' }] } });
    } });
    const result = await retrievePlaceCandidates(client, intent(), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 1 });
    expect(result.coverage).toBe('PARTIAL');
    expect(result.places).toHaveLength(1);
    expect(result.searches[0]?.status).toBe('PROVIDER_ERROR');
    expect(result.searches[0]?.truncated).toBe(true);
  });

  it('rejects catalog mismatch or missing geographic scope before HTTP', async () => {
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => {
      calls++; throw new Error('must not call');
    } });
    await expect(retrievePlaceCandidates(client, intent(), { catalogVersion: 'v2', radiusMeters: 5000 })).rejects.toThrow('catalog');
    const altered = intent(); altered.points.origin.locality_id = 'other';
    await expect(retrievePlaceCandidates(client, altered, { catalogVersion: 'v1', radiusMeters: 5000 })).rejects.toThrow('locality');
    expect(calls).toBe(0);
  });
});
