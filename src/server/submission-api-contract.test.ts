import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect, it } from 'vitest';
import { buildOpenApi, buildDataApi, serializeContract } from '../../scripts/api-contract.mts';
import { PlanningSessions, type PlanningContext } from './planning-sessions.js';
import { registerPlanningRoutes, maxPlanningAuthenticator } from './planning-routes.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';
import { SavedConditionsViewSchema } from '../shared/saved-conditions.js';
import { projectSavedConditions, remapSavedConditions } from './saved-conditions.js';
import { intentFixture } from './intent-start.fixture.js';

const root = new URL('../../', import.meta.url);
const openapi = JSON.parse(readFileSync(new URL('openapi.yaml', root), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('DATA-API.yaml', root), 'utf8'));

function localRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(localRefs);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === '$ref' && typeof item === 'string' ? item.replace('#/components/schemas/', '#/$defs/') : localRefs(item)]));
  return value;
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
function validateResponse(path: string, method: string, status: number, value: unknown) {
  const operation = openapi.paths[path][method];
  const response = operation.responses[String(status)];
  expect(response, `${method} ${path}: undocumented HTTP ${status}`).toBeDefined();
  const validate = ajv.compile(localRefs({ ...response.content['application/json'].schema, $defs: openapi.components.schemas }) as object);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

it('keeps both submission manifests current and all required API checks resolvable', () => {
  expect(readFileSync(new URL('openapi.yaml', root), 'utf8')).toBe(serializeContract(buildOpenApi()));
  expect(readFileSync(new URL('DATA-API.yaml', root), 'utf8')).toBe(serializeContract(buildDataApi()));
  expect(openapi.openapi).toBe('3.1.0');
  expect(manifest.base_url).toMatch(/^https:\/\//u);
  expect(manifest.revision).toMatchObject({ status: 'source_archive', commit: null });
  const ids = new Set();
  for (const check of manifest.checks) {
    expect(ids.has(check.id)).toBe(false); ids.add(check.id);
    expect(check.required).toBe(true);
    expect(openapi.paths[check.path]?.[check.method.toLowerCase()]).toBeDefined();
    expect(check.role).toMatch(/^(anonymous|max_user)$/u);
    expect(check.expected.status_codes.length).toBeGreaterThan(0);
    expect(check.expected.content_type).toBe('application/json');
    ajv.compile(localRefs({ ...check.expected.schema, $defs: openapi.components.schemas }) as object);
  }
  for (const [path, methods] of Object.entries(openapi.paths) as [string, Record<string, any>][]) {
    for (const [method, operation] of Object.entries(methods)) {
      expect(operation.operationId).toBeTruthy();
      for (const response of Object.values(operation.responses) as any[])
        ajv.compile(localRefs({ ...response.content['application/json'].schema, $defs: openapi.components.schemas }) as object);
      if (operation.requestBody)
        ajv.compile(localRefs({ ...operation.requestBody.content['application/json'].schema, $defs: openapi.components.schemas }) as object);
      if (path.startsWith('/api/planning/')) expect(operation.security).toEqual([{ MaxInitData: [] }]);
      expect(['get', 'post', 'patch']).toContain(method);
    }
  }
  const testData = JSON.parse(readFileSync(new URL(manifest.test_data_file, root), 'utf8'));
  expect(testData.data_mode).toBe('test');
  expect(testData.cases.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['walk', 'walk-then-eat', 'insufficient-time', 'saved-route']));
  for (const status of [401, 404]) expect(openapi.paths['/api/planning/saved/{id}'].get.responses[status]).toBeDefined();
  for (const status of [400, 401, 404, 409, 422]) expect(openapi.paths['/api/planning/saved/{id}/restore'].post.responses[status]).toBeDefined();
  expect(ids).toContain('read-saved'); expect(ids).toContain('restore-saved');
}, 30_000);

it('documents real saved-condition projection/remap outputs and both expired bootstrap forms', () => {
  const fixture = planningFixture();
  const planning: PlanningContext = { catalog: fixture.input.catalog,
    visit_policy: fixture.input.visit_policy, modes: ['walking'], data_mode: 'test' };
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => { throw new Error('This check must not calculate or call a provider'); } });
  const view = sessions.create('max:42', fixture.input.intent, planning);
  view.draft.days[0]!.activities[0]!.label = 'музей';
  view.draft.days[0]!.activities[0]!.selection.named_types = ['Музеи'];
  view.draft.days[0]!.activities[1]!.label = 'поесть';
  const saved = SavedConditionsViewSchema.parse({ id: view.id, revision: view.version,
    expires_at: '2026-10-24T09:30:00Z', conditions: projectSavedConditions(view, { now: demoNow() }) });
  validateResponse('/api/planning/saved/{id}', 'get', 200, saved);
  validateResponse('/api/planning/bootstrap', 'get', 200, { view: null });
  validateResponse('/api/planning/bootstrap', 'get', 200, { view: null, expiredRoute: 'Синтетический маршрут' });
  validateResponse('/api/planning/bootstrap', 'get', 200, { view: null, expiredRoute: 'Синтетический маршрут', saved });
  const remapped = remapSavedConditions(saved.conditions, { ...intentFixture().context, planning });
  expect(remapped.status).toBe('RESTORABLE');
  if (remapped.status !== 'RESTORABLE') throw new Error('The authored exact-category fixture should remap');
  const restored = sessions.create('max:42', remapped.draft, planning, remapped.provenance);
  validateResponse('/api/planning/saved/{id}/restore', 'post', 200, restored);
  expect(restored).toMatchObject({ phase: 'DRAFT', confirmed_version: null, result: null });
  expect(restored.issues.some(issue => issue.code === 'ORIGIN_REQUIRED')).toBe(true);

});

it('validates actual draft HTTP success/error responses against the submitted OpenAPI schemas offline', async () => {
  const fixture = planningFixture(), now = Math.floor(demoNow().getTime() / 1000);
  const sessions = new PlanningSessions({ now: demoNow, plan: job => planPlacesWithDgis(fixture.client(), job,
    { retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test', now: demoNow }) });
  const draft = sessions.create('max:42', fixture.input.intent, { catalog: fixture.input.catalog,
    visit_policy: fixture.input.visit_policy, modes: ['walking'], data_mode: 'test' });
  const params = new URLSearchParams({ auth_date: String(now), user: JSON.stringify({ id: 42, first_name: 'Synthetic contract test' }) });
  const signatureKey = createHmac('sha256', 'WebAppData').update('offline-contract-test-only').digest();
  const hash = createHmac('sha256', signatureKey).update([...params].sort(([a], [b]) => a.localeCompare(b)).map(e => e.join('=')).join('\n')).digest('hex');
  params.set('hash', hash);
  const headers = { 'x-max-init-data': String(params) };
  const app = Fastify();

  const httpService = Object.assign(sessions, {
    getSaved: () => { throw new Error('Unauthenticated request reached saved storage'); },
    restore: async () => { throw new Error('Unauthenticated request reached saved restore'); },
  });
  registerPlanningRoutes(app, httpService, maxPlanningAuthenticator('offline-contract-test-only', 3600, () => now));
  const path = `/api/planning/drafts/${draft.id}`, contractPath = '/api/planning/drafts/{id}';
  try {
    const unsigned = await app.inject({ url: path });
    expect(unsigned.statusCode).toBe(401); validateResponse(contractPath, 'get', 401, unsigned.json());
    const unsignedSaved = await app.inject({ url: `/api/planning/saved/${draft.id}` });
    expect(unsignedSaved.statusCode).toBe(401); validateResponse('/api/planning/saved/{id}', 'get', 401, unsignedSaved.json());
    const unsignedRestore = await app.inject({ method: 'POST', url: `/api/planning/saved/${draft.id}/restore`, payload: {} });
    expect(unsignedRestore.statusCode).toBe(401); validateResponse('/api/planning/saved/{id}/restore', 'post', 401, unsignedRestore.json());
    const missing = await app.inject({ url: '/api/planning/drafts/missing', headers });
    expect(missing.statusCode).toBe(404); validateResponse(contractPath, 'get', 404, missing.json());
    const get = await app.inject({ url: path, headers });
    expect(get.statusCode).toBe(200); validateResponse(contractPath, 'get', 200, get.json());
    const invalid = await app.inject({ method: 'PATCH', url: path, headers, payload: {} });
    expect(invalid.statusCode).toBe(400); validateResponse(contractPath, 'patch', 400, invalid.json());
    const malformed = await app.inject({ method: 'PATCH', url: path, headers: { ...headers, 'content-type': 'application/json' }, payload: '{' });
    expect(malformed.statusCode).toBe(400); validateResponse(contractPath, 'patch', 400, malformed.json());
    const edited = await app.inject({ method: 'PATCH', url: path, headers, payload: {
      base_version: get.json().version, event_id: 'contract-edit', changes: [{ op: 'window', day_ids: ['d1'], start: '16:00', end: '20:00' }] } });
    expect(edited.statusCode).toBe(200); validateResponse(contractPath, 'patch', 200, edited.json());
    const stale = await app.inject({ method: 'POST', url: path + '/confirm', headers, payload: { base_version: 0, event_id: 'contract-stale' } });
    expect(stale.statusCode).toBe(409); validateResponse(contractPath + '/confirm', 'post', 409, stale.json());
    const confirmed = await app.inject({ method: 'POST', url: path + '/confirm', headers, payload: { base_version: edited.json().version, event_id: 'contract-confirm' } });
    expect(confirmed.statusCode).toBe(200); validateResponse(contractPath + '/confirm', 'post', 200, confirmed.json());
    const planned = await app.inject({ method: 'POST', url: path + '/plan', headers, payload: { base_version: confirmed.json().version, event_id: 'contract-plan' } });
    expect(planned.statusCode).toBe(200); validateResponse(contractPath + '/plan', 'post', 200, planned.json());
    expect(planned.json().result.days.some((d: { visits: unknown[] }) => d.visits.length > 0)).toBe(true);
    expect(planned.json().result.data_mode).toBe('test');

    expect(planned.json().result.search_scope).toMatchObject({ radius_meters: 5000 });
    expect(['PARTIAL', 'BOUNDED_RESULTS']).toContain(planned.json().result.search_scope.coverage);
    const refresh = { base_version: planned.json().version, event_id: 'contract-explicit-refresh', refresh: true };
    const requestSchema = openapi.paths[contractPath + '/plan'].post.requestBody.content['application/json'].schema;
    const validateRequest = ajv.compile(localRefs({ ...requestSchema, $defs: openapi.components.schemas }) as object);
    expect(validateRequest(refresh), JSON.stringify(validateRequest.errors)).toBe(true);
    const refreshed = await app.inject({ method: 'POST', url: path + '/plan', headers, payload: refresh });
    expect(refreshed.statusCode).toBe(200); validateResponse(contractPath + '/plan', 'post', 200, refreshed.json());
    expect(refreshed.json().draft).toEqual(planned.json().draft);
    expect(refreshed.json().version).toBe(planned.json().version + 1);
    expect(refreshed.json().result.status).toBe('AVAILABLE');
    const afterRefresh = fixture.requests.length;
    const replay = await app.inject({ method: 'POST', url: path + '/plan', headers, payload: refresh });
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(refreshed.json());
    const staleRefresh = await app.inject({ method: 'POST', url: path + '/plan', headers, payload: { ...refresh, event_id: 'contract-stale-refresh' } });
    expect(staleRefresh.statusCode).toBe(409); expect(staleRefresh.json()).toMatchObject({ error: 'STALE_VERSION' });
    expect(fixture.requests).toHaveLength(afterRefresh);
  } finally { await app.close(); }
}, 30_000);
