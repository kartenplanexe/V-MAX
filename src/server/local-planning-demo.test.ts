import { expect, it } from 'vitest';
import { createLocalPlanningDemo } from './local-planning-demo.js';

it('keeps demo bootstrap same-origin, isolates browser owners, and exposes no map key', async () => {
  const app = createLocalPlanningDemo();
  const headers = { host: '127.0.0.1:4174', origin: 'http://127.0.0.1:4174' };
  try {
    expect((await app.inject({ method: 'POST', url: '/api/demo/session', headers: { ...headers, origin: 'https://other.test' }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/demo/session', headers: { ...headers, host: 'other.test' }, payload: {} })).statusCode).toBe(403);
    const a = (await app.inject({ method: 'POST', url: '/api/demo/session', headers, payload: {} })).json();
    const b = (await app.inject({ method: 'POST', url: '/api/demo/session', headers, payload: {} })).json();
    expect(a.view.capabilities.data_mode).toBe('test');
    expect(a.token).not.toEqual(b.token);
    expect((await app.inject({ url: `/api/planning/drafts/${a.view.id}`, headers: { ...headers, authorization: `Bearer ${b.token}` } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/public-config', headers })).json()).toEqual({ maps: { enabled: false } });
  } finally { await app.close(); }
});

it('runs text → validated draft → typed correction → real Python plan without a second parser call', async () => {
  const app = createLocalPlanningDemo();
  const headers = { host: '127.0.0.1:4174', origin: 'http://127.0.0.1:4174' };
  try {
    const bootstrap = (await app.inject({ method: 'POST', url: '/api/demo/bootstrap', headers, payload: {} })).json();
    expect(bootstrap.view).toBeNull(); expect(bootstrap.examples.length).toBeGreaterThan(1);
    const auth = { ...headers, authorization: `Bearer ${bootstrap.token}` };
    const payload = { event_id: 'initial-integration', user_text: bootstrap.examples[0] };
    const start = await app.inject({ method: 'POST', url: '/api/planning/requests', headers: auth, payload });
    expect(start.statusCode).toBe(200);
    const first = start.json(); expect(first.status).toBe('draft');
    const base = `/api/planning/drafts/${first.view.id}`;
    expect(first.view.issues.map((i: { code: string }) => i.code)).toContain('ORIGIN_REQUIRED');
    const edit = (await app.inject({ method: 'PATCH', url: base, headers: auth, payload: { base_version: first.view.version,
      event_id: 'typed-origin-edit', changes: [{ op: 'point', field: 'origin', point: { lat: 55.75, lon: 37.62, label: 'Старт', source: 'place_choice' } }] } })).json();
    const confirmed = (await app.inject({ method: 'POST', url: base + '/confirm', headers: auth, payload: { base_version: edit.version, event_id: 'confirm-integration' } })).json();
    const calculated = await app.inject({ method: 'POST', url: base + '/plan', headers: auth, payload: { base_version: confirmed.version, event_id: 'plan-integration' } });
    expect(calculated.statusCode).toBe(200);
    expect(calculated.json().result.status).toBe('AVAILABLE');
    expect(calculated.json().result.days[0].visits.map((v: { name: string }) => v.name)).toEqual(['Учебный музей', 'Учебное кафе']);
    const repeated = (await app.inject({ method: 'POST', url: '/api/planning/requests', headers: auth, payload })).json();
    expect(repeated.view.id).toBe(first.view.id); expect(repeated.view.phase).toBe('RESULT');
    expect((await app.inject({ method: 'POST', url: '/api/planning/requests', headers, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/planning/requests', headers: auth, payload: { ...payload, event_id: 'injection-test', catalog: {} } })).statusCode).toBe(400);
  } finally { await app.close(); }
}, 30_000);
