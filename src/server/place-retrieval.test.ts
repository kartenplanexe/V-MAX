import { describe, expect, it, vi } from 'vitest';
import { DgisClient } from './dgis.js';
import { retrievePlaceCandidates } from './place-retrieval.js';

function intent() {
  const activity = { id: 'a1', categories: { state: 'matched', include_any: ['161', '162'], exclude: [], region_id: '32', catalog_version: 'v1' } };
  return { schema_version: 'confirmed-daily-intent.research.v1', locality: { id: 'mow', region_id: '32' },
    points: { origin: { lat: 55, lon: 37, locality_id: 'mow' } },
    days: [{ day_id: 'd1', activities: [activity] }, { day_id: 'd2', activities: [activity] }] };
}

describe('regional candidate retrieval', () => {
  it('separates walk types so incidental nearest POIs cannot crowd out a park, without expanding confirmed categories', async () => {
    const value = intent();
    value.days.splice(1);
    const walk = { ...value.days[0]!.activities[0]!, intent_kind: 'route_walk',
      categories: { ...value.days[0]!.activities[0]!.categories, include_any: ['161', '162', '163'], exclude: ['164'] } };
    value.days[0]!.activities = [walk];
    const queries: string[] = [];
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async url => {
      const ids = new URL(String(url)).searchParams.get('rubric_id')!; queries.push(ids);
      const rows = ids === '161,162,163' ? [{ id: 'board', name: 'Synthetic plaque' }]
        : [{ id: ids, name: ids === '161' ? 'Synthetic park' : 'Synthetic outdoor' }];
      return Response.json({ meta: { code: 200 }, result: { total: rows.length, items: rows } });
    } });
    const result = await retrievePlaceCandidates(client, value, { catalogVersion: 'v1', radiusMeters: 7000,
      pageSize: 20, maxPages: 2, maxRequests: 3, sort: 'distance',
      walkRubricScores: { '161': 2, '162': 1, '163': 0, '164': 2 } });
    expect(new Set(queries)).toEqual(new Set(['161', '162', '163']));
    expect(result.places.some(place => place.name === 'Synthetic park')).toBe(true);
    expect(result.requests).toBe(3);
    expect(result.searches.every(search => search.pages === 1)).toBe(true);
    expect(result.coverage).toBe('BOUNDED_RESULTS');
  });
  it.each([false, true])('continues past a full page with malformed rows (all rows invalid: %s) and reports partial coverage', async allInvalid => {
    const pages: number[] = [];
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async url => {
      const page = Number(new URL(String(url)).searchParams.get('page')); pages.push(page);
      const items = page === 1 ? [
        allInvalid ? { id: '1' } : { id: '1', name: 'Synthetic first cafe' }, { id: '2' },
      ] : [{ id: '3', name: 'Synthetic later cafe' }];
      return Response.json({ meta: { code: 200 }, result: { total: 3, items } });
    } });
    const result = await retrievePlaceCandidates(client, intent(), {
      catalogVersion: 'v1', radiusMeters: 5000, pageSize: 2, maxPages: 3,
    });
    expect(pages).toEqual([1, 2]);
    expect(result.places.map(place => place.id)).toEqual(allInvalid ? ['3'] : ['1', '3']);
    expect(result.coverage).toBe('PARTIAL');
    expect(result.searches[0]).toMatchObject({ status: 'OK', pages: 2, truncated: true,
      rejected_items: allInvalid ? 2 : 1, stop_reason: 'INVALID_ITEMS', failure_code: 'SCHEMA_RESULT_ITEMS___NAME' });
  });

  function groups(count = 2) {
    const value = intent();
    value.days.splice(1);
    value.days[0]!.activities = Array.from({ length: count }, (_, index) => ({
      id: `a${index}`, categories: { state: 'matched', include_any: [String(100 + index)], exclude: [], region_id: '32', catalog_version: 'v1' },
    }));
    return value;
  }

  it('queries seven singleton groups within thirty actual requests instead of reserving five pages for each', async () => {
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async url => {
      calls++; const id = new URL(String(url)).searchParams.get('rubric_id')!;
      return Response.json({ meta: { code: 200 }, result: { total: 1, items: [{ id, name: 'Synthetic' }] } });
    } });
    const result = await retrievePlaceCandidates(client, groups(7), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 5, maxPages: 5, maxRequests: 30 });
    expect(result.places).toHaveLength(7); expect(result.requests).toBe(7); expect(result.queries).toBe(7);
    expect(calls).toBe(7); expect(result.coverage).toBe('BOUNDED_RESULTS');
  });

  it('shares page opportunities round-robin and retains partial rows at the physical cap', async () => {
    const order: string[] = [];
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async url => {
      const query = new URL(String(url)).searchParams, key = `${query.get('rubric_id')}:${query.get('page')}`;
      order.push(key);
      return Response.json({ meta: { code: 200 }, result: { total: 10, items: [{ id: key, name: 'Synthetic' }] } });
    } });
    const result = await retrievePlaceCandidates(client, groups(), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 1, maxPages: 3, maxRequests: 3 });
    expect(order).toEqual(['100:1', '101:1', '100:2']);
    expect(result.requests).toBe(3); expect(result.places).toHaveLength(3); expect(result.coverage).toBe('PARTIAL');
    expect(result.searches.every(search => search.stop_reason === 'HTTP_BUDGET_EXHAUSTED')).toBe(true);
  });

  it('labels groups that could not get a first page without reporting an empty complete search', async () => {
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => {
      calls++; return Response.json({ meta: { code: 200 }, result: { total: 0, items: [] } });
    } });
    const result = await retrievePlaceCandidates(client, groups(4), { catalogVersion: 'v1', radiusMeters: 5000, maxPages: 5, maxRequests: 2 });
    expect(calls).toBe(2); expect(result.searches.filter(search => search.status === 'NOT_SEARCHED')).toHaveLength(2);
    expect(result.coverage).toBe('PARTIAL');
  });

  it('counts every successful fallback attempt and blocks the next one before dispatch at the cap', async () => {
    async function run(limit: number) {
      let calls = 0;
      const client = new DgisClient({ placesApiKey: 'synthetic-primary', routingApiKey: 'test', backupApiKey: 'synthetic-backup', tertiaryApiKey: 'synthetic-tertiary', fetchImpl: async () => {
        calls++; return calls < 3 ? new Response(null, { status: 403 }) : Response.json({ meta: { code: 200 }, result: { total: 1, items: [{ id: '1', name: 'Synthetic' }] } });
      } });
      const result = await retrievePlaceCandidates(client, groups(1), { catalogVersion: 'v1', radiusMeters: 5000, maxPages: 1, maxRequests: limit });
      return { calls, result };
    }
    const success = await run(3);
    expect(success.calls).toBe(3); expect(success.result.requests).toBe(3); expect(success.result.queries).toBe(1);
    expect(success.result.places).toHaveLength(1);
    const stopped = await run(2);
    expect(stopped.calls).toBe(2); expect(stopped.result.requests).toBe(2); expect(stopped.result.places).toEqual([]);
    expect(stopped.result.searches[0]).toMatchObject({ status: 'BUDGET_EXHAUSTED', stop_reason: 'HTTP_BUDGET_EXHAUSTED', attempts: 2 });
  });

  it('retains an earlier page when the next page exhausts the budget during fallback', async () => {
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'primary', routingApiKey: 'test', backupApiKey: 'backup', fetchImpl: async () => {
      calls++; return calls === 1 ? Response.json({ meta: { code: 200 }, result: { total: 3, items: [{ id: 'first', name: 'Synthetic' }] } }) : new Response(null, { status: 403 });
    } });
    const result = await retrievePlaceCandidates(client, groups(1), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 1, maxPages: 2, maxRequests: 2 });
    expect(calls).toBe(2); expect(result.places.map(place => place.id)).toEqual(['first']);
    expect(result.searches[0]).toMatchObject({ pages: 1, stop_reason: 'HTTP_BUDGET_EXHAUSTED' });
  });

  it('checks the shared deadline before initial dispatch and before fallback, preserving typed stop reasons', async () => {
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'primary', routingApiKey: 'test', backupApiKey: 'backup', fetchImpl: async () => {
      calls++; return new Response(null, { status: 403 });
    } });
    const base = { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 1, maxPages: 2, maxRequests: 5 };
    const before = await retrievePlaceCandidates(client, groups(1), { ...base, shouldContinue: () => false });
    expect(calls).toBe(0); expect(before.queries).toBe(0);
    expect(before.searches[0]).toMatchObject({ status: 'NOT_SEARCHED', stop_reason: 'DEADLINE_EXCEEDED' });
    const fallback = await retrievePlaceCandidates(client, groups(1), { ...base, shouldContinue: () => calls === 0 });
    expect(calls).toBe(1); expect(fallback.requests).toBe(1);
    expect(fallback.searches[0]).toMatchObject({ status: 'BUDGET_EXHAUSTED', stop_reason: 'DEADLINE_EXCEEDED' });
  });

  it('enforces its own monotonic deadline without an external coordinator hook', async () => {
    let elapsed = 0, calls = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => {
        calls++; elapsed = 90_000;
        return Response.json({ meta: { code: 200 }, result: { total: 2, items: [{ id: '1', name: 'Synthetic' }] } });
      } });
      const result = await retrievePlaceCandidates(client, groups(1), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 1, maxPages: 5 });
      expect(calls).toBe(1); expect(result.places).toHaveLength(1);
      expect(result.searches[0]?.stop_reason).toBe('DEADLINE_EXCEEDED');
      expect(result.coverage).toBe('PARTIAL');
    } finally { clock.mockRestore(); }
  });

  it('does not label an unknown-total short page or a repeated page exhaustive', async () => {
    const short = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => Response.json({ meta: { code: 200 }, result: { items: [{ id: '1', name: 'Synthetic' }] } }) });
    const uncertain = await retrievePlaceCandidates(short, groups(1), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 5 });
    expect(uncertain.coverage).toBe('PARTIAL'); expect(uncertain.searches[0]?.stop_reason).toBe('TOTAL_UNKNOWN');
    let calls = 0;
    const repeated = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => {
      calls++; return Response.json({ meta: { code: 200 }, result: { total: 3, items: [{ id: '1', name: 'Synthetic' }] } });
    } });
    const duplicate = await retrievePlaceCandidates(repeated, groups(1), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 1, maxPages: 5 });
    expect(calls).toBe(2); expect(duplicate.places).toHaveLength(1); expect(duplicate.coverage).toBe('PARTIAL');
    expect(duplicate.searches[0]?.stop_reason).toBe('REPEATED_PAGE');
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects malformed provider total %s without claiming a complete search', async total => {
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () =>
      Response.json({ meta: { code: 200 }, result: { total, items: total === 0.5 ? [{ id: '1', name: 'Synthetic' }] : [] } }),
    });
    const result = await retrievePlaceCandidates(client, groups(1), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 5 });
    expect(result.coverage).toBe('PARTIAL'); expect(result.places).toEqual([]); expect(result.requests).toBe(1);
    expect(result.searches[0]).toMatchObject({ status: 'PROVIDER_ERROR', failure_code: 'SCHEMA_RESULT_TOTAL' });
  });

  it('rejects a page whose known total is smaller than its unique rows', async () => {
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () =>
      Response.json({ meta: { code: 200 }, result: { total: 0, items: [{ id: '1', name: 'Synthetic' }] } }),
    });
    const result = await retrievePlaceCandidates(client, groups(1), { catalogVersion: 'v1', radiusMeters: 5000 });
    expect(result.coverage).toBe('PARTIAL'); expect(result.searches[0]?.status).toBe('PROVIDER_ERROR');
    expect(result.searches[0]?.failure_code).toBe('SCHEMA_RESULT_TOTAL');
  });

  it('preserves previously received places without completeness when cumulative unique rows exceed total', async () => {
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => {
      const ids = ++calls === 1 ? ['1', '2'] : ['3', '4'];
      return Response.json({ meta: { code: 200 }, result: { total: 3, items: ids.map(id => ({ id, name: 'Synthetic' })) } });
    } });
    const result = await retrievePlaceCandidates(client, groups(1), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 2, maxPages: 5 });
    expect(result.places).toHaveLength(4); expect(calls).toBe(2); expect(result.coverage).toBe('PARTIAL');
    expect(result.searches[0]).toMatchObject({ status: 'OK', truncated: true, stop_reason: 'RESULT_COUNT_INCONSISTENT' });
  });

  it('treats changing totals across pages as an inconsistent snapshot rather than exhaustive coverage', async () => {
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => {
      calls++;
      return Response.json({ meta: { code: 200 }, result: { total: calls === 1 ? 2 : 3, items: [{ id: String(calls), name: 'Synthetic' }] } });
    } });
    const result = await retrievePlaceCandidates(client, groups(1), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 1, maxPages: 5 });
    expect(calls).toBe(2); expect(result.places).toHaveLength(2); expect(result.coverage).toBe('PARTIAL');
    expect(result.searches[0]?.stop_reason).toBe('RESULT_COUNT_INCONSISTENT');
  });

  it.each([true, false])('retains valid earlier pages when a later total becomes invalid or missing (invalid=%s)', async invalid => {
    let calls = 0;
    const client = new DgisClient({ placesApiKey: 'test', routingApiKey: 'test', fetchImpl: async () => {
      calls++;
      const total = calls === 1 ? { total: 2 } : invalid ? { total: 0 } : {};
      return Response.json({ meta: { code: 200 }, result: { ...total, items: [{ id: String(calls), name: 'Synthetic' }] } });
    } });
    const result = await retrievePlaceCandidates(client, groups(1), { catalogVersion: 'v1', radiusMeters: 5000, pageSize: 1, maxPages: 5 });
    expect(calls).toBe(2); expect(result.places.map(place => place.id)).toEqual(invalid ? ['1'] : ['1', '2']);
    expect(result.coverage).toBe('PARTIAL');
    expect(result.searches[0]?.stop_reason).toBe(invalid ? 'PROVIDER_ERROR' : 'TOTAL_UNKNOWN');
  });

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
    expect(calls).toBe(2);
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
    expect(result.searches[0]?.failure_code).toBe('HTTP_503');
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
