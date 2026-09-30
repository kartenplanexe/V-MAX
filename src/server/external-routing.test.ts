import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { defaultPlannerPython } from './planner-process.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis, safePlanningDiagnostic } from './place-planning.js';
import { PublicPlan } from '../shared/planning-form.js';
import { PlanningSessions } from './planning-sessions.js';
import { formatChatPlanMessages } from './max-chat.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CandidatePlaces } from '../client/CandidatePlaces.js';

it.skipIf(!existsSync(defaultPlannerPython()))('returns both activity groups, preserves points across reopen and spends no Routing quota', async () => {
  const f = planningFixture();
  f.input.intent.days[0]!.activities[0]!.label = 'Прогулка';
  f.input.intent.days[0]!.activities[1]!.label = 'Поесть';
  const raw = await planPlacesWithDgis(f.client(async (url, init) => {
    if (new URL(String(url)).hostname !== 'catalog.api.2gis.com') throw Error('ROUTING_MUST_NOT_BE_CALLED');
    return f.defaultFetch(url, init);
  }), f.input, { now: demoNow, dataMode: 'test', routingMode: 'external', includeGeometry: true,
    maxRoutePairs: 1, maxRoutingHttpCalls: 1, retrieval: { radiusMeters: 5000, maxPages: 1 },
    consumeRoutingQuota: async () => { throw Error('QUOTA_MUST_NOT_BE_CONSUMED'); } });
  const result = PublicPlan.parse(raw);
  expect(result.status).toBe('PLACES_FOUND');
  expect(result.days).toEqual([]);
  expect(result.candidate_preview?.groups.map(group => group.activity_id)).toEqual(['culture', 'food']);
  expect(result.candidate_preview?.groups[0]?.places[0]?.point).toEqual(f.items[0]!.point);
  expect(safePlanningDiagnostic(raw)).toMatchObject({ status: 'PLACES_FOUND', routing_http_calls: 0, route_pair_calculations: 0 });
  expect(f.routingBatches()).toBe(0);
  expect(f.requests.length).toBeGreaterThan(0);
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => result });
  const view = sessions.create('synthetic', f.input.intent, { catalog: f.input.catalog,
    visit_policy: { ...f.input.visit_policy, walkable_category_ids: ['100'] }, data_mode: 'test', modes: ['walking'] });
  const confirmed = sessions.confirm('synthetic', view.id, { base_version: view.version, event_id: 'confirm-external' });
  await sessions.calculate('synthetic', view.id, { base_version: confirmed.version, event_id: 'calculate-external' });
  const restarted = new PlanningSessions({ now: demoNow, checkpoint: sessions.checkpoint(), plan: async () => { throw Error('NO_RECALC'); } });
  const restored = restarted.get('synthetic', view.id);
  expect(restored.result).toEqual(result);
  const text = formatChatPlanMessages(restored).map(message => message.text).join('\n');
  expect(text).toContain('Подобрал варианты мест');
  expect(text).toContain('directions/tab/pedestrian/points/');
  expect(text).toContain('Подборка сохранена');
  expect(text).not.toContain('Срок результата в приложении');
  expect(text).not.toMatch(/План помещается|В пути \d|Готово - вот план/);
}, 20000);

it.skipIf(!existsSync(defaultPlannerPython()))('the confirmed walk policy reserves a meal and adds walk stops only when there is spare time', async () => {
  for (const end of ['18:00', '19:00']) {
    const f = planningFixture();
    f.input.intent.days[0]!.window.end = end;
    f.input.intent.days[0]!.activities[0]!.label = 'прогулка';
    f.input.visit_policy.by_category['200'] = 60;

    f.items[1]!.point = { lat: 55.7555, lon: 37.621 };
    const sessions = new PlanningSessions({ now: demoNow, plan: async job =>
      planPlacesWithDgis(f.client(async (url, init) => {
        if (new URL(String(url)).hostname !== 'catalog.api.2gis.com') throw Error('ROUTING_MUST_NOT_BE_CALLED');
        return f.defaultFetch(url, init);
      }), job, { now: demoNow, dataMode: 'test', routingMode: 'external',
        retrieval: { radiusMeters: 5000, maxPages: 1 },
        consumeRoutingQuota: async () => { throw Error('QUOTA_MUST_NOT_BE_CONSUMED'); } }) });
    const view = sessions.create('synthetic', f.input.intent, { catalog: f.input.catalog,
      visit_policy: { ...f.input.visit_policy, walkable_category_ids: ['100'] }, data_mode: 'test', modes: ['walking'] });
    const confirmed = sessions.confirm('synthetic', view.id, { base_version: view.version, event_id: 'confirm-walk-meal' });
    const planned = await sessions.calculate('synthetic', view.id, { base_version: confirmed.version, event_id: 'calculate-walk-meal' });
    const result = planned.result!;
    expect(result.status).toBe('PLACES_FOUND');
    expect(result.selection_policy).toBe('external-compact.v5');
    expect(result.selection_gaps).toEqual([]);
    expect(result.candidate_preview?.groups.map(group => group.activity_id)).toEqual(['culture', 'food']);
    const walks = result.candidate_preview!.groups[0]!.places;
    expect(walks).toHaveLength(end === '18:00' ? 1 : 2);
    expect(walks.every(place => place.estimated_visit_minutes === 5)).toBe(true);
    expect(result.candidate_preview!.groups[1]!.places).toHaveLength(1);
    expect(result.candidate_preview!.groups[1]!.places[0]!.estimated_visit_minutes).toBe(60);
    expect(f.routingBatches()).toBe(0);
    expect(f.requests.every(request => request.url.searchParams.get('sort') === 'distance')).toBe(true);
    const html = renderToStaticMarkup(createElement(CandidatePlaces, { view: planned }));
    expect(html).toContain('На посещение - примерно 5 мин.');
    expect(html).toContain('На посещение - примерно 60 мин.');
    expect(html).not.toContain('Не удалось совместить');
    const text = formatChatPlanMessages(planned).map(message => message.text).join('\n');
    expect(text).toContain('На посещение - примерно 60 мин.');
  }
}, 20000);

it.skipIf(!existsSync(defaultPlannerPython()))('does not call Routing or invent a result when even a visit cannot fit the time window', async () => {
  const f = planningFixture(); f.input.intent.days[0]!.window.end = '16:01';
  const result = PublicPlan.parse(await planPlacesWithDgis(f.client(), f.input,
    { now: demoNow, dataMode: 'test', routingMode: 'external', retrieval: { radiusMeters: 5000, maxPages: 1 } }));
  expect(result.status).toBe('UNAVAILABLE'); expect(result.days).toEqual([]);
  expect(result.candidate_preview).toBeUndefined(); expect(f.routingBatches()).toBe(0);
}, 20000);

it.skipIf(!existsSync(defaultPlannerPython()))('a four-hour general walk retrieves parks separately and keeps multiple spaced stops plus a meal', async () => {
  const f = planningFixture();
  f.input.intent.days[0]!.window.end = '20:00';
  f.input.intent.days[0]!.activities[0]!.label = 'прогулка';

  f.input.intent.days[0]!.activities[0]!.categories.include_any = ['100'];
  f.input.catalog.leaf_ids.push('300', '400');
  f.input.visit_policy.by_category['200'] = 60;
  f.items[0]!.name = 'Учебная памятная доска';
  f.items[1]!.name = 'Учебный парк';
  f.items[1]!.rubrics = [{ id: '300' }];
  f.items[1]!.point = { lat: 55.757, lon: 37.621 };
  for (const [id, lat] of [['landmark-1', 55.764], ['landmark-2', 55.771]] as const)
    f.items.push({ ...f.items[0]!, id, name: 'Учебный ориентир ' + id, rubrics: [{ id: '400' }], point: { lat, lon: 37.621 } });
  const sessions = new PlanningSessions({ now: demoNow, plan: async job =>
    planPlacesWithDgis(f.client(async (url, init) => {
      if (new URL(String(url)).hostname !== 'catalog.api.2gis.com') throw Error('ROUTING_MUST_NOT_BE_CALLED');
      return f.defaultFetch(url, init);
    }), job, { now: demoNow, dataMode: 'test', routingMode: 'external',
      retrieval: { radiusMeters: 7000, pageSize: 5, maxPages: 5, maxRequests: 30 } }) });
  const view = sessions.create('synthetic', f.input.intent, { catalog: { ...f.input.catalog,
    category_names: { '100': 'Памятные доски', '200': 'Кафе', '300': 'Парки', '400': 'Памятники и скульптуры' } },
    visit_policy: { ...f.input.visit_policy, walkable_category_ids: ['100', '300', '400'] }, data_mode: 'test', modes: ['walking'] });
  const confirmed = sessions.confirm('synthetic', view.id, { base_version: view.version, event_id: 'confirm-spread' });
  const planned = await sessions.calculate('synthetic', view.id, { base_version: confirmed.version, event_id: 'calculate-spread' });
  const groups = planned.result!.candidate_preview!.groups;
  expect(groups[0]!.places.length).toBeGreaterThanOrEqual(3);
  expect(groups[0]!.places.some(place => place.name === 'Учебный парк')).toBe(true);
  expect(groups[0]!.places.every(place => place.estimated_visit_minutes === 5)).toBe(true);
  expect(groups[1]!.places).toHaveLength(1);
  expect(groups[1]!.places[0]!.estimated_visit_minutes).toBe(60);
  expect(f.requests).toHaveLength(4);
  expect(f.requests.every(request => request.url.searchParams.get('page_size') === '5')).toBe(true);
  expect(f.routingBatches()).toBe(0);
}, 20000);
