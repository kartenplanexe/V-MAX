import { expect, it } from 'vitest';
import { KudagoClient, EventRequestBudgetError } from './kudago.js';

const now = Date.parse('2026-09-27T09:00:00Z'), start = now / 1000 + 86400;
const scope = { location: 'nnv', starts_at: start, ends_at: start + 2 * 86400 };
function event(id = 1) { return { id, title: 'Synthetic event', site_url: `https://kudago.com/nnv/event/test-${id}/`,
  dates: [{ start, end: start + 3600, is_startless: false, is_endless: false, is_continuous: false, use_place_schedule: false, schedules: [] }],
  place: { id: 10, title: 'Test place', coords: { lat: 56.3, lon: 44 }, is_closed: false } }; }
const page = (items: unknown[], count = items.length, next: string | null = null) => new Response(JSON.stringify({ count, next, results: items }));

it('uses a fixed documented HTTPS endpoint, projected fields, server scope, physical request hook and bounded freshness', async () => {
  const urls: URL[] = [], inits: RequestInit[] = []; let consumed = 0;
  const client = new KudagoClient({ now: () => now, fetcher: async (url, init) => { urls.push(new URL(String(url))); inits.push(init!); return page([event()]); } });
  const result = await client.search(scope, { requestBudget: { consume() { consumed++; } } });
  expect(result).toMatchObject({ coverage: 'BOUNDED_RESULTS', stop_reason: 'RESULTS_EXHAUSTED', attempts: 1, pages: 1 });
  expect(result.items[0]?.source.valid_until).toBe(new Date(now + 300000).toISOString());
  expect(consumed).toBe(1); expect(urls[0]?.hostname).toBe('kudago.com');
  expect(urls[0]?.searchParams.get('expand')).toBe('dates,place');
  expect(urls[0]?.searchParams.get('location')).toBe('nnv');
  expect(urls[0]?.searchParams.get('fields')).not.toMatch(/body_text|description|images/u);
  expect(inits[0]?.redirect).toBe('error');
  expect(result.items[0]?.media).toEqual([]);
});
it('never dispatches outside supported locality, validated time scope or exhausted external budget', async () => {
  let attempts = 0;
  const client = new KudagoClient({ fetcher: async () => { attempts++; return page([]); } });
  expect(await client.search({ ...scope, location: 'unmapped-city' })).toMatchObject({ coverage: 'UNSUPPORTED_LOCALITY', attempts: 0 });
  await expect(client.search({ ...scope, ends_at: start + 32 * 86400 })).rejects.toThrow();
  expect(await client.search(scope, { requestBudget: { consume() { throw new EventRequestBudgetError('HTTP_BUDGET_EXHAUSTED'); } } }))
    .toMatchObject({ coverage: 'PARTIAL', stop_reason: 'HTTP_BUDGET_EXHAUSTED', attempts: 0 });
  expect(attempts).toBe(0);
});
it('keeps successful rows when physical cap, deadline or provider failure stops the next page', async () => {
  for (const reason of ['HTTP_BUDGET_EXHAUSTED', 'DEADLINE_EXCEEDED', 'PROVIDER_ERROR'] as const) {
    let attempts = 0;
    const client = new KudagoClient({ fetcher: async () => { attempts++; if (attempts === 2) return new Response('', { status: 503 });
      return page([event(1)], 2, 'https://evil.test/never-fetch'); } });
    const options = { pageSize: 1, maxRequests: reason === 'HTTP_BUDGET_EXHAUSTED' ? 1 : 4,
      shouldContinue: () => reason !== 'DEADLINE_EXCEEDED' || attempts === 0 };
    const result = await client.search(scope, options);
    expect(result.items).toHaveLength(1); expect(result.stop_reason).toBe(reason); expect(result.coverage).toBe('PARTIAL');
    expect(attempts).toBe(reason === 'PROVIDER_ERROR' ? 2 : 1);
  }
});
it('builds subsequent URLs locally, deduplicates and distinguishes changing totals from complete coverage', async () => {
  const seen: string[] = [];
  const client = new KudagoClient({ fetcher: async url => {
    seen.push(String(url)); return seen.length === 1 ? page([event(1)], 2, 'https://evil.test/never-fetch') : page([event(2)], 2); } });
  const result = await client.search(scope, { pageSize: 1 });
  expect(result.items).toHaveLength(2); expect(result.coverage).toBe('BOUNDED_RESULTS');
  expect(new URL(seen[1]!).hostname).toBe('kudago.com'); expect(new URL(seen[1]!).searchParams.get('page')).toBe('2');
  let calls = 0;
  const changing = await new KudagoClient({ fetcher: async () => ++calls === 1 ? page([event(1)], 2, '/next') : page([event(2)], 3, '/next') })
    .search(scope, { pageSize: 1 });
  expect(changing).toMatchObject({ coverage: 'PARTIAL', stop_reason: 'RESULT_COUNT_INCONSISTENT', attempts: 2 });
  const duplicate = await new KudagoClient({ fetcher: async () => page([event(1)], 2, '/next') }).search(scope, { pageSize: 1 });
  expect(duplicate).toMatchObject({ coverage: 'PARTIAL', stop_reason: 'REPEATED_PAGE', attempts: 2 });
});
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 0])('does not certify invalid totals %s', async count => {
  const result = await new KudagoClient({ fetcher: async () => page([event(1)], count) }).search(scope);
  expect(result.coverage).toBe('PARTIAL');
});
it('retains valid cards but reports rejected rows and local date filtering', async () => {
  const outside = event(2); outside.dates[0]!.start -= 3 * 86400; outside.dates[0]!.end -= 3 * 86400;
  const result = await new KudagoClient({ fetcher: async () => page([event(1), outside, { ...event(3), site_url: 'https://attacker.test/' }]) }).search(scope);
  expect(result.items.map(item => item.provider_event_id)).toEqual([1]);
  expect(result).toMatchObject({ coverage: 'PARTIAL', rejected: 1, outside_scope: 1, stop_reason: 'PROVIDER_SCHEMA_ERROR' });
});
it('counts network failures once, caps the body, and rejects redirects without following provider-supplied links', async () => {
  for (const response of [null, new Response('x'.repeat(1048577)), new Response('', { status: 302, headers: { location: 'https://evil.test/' } })]) {
    let calls = 0;
    const result = await new KudagoClient({ fetcher: async () => { calls++; if (!response) throw new Error('PRIVATE_RAW_FAILURE'); return response; } }).search(scope);
    expect(result.coverage).toBe('PARTIAL'); expect(result.attempts).toBe(1); expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_RAW_FAILURE');
  }
});
it('gets independently bounded venue details, checks ID identity and returns timetable facts only', async () => {
  let consumed = 0;
  const client = new KudagoClient({ now: () => now, fetcher: async url => {
    expect(new URL(String(url)).pathname).toBe('/public-api/v1.4/places/10/');
    return new Response(JSON.stringify({ id: 10, title: 'Synthetic place', site_url: 'https://kudago.com/nnv/place/test/',
      is_closed: false, coords: { lat: 56.3, lon: 44 }, timetable: 'ежедневно 10:00\u201319:00', body_text: 'PRIVATE EXTRA' })); } });
  const result = await client.getVenue(10, { requestBudget: { consume() { consumed++; } } });
  expect(result.status).toBe('OK'); expect(result.venue?.hours.state).toBe('KNOWN'); expect(consumed).toBe(1);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  const mismatch = await new KudagoClient({ fetcher: async () => new Response(JSON.stringify({ id: 20 })) }).getVenue(10);
  expect(mismatch).toMatchObject({ status: 'UNAVAILABLE', reason: 'PROVIDER_SCHEMA_ERROR', venue: null });
});
it('keeps budgets local when a shared client searches concurrently', async () => {
  const client = new KudagoClient({ fetcher: async url => {
    const pageNumber = Number(new URL(String(url)).searchParams.get('page'));
    return page([event(pageNumber)], 2, pageNumber === 1 ? '/next' : null); } });
  const [a, b] = await Promise.all([client.search(scope, { maxRequests: 1, pageSize: 1 }), client.search(scope, { maxRequests: 3, pageSize: 1 })]);
  expect(a).toMatchObject({ attempts: 1, coverage: 'PARTIAL' });
  expect(b).toMatchObject({ attempts: 2, coverage: 'BOUNDED_RESULTS' });
});
it('loads a selected event by verified numeric identity with the same caps and rejects a mismatched response', async () => {
  let calls = 0;
  const client = new KudagoClient({ now: () => now, fetcher: async url => {
    calls++; const parsed = new URL(String(url)); expect(parsed.pathname).toBe('/public-api/v1.4/events/7/');
    expect(parsed.searchParams.get('expand')).toBe('dates,place'); return new Response(JSON.stringify(event(7))); } });
  const found = await client.getEvent('7');
  expect(found).toMatchObject({ status: 'OK', attempts: 1, event: { provider_event_id: 7 } });
  await expect(client.getEvent('../places/7')).rejects.toThrow(); expect(calls).toBe(1);
  const denied = await client.getEvent('7', { requestBudget: { consume() { throw new EventRequestBudgetError('DEADLINE_EXCEEDED'); } } });
  expect(denied).toMatchObject({ status: 'UNAVAILABLE', reason: 'DEADLINE_EXCEEDED', attempts: 0 }); expect(calls).toBe(1);
  const wrong = await new KudagoClient({ fetcher: async () => new Response(JSON.stringify(event(8))) }).getEvent('7');
  expect(wrong).toMatchObject({ status: 'UNAVAILABLE', event: null, reason: 'PROVIDER_SCHEMA_ERROR' });
});
