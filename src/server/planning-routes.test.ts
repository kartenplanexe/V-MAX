import Fastify from 'fastify';
import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { PlanningSessions } from './planning-sessions.js';
import { registerPlanningRoutes, maxPlanningAuthenticator } from './planning-routes.js';
import { demoNow, planningFixture } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';

const now = Math.floor(demoNow().getTime() / 1000);
function signed(id: number, age = 0) {
  const entries = [['auth_date', String(now - age)], ['user', JSON.stringify({ id, first_name: 'Тест' })]];
  const key = createHmac('sha256', 'WebAppData').update('test-token').digest();
  const hash = createHmac('sha256', key).update(entries.map(e => e.join('=')).join('\n')).digest('hex');
  return String(new URLSearchParams([...entries, ['hash', hash]]));
}
it('protects all form endpoints with signed MAX ownership and runs the confirmed HTTP workflow', async () => {
  const fixture = planningFixture();
  const sessions = new PlanningSessions({ now: demoNow, plan: job => planPlacesWithDgis(fixture.client(), job,
    { retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test', now: demoNow }) });
  const draft = sessions.create('max:42', fixture.input.intent, { catalog: fixture.input.catalog,
    visit_policy: fixture.input.visit_policy, modes: ['walking'], data_mode: 'test' });
  const app = Fastify({ bodyLimit: 32 * 1024 });
  const changed: Array<{ owner: string; status: string }> = [];
  registerPlanningRoutes(app, sessions, maxPlanningAuthenticator('test-token', 3600, () => now),
    async (owner, view) => { changed.push({ owner, status: view.status }); });
  const path = `/api/planning/drafts/${draft.id}`;
  try {
    for (const [method, suffix] of [['GET', ''], ['PATCH', ''], ['POST', '/confirm'], ['POST', '/plan'],
      ['POST', '/alternatives/preview'], ['POST', '/alternatives/apply']] as const) {
      expect((await app.inject({ method, url: path + suffix, headers: { 'x-max-init-data': signed(42, 3601) } })).statusCode).toBe(401);
      expect((await app.inject({ method, url: path + suffix, headers: { 'x-max-init-data': signed(43) },
        ...(method !== 'GET' ? { payload: { base_version: 0, event_id: 'test-0001' } } : {}) })).statusCode).toBe(404);
    }
    expect((await app.inject({ url: path, headers: { 'x-max-init-data': signed(42) + 'tampered' } })).statusCode).toBe(401);
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    expect((await app.inject({ url: path, headers: { authorization: `max ${signed(42)}` } })).statusCode).toBe(401);
    const get = await app.inject({ url: path, headers: { 'x-max-init-data': signed(42) } });
    expect(get.headers['cache-control']).toBe('no-store');
    expect(get.json().id).toBe(draft.id);
    const edit = await app.inject({ method: 'PATCH', url: path, headers: { 'x-max-init-data': signed(42) },
      payload: { base_version: 0, event_id: 'test-0001', changes: [{ op: 'window', day_ids: ['d1'], start: '16:30', end: '20:00' }] } });
    expect(edit.statusCode).toBe(200);
    expect(changed).toEqual([{ owner: 'max:42', status: edit.json().status }]);
    const confirm = await app.inject({ method: 'POST', url: path + '/confirm', headers: { 'x-max-init-data': signed(42) },
      payload: { base_version: edit.json().version, event_id: 'test-0002' } });
    expect(confirm.statusCode).toBe(200);
    const options = { method: 'POST' as const, url: path + '/plan', headers: { 'x-max-init-data': signed(42) },
      payload: { base_version: confirm.json().version, event_id: 'test-0003' } };
    const result = await app.inject(options);
    expect(result.statusCode).toBe(200);
    expect(result.json().result.days[0].visits[0].starts_at).toBeGreaterThanOrEqual(16 * 60 + 30);
    expect(result.json().result).not.toHaveProperty('routing');
    expect(changed).toHaveLength(2);
    expect(changed[1]).toEqual({ owner: 'max:42', status: result.json().status });
    const calls = fixture.requests.length;
    await app.inject(options);
    expect(fixture.requests.length).toBe(calls);
    expect((await app.inject({ method: 'POST', url: '/api/planning/drafts', headers: { 'x-max-init-data': signed(42) },
      payload: fixture.input.intent })).statusCode).toBe(404);
  } finally { await app.close(); }
}, 30_000);

it('previews and applies a replacement through authenticated HTTP without changing the plan before consent', async () => {
  const f = planningFixture(); f.input.intent.days[0]!.window.end = '23:00';
  const sessions = new PlanningSessions({ now: demoNow, plan: job => planPlacesWithDgis(f.client(), job,
    { retrieval: { radiusMeters: 5000 }, dataMode: 'test', now: demoNow }) });
  const draft = sessions.create('max:42', f.input.intent, { catalog: f.input.catalog,
    visit_policy: f.input.visit_policy, modes: ['walking'], data_mode: 'test' });
  const confirm = sessions.confirm('max:42', draft.id, { event_id: 'http-confirm', base_version: draft.version });
  const planned = await sessions.calculate('max:42', draft.id, { event_id: 'http-calculate', base_version: confirm.version });
  const app = Fastify(), changed: string[] = [], headers = { 'x-max-init-data': signed(42) };
  registerPlanningRoutes(app, sessions, maxPlanningAuthenticator('test-token', 3600, () => now),
    async (_owner, view) => { changed.push(view.id); });
  const path = `/api/planning/drafts/${draft.id}`;
  try {
    const body = { event_id: 'http-preview', base_version: planned.version, day_id: 'd1', activity_id: 'culture', place_id: 'near' };
    const before = f.requests.length;
    const foreign = await app.inject({ method: 'POST', url: path + '/alternatives/preview',
      headers: { 'x-max-init-data': signed(43) }, payload: {} });
    expect(foreign.statusCode).toBe(404); expect(f.requests).toHaveLength(before);
    const preview = await app.inject({ method: 'POST', url: path + '/alternatives/preview', headers, payload: body });
    expect(preview.statusCode).toBe(200); expect(preview.headers['cache-control']).toBe('no-store');
    const alternate = preview.json().alternatives[0];
    expect(alternate.result.days[0].visits.map((visit: { place_id: string }) => visit.place_id)).toEqual(['far', 'cafe']);
    expect((await app.inject({ url: path, headers })).json().result).toEqual(planned.result);
    expect(changed).toEqual([]);
    const afterPreview = f.requests.length;
    const apply = { method: 'POST' as const, url: path + '/alternatives/apply', headers,
      payload: { event_id: 'http-apply', base_version: planned.version, alternative_id: alternate.id } };
    const applied = await app.inject(apply);
    expect(applied.statusCode).toBe(200); expect(applied.json().result).toEqual(alternate.result);
    expect(applied.json().version).toBe(planned.version + 1); expect(changed).toEqual([draft.id]);
    expect((await app.inject(apply)).json()).toEqual(applied.json());
    expect(f.requests).toHaveLength(afterPreview);
  } finally { await app.close(); }
}, 30_000);
