import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { PublicPlan, type PlanningView } from '../shared/planning-form.js';
import type { BotNavigation, OwnerState, PlanningDatabase } from './planning-database.js';
import { MaxChatController, formatChatPlanMessages, maxWebhookSecret, navigationButtons, registerMaxChatRoute } from './max-chat.js';
import { PlanningSessions, PlanningSessionError } from './planning-sessions.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';
import { projectSavedConditions } from './saved-conditions.js';
import { planWarningCodes } from '../shared/plan-evidence-text.js';
import { maxWorkerSecret } from './max-async.js';

const draftView = (): PlanningView => ({
  id: 'draft-1', version: 0, phase: 'DRAFT', confirmed_version: null,
  expires_at: '2026-09-26T00:00:00Z', provenance: {},
  capabilities: { modes: ['walking', 'driving', 'cycling'], data_mode: 'live' },
  issues: [{ code: 'ORIGIN_REQUIRED', field: 'points.origin' }], result: null,
  draft: { locality: { id: '32', name: 'Москва', region_id: '32', timezone: 'Europe/Moscow' },
    shared: { mobility: ['walking'] }, points: {},
    days: [{ day_id: 'd1', date: '2026-09-26', window: { start: '16:00', end: '19:00' },
      activities: [{ id: 'a1', label: 'Прогулка', selection: { category_policy: 'related_allowed', named_types: [] },
        requirements: [], categories: { state: 'matched', include_any: ['1'], exclude: [], region_id: '32', catalog_version: 'v1' } }], order: [] }] },
});

it('shows the selected event time and group ticket estimate in external-mode bot results', () => {
  const view = draftView();
  view.result = PublicPlan.parse({ status: 'PLACES_FOUND', days: [], selection_policy: 'external-compact.v5',
    candidate_preview: { groups: [{ day_id: 'd1', activity_id: 'a1', places: [{ place_id: 'event-1', name: 'Учебная выставка', location_label: null,
      event_visit: { starts_at: 960, ends_at: 1020, schedule_kind: 'visit_window', admission_upper_minor: 120000 },
      source: { provider: 'kudago', data_mode: 'test', url: 'https://nn.kudago.com/event/test/', fetched_at: '2026-09-25T09:00:00Z', valid_until: '2026-09-25T09:05:00Z' } }] }] } });
  const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
  expect(text).toContain('16:00–17:00 · планируемое посещение');
  expect(text).toContain('для вашей группы — до 1200 ₽');
  expect(text).toContain('https://nn.kudago.com/event/test/');
  expect(text).not.toContain('Вход бесплатный');
});

function harness() {
  const state: OwnerState = { receipts: {}, attempts: [] };
  const navigation: BotNavigation = { welcomed: false, mode: 'idle', routes: [] };
  const database = { withOwner: async (_owner: string, work: (state: OwnerState, save: () => Promise<void>, client: unknown) => Promise<unknown>) =>
    work(state, async () => {}, {}), withNavigation: async (_owner: string,
      work: (state: BotNavigation, save: () => Promise<void>) => Promise<unknown>) => work(navigation, async () => {}),
    recordUsage: async () => {}, withChatUpdate: async (_owner: string, work: () => Promise<unknown>) => work() } as unknown as PlanningDatabase;
  const messages: { text: string; buttons?: unknown }[] = [];
  let view = draftView();
  const transport = { send: async (_userId: number, message: { text: string; buttons?: unknown }) => {
    messages.push(message); return `bot-${messages.length}`;
  }, delete: vi.fn(async (_messageId: string) => {}), answer: vi.fn(async () => {}) };
  const planning = {
    start: vi.fn(async () => ({ status: 'draft' as const, view })),
    get: async () => view,
    edit: vi.fn(async (_owner: string, _id: string, input: { changes: { op: string }[] }) => {
      view = { ...view, version: view.version + 1, issues: [], draft: { ...view.draft,
        points: { origin: { lat: 55.75, lon: 37.61, locality_id: '32', label: 'Моё местоположение', source: 'user_geolocation' as const } } } };
      expect(input.changes[0]?.op).toBe('point'); return view;
    }),
    confirm: async () => { view = { ...view, version: view.version + 1, phase: 'CONFIRMED' }; return view; },
    calculate: async () => { view = { ...view, version: view.version + 1, phase: 'RESULT', result: {
      status: 'AVAILABLE', warnings: [], days: [{ day_id: 'd1', date: '2026-09-26', status: 'AVAILABLE', missing_activity_ids: [],
        visits: [{ activity_id: 'a1', place_id: 'p1', name: 'Парк', starts_at: 960, ends_at: 1020,
          travel_before_minutes: 10, arrival_buffer_minutes: 5, price_expected_minor: 0, warnings: [] }] }] } }; return view; },
    remove: vi.fn(async () => {}),
  };
  const deps = { database, geography: { search: async () => [{ id: '32', name: 'Москва', region_id: '32',
    timezone: 'Europe/Moscow', center: { lat: 55.75, lon: 37.61 }, token: 'trusted-city' }],
    searchAddress: vi.fn(async () => [{ id: '7001', label: 'Москва, Тверская улица, 1', point: { lat: 55.757, lon: 37.613 } }]) },
    planning, transport, botUsername: 't801_hakaton_max_bot', mapEnabled: false };
  return { deps, messages, state, navigation, planning, transport };
}

const message = (mid: string, text?: string, attachments?: unknown[]) => ({ update_type: 'message_created',
  message: { sender: { user_id: 123, is_bot: false }, recipient: { chat_type: 'dialog' },
    body: { mid, text, attachments } } });
const press = (id: string, payload: string) => ({ update_type: 'message_callback', callback: {
  user: { user_id: 123 }, callback_id: id, payload }, message: { recipient: { chat_type: 'dialog' } } });

describe('MAX chat', () => {
  it('keeps the last result while navigating and removes its old controls', async () => {
    const h = harness(), chat = new MaxChatController(h.deps);
    await chat.handle(message('keep-plan-start', 'Хочу погулять в Москве'));
    const routeId = h.navigation.activeRouteId!;
    await h.planning.calculate();
    await chat.handle(press('keep-plan-open', `nav:open:${routeId}`));
    const resultIds = [...(h.navigation.resultMessageIds ?? [])];
    const controls = h.navigation.activeMessageIds!.at(-1)!;
    expect(resultIds.length).toBeGreaterThan(0);
    await chat.handle(press('keep-plan-menu', 'nav:list:0'));
    for (const id of resultIds) expect(h.transport.delete).not.toHaveBeenCalledWith(id);
    expect(h.transport.delete).toHaveBeenCalledWith(controls);
    await chat.handle(press('keep-plan-reopen', `nav:open:${routeId}`));
    for (const id of resultIds) expect(h.transport.delete).toHaveBeenCalledWith(id);
    const latestIds = [...h.navigation.resultMessageIds!];
    await chat.handle(press('keep-plan-delete-question', `nav:delete-confirm:${routeId}`));
    await chat.handle(press('keep-plan-delete', `nav:delete:${routeId}`));
    for (const id of latestIds) expect(h.transport.delete).toHaveBeenCalledWith(id);
    expect(h.navigation.resultMessageIds).toBeUndefined();
  });

  it('keeps a way back after an invalid address and a privacy detour', async () => {
    const h = harness(), chat = new MaxChatController(h.deps);
    await chat.handle(message('address-back-start', 'Хочу погулять в Москве'));
    await chat.handle(press('address-back-edit', 'origin-address:draft-1:0'));
    await chat.handle(message('address-too-short', 'а'));
    expect(h.messages.at(-1)?.text).toContain('улицей и номером');
    expect(JSON.stringify(h.messages.at(-1)?.buttons)).toContain('Продолжить маршрут');
    expect(JSON.stringify(h.messages.at(-1)?.buttons)).toContain('nav:exit');
    await chat.handle(message('privacy-during-address', '/privacy'));
    expect(h.messages.at(-1)?.text).toContain('идентификатор MAX');
    expect(h.state.chat?.pending?.kind).toBe('origin_address');
    await chat.handle(message('address-after-privacy', 'Тверская 1'));
    expect(h.messages.at(-1)?.text).toContain('Выберите найденный адрес');
    expect(JSON.stringify(h.messages.at(-1)?.buttons)).toContain('nav:exit');
  });

  it('keeps the blocking question and its action inside the MAX message limit even with a long draft', async () => {
    const h = harness(), view = draftView(), routeId = '55555555-5555-4555-8555-555555555556';
    const template = view.draft.days[0]!.activities[0]!;
    view.draft.days[0]!.activities = Array.from({ length: 12 }, (_, i) => ({ ...template, id: `a${i}`, label: `Занятие ${i}: ${'Описание '.repeat(48)}` }));
    view.draft.clarifications = [{ id: 'q-budget', field: 'budget', day_ids: [], text: 'Какой бюджет? ' + 'Неопределённая сумма '.repeat(100), reason: 'ambiguous' }];
    view.issues = [{ code: 'INPUT_CLARIFICATION_REQUIRED', field: 'clarifications.q-budget' }];
    h.navigation.mode = 'planning'; h.navigation.activeRouteId = routeId;
    h.navigation.routes.push({ id: routeId, draftId: view.id, createdAt: demoNow().toISOString(),
      title: 'Многословное пожелание', requestText: 'Synthetic request', localityName: view.draft.locality.name, status: 'draft' });
    const chat = new MaxChatController({ ...h.deps, planning: { ...h.planning, get: async () => view } });
    await chat.handle(press('open-long-partial-question', `nav:open:${routeId}`));
    const last = h.messages.at(-1)!;
    expect(last.text.length).toBeLessThanOrEqual(4000);
    expect(last.text).toContain('Нужно уточнить: «Какой бюджет?');
    expect(last.text).toContain('Сейчас указано: Не указан');
    expect(JSON.stringify(last.buttons)).toContain('Уточнить в форме');
    expect(h.planning.start).not.toHaveBeenCalled();
  });

  it('shows a specific retained question and resolves only that question through a real version-bound callback', async () => {
    const h = harness(), f = planningFixture(), owner = 'max:123';
    const sessions = new PlanningSessions({ now: demoNow, plan: async () => { throw Error('Must not calculate'); } });
    const view = sessions.create(owner, { ...f.input.intent, clarifications: [{ id: 'question-1', field: 'mobility',
      day_ids: [], text: 'как удобнее добраться', reason: 'ambiguous' }] }, { catalog: f.input.catalog,
      visit_policy: f.input.visit_policy, modes: ['walking'], data_mode: 'test' });
    const routeId = '55555555-5555-4555-8555-555555555555';
    h.navigation.mode = 'planning'; h.navigation.activeRouteId = routeId;
    h.navigation.routes.push({ id: routeId, draftId: view.id, createdAt: demoNow().toISOString(),
      title: 'Partial request', requestText: 'Synthetic request', localityName: view.draft.locality.name, status: 'draft' });
    const chat = new MaxChatController({ ...h.deps, planning: { ...h.planning,
      get: async (actor, id) => sessions.get(actor, id), edit: async (actor, id, input) => sessions.edit(actor, id, input) } });
    await chat.handle(press('open-partial-question', `nav:open:${routeId}`));
    expect(h.messages.at(-1)?.text).toContain('как удобнее добраться');
    expect(h.messages.at(-1)?.text).toContain('Пешком');
    const callback = press('answer-partial-question', `clarify:${view.id}:${view.version}:question-1`);
    await chat.handle(callback);
    const resolved = sessions.get(owner, view.id);
    expect(resolved.draft.clarifications).toBeUndefined();
    expect(resolved.draft.days).toEqual(view.draft.days);
    expect(resolved.confirmed_version).toBeNull();
    await chat.handle(callback);
    expect(sessions.get(owner, view.id)).toEqual(resolved);
    expect(h.planning.start).not.toHaveBeenCalled();
  });

  it('recalculates a service error from the result button without losing conditions or reparsing text', async () => {
    const h = harness(), fixture = planningFixture(), owner = 'max:123';
    let denied = true, providerCalls = 0;
    const sessions = new PlanningSessions({ now: demoNow, plan: job => planPlacesWithDgis(fixture.client(async (url, init) => {
      providerCalls++;
      if (denied && new URL(String(url)).hostname === 'routing.api.2gis.com') return new Response('', { status: 429 });
      return fixture.defaultFetch(url, init);
    }), job, { retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test', now: demoNow }) });
    const view = sessions.create(owner, fixture.input.intent, { catalog: fixture.input.catalog,
      visit_policy: fixture.input.visit_policy, modes: ['walking'], data_mode: 'test' });
    const routeId = '44444444-4444-4444-8444-444444444444';
    h.navigation.mode = 'planning'; h.navigation.activeRouteId = routeId;
    h.navigation.routes.push({ id: routeId, draftId: view.id, createdAt: demoNow().toISOString(),
      title: 'Synthetic retry', requestText: 'Synthetic request', localityName: view.draft.locality.name, status: 'draft' });
    const chat = new MaxChatController({ ...h.deps, planning: { ...h.planning,
      get: async (actor, id) => sessions.get(actor, id),
      confirm: async (actor, id, input) => sessions.confirm(actor, id, input),
      calculate: (actor, id, input) => sessions.calculate(actor, id, input),
    } });
    await chat.handle(press('outage-initial-plan', `plan:${view.id}:${view.version}`));
    const failed = sessions.get(owner, view.id);
    expect(failed.result).toMatchObject({ status: 'ERROR', issues: ['ROUTING_PROVIDER_UNAVAILABLE'] });
    expect(h.messages.at(-1)?.buttons).toEqual(expect.arrayContaining([
      [expect.objectContaining({ text: 'Повторить расчёт', payload: `replan:${view.id}:${failed.version}` })],
    ]));
    denied = false;
    const retry = press('outage-explicit-retry', `replan:${view.id}:${failed.version}`);
    await chat.handle(retry);
    const refreshed = sessions.get(owner, view.id);
    expect(refreshed.result?.status).toBe('AVAILABLE');
    expect(refreshed.draft).toEqual(failed.draft);
    expect(refreshed.version).toBe(failed.version + 1);
    const afterRefresh = providerCalls;
    await chat.handle(retry);
    await chat.handle(press('outage-stale-button', `replan:${view.id}:${failed.version}`));
    expect(providerCalls).toBe(afterRefresh);
    expect(h.planning.start).not.toHaveBeenCalled();
  }, 30_000);

  it('does not invent an original request for an expired imported or mini-app route', async () => {
    const h = harness(), routeId = 'e0ad035c-d95e-4ee4-aa22-93852967be3a';
    h.navigation.routes.push({ id: routeId, draftId: 'expired-no-source-text', createdAt: new Date().toISOString(),
      title: 'Сохранённые условия', requestText: '', localityName: '', status: 'draft' });
    const search = vi.fn(async () => { throw Error('Unexpected provider'); });
    const chat = new MaxChatController({ ...h.deps, geography: { ...h.deps.geography, search },
      planning: { ...h.planning, get: async () => { throw new PlanningSessionError('DRAFT_NOT_FOUND', 404); } } });
    await chat.handle(press('open-no-source-text', `nav:open:${routeId}`));
    expect(h.messages.at(-1)!.text).toContain('Исходного пожелания в этой записи нет');
    expect(JSON.stringify(h.messages.at(-1))).not.toContain('nav:restart');
    // An old callback is still handled safely; it asks for a new authored text.
    await chat.handle(press('restart-no-source-text', `nav:restart:${routeId}`));
    expect(h.navigation.mode).toBe('awaiting_request');
    expect(search).not.toHaveBeenCalled(); expect(h.planning.start).not.toHaveBeenCalled();
  });
  it('opens edited saved conditions without providers and restores them only after an explicit city choice', async () => {
    const h = harness(), fixture = planningFixture(), owner = 'max:123';
    let now = demoNow();
    const sessions = new PlanningSessions({ now: () => now, plan: async () => { throw new Error('must not calculate'); } });
    const original = sessions.create(owner, fixture.input.intent, { catalog: fixture.input.catalog,
      visit_policy: fixture.input.visit_policy, modes: ['walking'], data_mode: 'test' });
    const edited = sessions.edit(owner, original.id, { base_version: original.version, event_id: 'saved-edit-before-expiry', changes: [
      { op: 'window', day_ids: ['d1'], start: '17:00', end: '20:00' },
      { op: 'budget', value: { kind: 'limit', amount_rub: 2400, basis: 'whole_party', period: 'per_day',
        enforcement: 'estimated', price_basis_assumption: 'per_person' } },
      { op: 'party', total: 2 }, { op: 'remove_activity', day_id: 'd1', activity_id: 'culture' },
    ] });
    const saved = { id: edited.id, revision: edited.version, expires_at: '2026-10-24T00:00:00Z',
      conditions: projectSavedConditions(edited, { now }) };
    now = new Date(now.getTime() + 1_801_000);
    const routeId = '33333333-3333-4333-8333-333333333333';
    h.navigation.mode = 'planning'; h.navigation.activeRouteId = routeId;
    h.navigation.routes.push({ id: routeId, createdAt: demoNow().toISOString(), title: 'Saved route',
      requestText: 'Original text before edits', localityName: 'Учебный город', draftId: edited.id, status: 'draft' });
    const search = vi.fn(h.deps.geography.search);
    const restore = vi.fn(async () => ({ ...edited, version: edited.version + 1, phase: 'DRAFT' as const, confirmed_version: null, result: null }));
    const chat = new MaxChatController({ ...h.deps, geography: { ...h.deps.geography, search },
      planning: { ...h.planning, get: (actor, id) => sessions.get(actor, id), getSaved: async () => saved, restore } });
    await chat.handle(press('open-saved-after-expiry', `nav:open:${routeId}`));
    expect(h.messages.at(-1)?.text).toContain('17:00–20:00');
    expect(h.messages.at(-1)?.text).toContain('2400');
    expect(h.messages.at(-1)?.text).toContain('Участников: 2');
    expect(h.messages.at(-1)?.text).not.toContain('culture');
    expect(h.planning.start).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
    await chat.handle(press('refresh-saved-after-expiry', `nav:refresh:${routeId}`));
    expect(h.messages.at(-1)?.text).toContain('В каком городе продолжить');
    expect(search).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
    await chat.handle(message('saved-city-answer', 'Москва'));
    expect(search).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(owner, saved.id, expect.objectContaining({ base_revision: saved.revision, locality_token: 'trusted-city' }));
    expect(h.planning.start).not.toHaveBeenCalled();
    expect(h.navigation.routes[0]?.draftId).toBe(saved.id);
    expect(h.messages.at(-1)?.text).toContain('2400');
  });

  it('keeps a strict budget until an explicit average-bill choice and requires reconfirmation', async () => {
    const h = harness(), fixture = planningFixture(), owner = 'max:123';
    const intent = structuredClone(fixture.input.intent);
    intent.shared.budget = { kind: 'limit', amount_rub: 3000, basis: 'whole_party', period: 'per_day' };
    let calculations = 0;
    const sessions = new PlanningSessions({ now: demoNow, plan: async () => {
      calculations++;
      return { status: 'UNAVAILABLE', warnings: [], issues: ['BUDGET_PRICE_DATA_REQUIRED'], days: [] };
    } });
    const view = sessions.create(owner, intent, { catalog: fixture.input.catalog,
      visit_policy: fixture.input.visit_policy, modes: ['walking'], data_mode: 'test' });
    const routeId = '22222222-2222-4222-8222-222222222222';
    h.navigation.mode = 'planning'; h.navigation.activeRouteId = routeId;
    h.navigation.routes.push({ id: routeId, createdAt: demoNow().toISOString(), title: 'Budget test',
      requestText: 'Synthetic budget request', localityName: view.draft.locality.name, draftId: view.id, status: 'draft' });
    const chat = new MaxChatController({ ...h.deps, planning: { ...h.planning,
      get: async (actor, id) => sessions.get(actor, id),
      edit: async (actor, id, input) => sessions.edit(actor, id, input),
      confirm: async (actor, id, input) => sessions.confirm(actor, id, input),
      calculate: (actor, id, input) => sessions.calculate(actor, id, input),
    } });
    await chat.handle(press('strict-budget-plan', `plan:${view.id}:${view.version}`));
    const strict = sessions.get(owner, view.id);
    expect(strict.draft.shared.budget).not.toHaveProperty('enforcement');
    expect(h.messages.at(-1)?.buttons).toEqual(expect.arrayContaining([
      [expect.objectContaining({ payload: `budget-policy:${view.id}:${strict.version}:estimated` })],
    ]));
    await chat.handle(press('choose-estimated-budget', `budget-policy:${view.id}:${strict.version}:estimated`));
    const estimated = sessions.get(owner, view.id);
    expect(estimated.draft.shared.budget).toMatchObject({ enforcement: 'estimated', price_basis_assumption: 'per_person' });
    expect(estimated.phase).toBe('DRAFT');
    expect(estimated.confirmed_version).toBeNull();
    expect(estimated.result).toBeNull();
    expect(calculations).toBe(1);
    expect(h.messages.at(-1)?.text).toContain('соблюдение суммы не гарантируется');
    await chat.handle(press('return-to-strict-budget', `budget-policy:${view.id}:${estimated.version}:strict`));
    expect(sessions.get(owner, view.id).draft.shared.budget).toMatchObject({ enforcement: 'strict' });
    expect(sessions.get(owner, view.id).draft.shared.budget).not.toHaveProperty('price_basis_assumption');
    expect(calculations).toBe(1);
  });

  it('retries a failed calculation from its confirmed revision without confirming twice', async () => {
    const h = harness(), fixture = planningFixture();
    let attempts = 0;
    const sessions = new PlanningSessions({ now: demoNow, plan: async () => {
      if (++attempts === 1) throw new Error('simulated provider interruption');
      return { status: 'UNAVAILABLE', warnings: [], days: [] };
    } });
    const owner = 'max:123';
    const view = sessions.create(owner, fixture.input.intent, { catalog: fixture.input.catalog,
      visit_policy: fixture.input.visit_policy, modes: ['walking'], data_mode: 'test' });
    const routeId = '11111111-1111-4111-8111-111111111111';
    h.navigation.mode = 'planning'; h.navigation.activeRouteId = routeId;
    h.navigation.routes.push({ id: routeId, createdAt: demoNow().toISOString(), title: 'Test route',
      requestText: 'Synthetic route', localityName: view.draft.locality.name, draftId: view.id, status: 'draft' });
    const chat = new MaxChatController({ ...h.deps, planning: { ...h.planning,
      get: async (actor, id) => sessions.get(actor, id),
      confirm: async (actor, id, input) => sessions.confirm(actor, id, input),
      calculate: (actor, id, input) => sessions.calculate(actor, id, input),
    } });
    await chat.handle(press('first-plan-attempt', `plan:${view.id}:${view.version}`));
    const failed = sessions.get(owner, view.id);
    expect(failed.phase).toBe('CONFIRMED');
    await chat.handle(press('open-after-failure', `nav:open:${routeId}`));
    await chat.handle(press('second-plan-attempt', `plan:${view.id}:${failed.version}`));
    expect(sessions.get(owner, view.id).phase).toBe('RESULT');
    expect(attempts).toBe(2);
    await chat.handle(press('second-plan-attempt', `plan:${view.id}:${failed.version}`));
    expect(attempts).toBe(2);
  });

  it('welcomes on the native Start event before any chat text and exposes navigation', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    await chat.handle({ update_type: 'bot_started', user: { user_id: 123 }, timestamp: 123456 });
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0]?.text).toMatch(/^Привет!/u);
    expect(h.messages[0]?.buttons).toBeUndefined();
    expect(h.messages[1]?.buttons).toEqual([[expect.objectContaining({ payload: 'nav:new' })]]);
    expect(h.planning.start).not.toHaveBeenCalled();
  });

  it('keeps one greeting and replaces obsolete bot menus after each step', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    await chat.handle({ update_type: 'bot_started', user: { user_id: 123 }, timestamp: 123456 });
    expect(h.navigation.greetingMessageId).toBe('bot-1');
    expect(h.navigation.activeMessageIds).toEqual(['bot-2']);
    await chat.handle(press('create-1', 'nav:new'));
    expect(h.transport.delete).toHaveBeenCalledWith('bot-2');
    expect(h.transport.delete).not.toHaveBeenCalledWith('bot-1');
    expect(h.navigation.activeMessageIds).toEqual(['bot-3']);
    await chat.handle(press('list-1-cleanup', 'nav:list:0'));
    expect(h.transport.delete).toHaveBeenCalledWith('bot-3');
    expect(h.navigation.activeMessageIds).toEqual(['bot-4']);
    await chat.handle(press('list-1-cleanup', 'nav:list:0'));
    expect(h.messages).toHaveLength(4);
    await chat.handle({ update_type: 'bot_started', user: { user_id: 123 }, timestamp: 123457 });
    expect(h.messages.filter(item => item.text.startsWith('Привет!'))).toHaveLength(1);
    expect(h.transport.delete).not.toHaveBeenCalledWith('bot-1');
  });

  it('retries deletion later without blocking the next prompt', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    await chat.handle({ update_type: 'bot_started', user: { user_id: 123 }, timestamp: 123456 });
    h.transport.delete.mockRejectedValueOnce(new Error('MAX_DELETE_HTTP_429'));
    expect(await chat.handle(press('create-after-delete-failure', 'nav:new'))).toBe('handled');
    expect(h.navigation.cleanupMessageIds).toEqual(['bot-2']);
    expect(h.navigation.activeMessageIds).toEqual(['bot-3']);
    await chat.handle(press('list-after-delete-failure', 'nav:list:0'));
    expect(h.navigation.cleanupMessageIds).toEqual([]);
    expect(h.transport.delete).toHaveBeenCalledWith('bot-2');
    expect(h.transport.delete).toHaveBeenCalledWith('bot-3');
  });

  it('shows only context-appropriate navigation at each stage', () => {
    const h = harness(); const state = h.navigation;
    const actions = (surface: 'menu' | 'draft' | 'result' | 'list' = 'menu') =>
      navigationButtons(state, surface).flat().map(button => button.payload);
    expect(actions()).toEqual(['nav:new']);
    state.mode = 'awaiting_request';
    expect(actions()).toEqual(['nav:exit']);
    state.routes.push({ id: 'route-1', createdAt: '2026-09-25T00:00:00Z', title: 'Маршрут',
      requestText: 'Погулять', localityName: 'Москва', draftId: 'draft-1', status: 'draft' });
    expect(actions()).toEqual(['nav:list:0', 'nav:exit']);
    state.mode = 'planning'; state.activeRouteId = 'route-1';
    expect(actions('draft')).toEqual(['nav:list:0', 'nav:exit']);
    expect(actions('result')).toEqual(['nav:new', 'nav:list:0', 'nav:exit']);
    expect(actions('list')).toEqual(['nav:open:route-1', 'nav:new', 'nav:exit']);
    state.mode = 'idle'; delete state.activeRouteId;
    expect(actions()).toEqual(['nav:new', 'nav:list:0']);
  });

  it('lists, reopens and exits a route without reparsing it', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    await chat.handle(press('new-1', 'nav:new'));
    expect(h.navigation.mode).toBe('awaiting_request');
    expect((h.messages.at(-1)?.buttons as { payload: string }[][]).flat().map(button => button.payload)).toEqual(['nav:exit']);
    await chat.handle(message('route-1', 'Хочу погулять завтра с 16 до 19 в Москве'));
    expect(h.navigation.mode).toBe('planning');
    expect(h.navigation.routes).toHaveLength(1);
    expect((h.messages.at(-1)?.buttons as { payload?: string }[][]).flat().map(button => button.payload))
      .not.toContain('nav:new');
    const routeId = h.navigation.activeRouteId!;
    await chat.handle(message('route-unrelated', 'Сходить в другой музей'));
    expect(h.planning.start).toHaveBeenCalledTimes(1);
    expect(h.messages.at(-1)?.text).toContain('Откуда удобнее начать?');
    expect(JSON.stringify(h.messages.at(-1)?.buttons)).toContain('Ввести адрес');
    await chat.handle(press('list-1', 'nav:list:0'));
    expect(h.messages.at(-1)?.text).toContain('Мои маршруты (1)');
    await chat.handle(press('exit-1', 'nav:exit'));
    expect(h.navigation.mode).toBe('idle');
    expect((h.messages.at(-1)?.buttons as { payload: string }[][]).flat().map(button => button.payload))
      .toEqual(['nav:new', 'nav:list:0']);
    await chat.handle(press('open-1', `nav:open:${routeId}`));
    expect(h.navigation.activeRouteId).toBe(routeId);
    expect(h.messages.at(-1)?.text).toContain('Маршрут:');
    expect(h.planning.start).toHaveBeenCalledTimes(1);
  });

  it('still processes navigation when MAX rejects an empty callback acknowledgement', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    h.transport.answer.mockRejectedValueOnce(new Error('MAX_SEND_HTTP_400'));
    expect(await chat.handle(press('list-with-rejected-ack', 'nav:list:0'))).toBe('handled');
    expect(h.messages.at(-1)?.text).toContain('пока нет маршрутов');
    expect(await chat.handle(press('list-with-rejected-ack', 'nav:list:0'))).toBe('duplicate');
  });

  it('requires a confirmed delete and never plans from stale buttons of another route', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    await chat.handle(message('route-a', 'Хочу погулять завтра с 16 до 19 в Москве'));
    const routeId = h.navigation.activeRouteId!;
    await chat.handle(press('delete-forged', `nav:delete:${routeId}`));
    expect(h.navigation.routes).toHaveLength(1);
    await chat.handle(press('delete-confirm', `nav:delete-confirm:${routeId}`));
    expect(h.messages.at(-1)?.text).toContain('Удалить маршрут');
    await chat.handle(press('delete-cancel', 'nav:list:0'));
    await chat.handle(press('delete-after-cancel', `nav:delete:${routeId}`));
    expect(h.navigation.routes).toHaveLength(1);
    await chat.handle(press('delete-confirm-again', `nav:delete-confirm:${routeId}`));
    await chat.handle(press('delete-real', `nav:delete:${routeId}`));
    expect(h.navigation.routes).toHaveLength(0);
    expect(h.planning.remove).toHaveBeenCalledWith('max:123', 'draft-1');
    expect(h.navigation.mode).toBe('idle');
    await chat.handle(press('stale-plan', 'plan:draft-1:0'));
    expect(h.messages.at(-1)?.text).toContain('Эта кнопка относится к другому маршруту');
    expect(h.planning.start).toHaveBeenCalledTimes(1);
  });

  it('warns about lost edits on legacy routes and reparses only after an explicit restart', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    await chat.handle(message('route-old', 'Хочу погулять завтра с 16 до 19 в Москве'));
    const routeId = h.navigation.activeRouteId!;
    h.planning.get = vi.fn(async () => { throw new Error('unexpected'); }) as typeof h.planning.get;
    h.planning.get = vi.fn(async () => { const { PlanningSessionError } = await import('./planning-sessions.js');
      throw new PlanningSessionError('DRAFT_NOT_FOUND', 404); }) as typeof h.planning.get;
    await chat.handle(press('expired-open', `nav:open:${routeId}`));
    expect(h.messages.at(-1)?.text).toContain('сохранился только исходный запрос');
    expect(h.planning.start).toHaveBeenCalledTimes(1);
    await chat.handle(press('expired-refresh', `nav:refresh:${routeId}`));
    expect(h.planning.start).toHaveBeenCalledTimes(1);
    await chat.handle(press('expired-restart', `nav:restart:${routeId}`));
    expect(h.planning.start).toHaveBeenCalledTimes(2);
    expect(h.navigation.activeRouteId).toBe(routeId);
    expect(h.navigation.routes).toHaveLength(1);
  });

  it('welcomes an existing chat on its first message and still handles the request', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    expect(await chat.handle(message('old-chat-1', 'Хочу погулять завтра с 16 до 19 в Москве'))).toBe('handled');
    expect(h.messages[0]?.text).toMatch(/^Привет!/u);
    expect(h.messages.at(-1)?.text).toContain('Прогулка');
    expect(h.planning.start).toHaveBeenCalledTimes(1);
    expect(await chat.handle(message('old-chat-2', 'Привет'))).toBe('handled');
    expect(h.messages.filter(item => item.text.startsWith('Привет!'))).toHaveLength(1);
  });

  it.each([
    ['INTENT_INVALID_RESPONSE', 'ошибка разбора'],
    ['INTENT_NEEDS_CLARIFICATION', 'разобрать условия пожелания'],
  ])('explains %s and accepts a new request without trapping it in city selection', async (code, explanation) => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    const { InitialIntentError } = await import('./intent-start.js');
    h.planning.start.mockRejectedValueOnce(new InitialIntentError(code));
    await chat.handle(message('failed-request', 'Хочу погулять завтра в Москве после 16'));
    expect(h.state.chat?.pending).toMatchObject({ kind: 'intent_retry',
      requestText: 'Хочу погулять завтра в Москве после 16', localityToken: 'trusted-city' });
    expect(h.navigation.routes).toHaveLength(0);
    expect(h.messages.at(-1)?.text).toContain(explanation);
    expect(h.messages.at(-1)?.text).not.toContain('Проверьте условия');
    await chat.handle(message('new-request-after-failure', 'Хочу сходить в музей в Москве завтра'));
    expect(h.planning.start).toHaveBeenCalledTimes(2);
    expect(h.planning.start.mock.calls[1]?.[1]).toMatchObject({ user_text: 'Хочу сходить в музей в Москве завтра' });
    expect(h.state.chat?.pending?.kind).toBe('origin');
  });

  it.each(['INTENT_INVALID_RESPONSE', 'INTENT_NEEDS_CLARIFICATION'])(
    'retries %s only on the current explicit button', async code => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    const { InitialIntentError } = await import('./intent-start.js');
    h.planning.start.mockRejectedValueOnce(new InitialIntentError(code));
    await chat.handle(message('first-failed', 'Хочу погулять завтра в Москве после 16'));
    const retry = (h.messages.at(-1)?.buttons as { payload: string }[][]).flat()
      .find(button => button.payload.startsWith('intent-retry:'))!;
    await chat.handle(press('retry-request', retry.payload));
    expect(h.planning.start).toHaveBeenCalledTimes(2);
    expect(h.navigation.routes).toHaveLength(1);
    await chat.handle(press('stale-retry', retry.payload));
    expect(h.planning.start).toHaveBeenCalledTimes(2);
  });

  it('does not send two prompts for the first greeting', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    expect(await chat.handle(message('hello-first', 'Привет'))).toBe('handled');
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0]?.text).toMatch(/^Привет!/u);
    expect(h.messages[1]?.buttons).toEqual([[expect.objectContaining({ payload: 'nav:new' })]]);
    expect(h.planning.start).not.toHaveBeenCalled();
  });
  it('keeps the core flow in messages and uses the same owner as the mini-app', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    expect(await chat.handle(message('m1', 'Хочу погулять завтра с 16 до 19 в Москве'))).toBe('handled');
    expect(h.planning.start).toHaveBeenCalledWith('max:123', expect.objectContaining({ locality_token: 'trusted-city' }));
    expect(h.messages.at(-1)?.text).toContain('Прогулка');
    expect(h.messages.at(-1)?.text).toContain('Откуда удобнее начать?');
    expect(h.messages.at(-1)?.buttons).toEqual(expect.arrayContaining([expect.arrayContaining([
      expect.objectContaining({ type: 'request_geo_location' })])]));
    expect(h.messages.at(-1)?.buttons).not.toContainEqual([expect.objectContaining({ type: 'open_app', text: 'Выбрать на карте' })]);
    expect(await chat.handle(message('m1', 'Хочу погулять завтра с 16 до 19 в Москве'))).toBe('duplicate');
    expect(h.planning.start).toHaveBeenCalledTimes(1);
    expect(await chat.handle(message('m2', undefined, [{ type: 'location', latitude: 55.75, longitude: 37.61 }]))).toBe('handled');
    expect(h.messages.at(-1)?.text).toContain('составлю маршрут');
    expect(h.messages.at(-1)?.buttons).toEqual(expect.arrayContaining([expect.arrayContaining([
      expect.objectContaining({ type: 'callback', text: 'Составить план' })])]));
    expect(await chat.handle({ update_type: 'message_callback', callback: { user: { user_id: 123 },
      callback_id: 'cb1', payload: 'plan:draft-1:1' }, message: { recipient: { chat_type: 'dialog' } } })).toBe('handled');
    expect(h.messages.map(m => m.text).join('\n')).toContain('Парк');
    expect(h.messages.at(-1)?.buttons).toEqual(expect.arrayContaining([[expect.objectContaining({ text: 'Открыть подробный план' })]]));
  });

  it('selects a confirmed address in chat without reparsing the leisure request', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    await chat.handle(message('address-start', 'Хочу погулять завтра с 16 до 19 в Москве'));
    const button = (h.messages.at(-1)?.buttons as { text: string; payload: string }[][])
      .flat().find(item => item.text === 'Ввести адрес');
    expect(button?.payload).toBe('origin-address:draft-1:0');
    const press = (id: string, payload: string) => ({ update_type: 'message_callback', callback: {
      user: { user_id: 123 }, callback_id: id, payload }, message: { recipient: { chat_type: 'dialog' } } });
    await chat.handle(press('address-open', button!.payload));
    expect(h.messages.at(-1)?.text).toContain('улицу и номер дома');
    await chat.handle(message('address-query', 'Тверская, 1'));
    expect(h.deps.geography.searchAddress).toHaveBeenCalledWith('Тверская, 1', '32');
    const choice = (h.messages.at(-1)?.buttons as { text: string; payload: string }[][]).flat()[0]!;
    expect(choice.text).toContain('Тверская');
    expect(h.state.chat?.pending).toMatchObject({ kind: 'origin_address', query: 'Тверская, 1' });
    expect(h.state.chat?.pending).not.toHaveProperty('choices');
    await chat.handle(press('address-select', choice.payload));
    expect(h.planning.edit).toHaveBeenCalledWith('max:123', 'draft-1', expect.objectContaining({ changes: [
      expect.objectContaining({ op: 'point', field: 'origin', point: expect.objectContaining({ source: 'place_choice', lat: 55.757 }) })] }));
    expect(h.planning.start).toHaveBeenCalledTimes(1);
  });

  it('does not trust a forged address choice that was not returned by 2GIS', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    await chat.handle(message('forged-start', 'Хочу погулять завтра в Москве'));
    await chat.handle(press('forged-open-address', 'origin-address:draft-1:0'));
    await chat.handle(message('forged-query', 'Тверская, 1'));
    const choice = (h.messages.at(-1)?.buttons as { payload: string }[][]).flat()[0]!;
    const forgedPayload = choice.payload.replace(/:\d+$/u, ':9999');
    await chat.handle({ update_type: 'message_callback', callback: { user: { user_id: 123 },
      callback_id: 'forged-choice', payload: forgedPayload }, message: { recipient: { chat_type: 'dialog' } } });
    expect(h.planning.edit).not.toHaveBeenCalled();
    expect(h.messages.at(-1)?.text).toContain('не удалось подтвердить');
  });

  it('acknowledges queued work before a delayed plan and executes it once through the authenticated worker', async () => {
    const h = harness(), f = planningFixture();
    let finish!: () => void, started!: () => void, calls = 0;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const sessions = new PlanningSessions({ now: demoNow, plan: async () => {
      calls++; started(); await barrier; return { status: 'UNAVAILABLE', warnings: [], days: [] };
    } });
    const view = sessions.create('max:123', f.input.intent, { catalog: f.input.catalog,
      visit_policy: f.input.visit_policy, modes: ['walking'], data_mode: 'test' });
    h.navigation.mode = 'planning'; h.navigation.activeRouteId = 'queued-route';
    h.navigation.routes.push({ id: 'queued-route', draftId: view.id, createdAt: demoNow().toISOString(),
      title: 'Synthetic route', requestText: 'Synthetic request', localityName: 'Test city', status: 'draft' });
    const queued: unknown[] = [], app = Fastify();
    registerMaxChatRoute(app, { ...h.deps, planning: { ...h.planning,
      get: (owner, id) => sessions.get(owner, id), confirm: (owner, id, input) => sessions.confirm(owner, id, input),
      calculate: (owner, id, input) => sessions.calculate(owner, id, input) } }, 'synthetic-token',
    { dispatch: async payload => { queued.push(payload); } });
    const ingress = await app.inject({ method: 'POST', url: '/api/max/webhook',
      headers: { 'x-max-bot-api-secret': maxWebhookSecret('synthetic-token') },
      payload: press('queued-plan', `plan:${view.id}:${view.version}`) });
    expect(ingress.json()).toEqual({ status: 'accepted' }); expect(calls).toBe(0);
    const denied = await app.inject({ method: 'POST', url: '/api/max/worker',
      headers: { 'x-vmax-worker-secret': maxWebhookSecret('synthetic-token') }, payload: queued[0] as object });
    expect(denied.statusCode).toBe(401);
    const worker = () => app.inject({ method: 'POST', url: '/api/max/worker',
      headers: { 'x-vmax-worker-secret': maxWorkerSecret('synthetic-token') }, payload: queued[0] as object });
    const running = worker(); await entered;
    expect(h.messages.some(m => m.text.includes('Подбираю места'))).toBe(true);
    finish(); expect((await running).statusCode).toBe(200);
    expect((await worker()).json()).toEqual({ status: 'duplicate' }); expect(calls).toBe(1);
    expect(h.messages.some(m => m.text.includes('Подбираю места'))).toBe(true);
    await app.close();
  });

  it('returns retry_later when managed queue acceptance failed, without processing the update', async () => {
    const h = harness(), app = Fastify();
    registerMaxChatRoute(app, h.deps, 'synthetic-token', { dispatch: async () => { throw Error('Queue unavailable'); } });
    const result = await app.inject({ method: 'POST', url: '/api/max/webhook',
      headers: { 'x-max-bot-api-secret': maxWebhookSecret('synthetic-token') }, payload: message('queue-failed', 'Привет') });
    expect(result.statusCode).toBe(503); expect(h.messages).toHaveLength(0);
    await app.close();
  });

  it('rejects webhook requests without the configured secret', async () => {
    const h = harness(); const app = Fastify(); registerMaxChatRoute(app, h.deps, 'test-token');
    const denied = await app.inject({ method: 'POST', url: '/api/max/webhook', payload: message('m3', 'Привет') });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({ method: 'POST', url: '/api/max/webhook',
      headers: { 'x-max-bot-api-secret': maxWebhookSecret('test-token') }, payload: message('m3', 'Привет') });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it('does not truncate a multi-day chat itinerary', () => {
    const view = draftView(); view.result = { status: 'AVAILABLE', warnings: [], days: Array.from({ length: 3 }, (_, i) => ({
      day_id: `d${i}`, date: `2026-09-${25 + i}`, status: 'AVAILABLE', missing_activity_ids: [],
      visits: Array.from({ length: 40 }, (_, j) => ({ activity_id: `a${j}`, place_id: `p${j}`,
        name: `Место ${i}-${j}`, starts_at: 900, ends_at: 960, travel_before_minutes: 10,
        arrival_buffer_minutes: 5, price_expected_minor: null, warnings: [] })) })) };
    const output = formatChatPlanMessages(view);
    expect(output.length).toBeGreaterThan(3);
    expect(output.map(m => m.text).join('\n')).toContain('Место 2-39');
    expect(output.every(m => m.text.length <= 3800)).toBe(true);
  });

  it('does not claim that a route outage means there are no places or that an empty plan costs zero', () => {
    const view = draftView();
    view.result = { status: 'UNAVAILABLE', warnings: ['ROUTING_PROVIDER_FAILURE'], total_expected_cost_minor: 0,
      days: [{ day_id: 'd1', date: '2026-09-25', status: 'UNAVAILABLE', missing_activity_ids: ['a1'], visits: [] }] };
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('не удалось проверить путь');
    expect(text).not.toContain('Подтверждённых подходящих мест не нашлось');
    expect(text).not.toContain('0 ₽');
  });

  it('explains a routing service denial without asking the user to change valid conditions', () => {
    const view = draftView();
    view.result = { status: 'ERROR', issues: ['ROUTING_PROVIDER_UNAVAILABLE'], warnings: [], days: [] };
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('Сервис проверки дороги сейчас недоступен');
    expect(text).toContain('условия сохранены');
    expect(text).toContain('позже');
    expect(text).not.toMatch(/другой старт|изменить время|сократ|невыполним|ключ|квот/u);
  });

  it('does not mistake bounded search coverage for an upstream outage', () => {
    const view = draftView();
    view.result = { status: 'UNAVAILABLE', warnings: ['RETRIEVAL_PARTIAL'],
      days: [{ day_id: 'd1', date: '2026-09-26', status: 'UNAVAILABLE', missing_activity_ids: ['a1'], visits: [] }] };
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('Поиск охватил только часть мест');
    expect(text).not.toContain('Не все источники ответили');
  });

  it('labels an outdoor stop with unknown hours as tentative', () => {
    const view = draftView();
    view.result = { status: 'LIMITED', warnings: ['OPENING_HOURS_UNVERIFIED'],
      days: [{ day_id: 'd1', date: '2026-09-26', status: 'LIMITED', missing_activity_ids: [],
        visits: [{ activity_id: 'a1', place_id: 'p1', name: 'Парк', starts_at: 960, ends_at: 1020,
          travel_before_minutes: 10, arrival_buffer_minutes: 5, price_expected_minor: null,
          warnings: ['OPENING_HOURS_UNVERIFIED'] }] }] };
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('Предварительный план');
    expect(text).toContain('проверьте доступность перед выходом');
    expect(text).not.toContain('Готово — вот план');
  });

  it('keeps a verified plan usable while disclosing a partial search and a narrowed candidate pool', () => {
    const view = draftView();
    view.result = PublicPlan.parse({ status: 'AVAILABLE', warnings: [],
      search_scope: { radius_meters: 5000, coverage: 'PARTIAL' }, shortlist: { groups: [{ truncated: true }] },
      days: [{ day_id: 'd1', date: '2026-09-26', status: 'AVAILABLE', missing_activity_ids: [],
        visits: [{ activity_id: 'a1', place_id: 'p1', name: 'Парк', starts_at: 960, ends_at: 1020,
          travel_before_minutes: 10, arrival_buffer_minutes: 5, price_expected_minor: null, warnings: [] }] }] });
    expect(planWarningCodes(view.result)).toContain('RETRIEVAL_PARTIAL');
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('Готово — вот план');
    expect(text).toContain('Парк');
    expect(text).toContain('радиусе 5 км от старта');
    expect(text).toContain('Получена только часть мест');
    expect(text).toContain('сокращённая подборка кандидатов');
    expect(text).not.toContain('проверенного плана пока нет');
  });

  it('does not label a completed bounded search as partial or as an exhaustive city search', () => {
    const view = draftView();
    view.result = PublicPlan.parse({ status: 'UNAVAILABLE', warnings: [],
      search_scope: { radius_meters: 750, coverage: 'BOUNDED_RESULTS' }, shortlist: { groups: [{ truncated: false }] },
      days: [{ day_id: 'd1', date: '2026-09-26', status: 'UNAVAILABLE', missing_activity_ids: ['a1'], visits: [] }] });
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('радиусе 750 м от старта');
    expect(text).toContain('В проверенной части поиска');
    expect(text).not.toContain('Получена только часть мест');
    expect(text).not.toContain('сокращённая подборка кандидатов');
    expect(text).not.toContain('Подтверждённых подходящих мест для этих ограничений нет');
  });

  it('does not attribute an internal routing allowance stop to a provider outage', () => {
    const view = draftView();
    view.result = PublicPlan.parse({ status: 'ERROR', issues: ['ROUTING_BUDGET_EXCEEDED'], warnings: [], days: [] });
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('Не удалось закончить проверку всех переходов');
    expect(text).not.toContain('Сервис мест или маршрутов временно не ответил');
  });

  it('names an omitted food request instead of hiding it in a generic partial-plan warning', () => {
    const view = draftView();
    view.draft.days[0]!.activities.push({ id: 'food', label: 'Поесть',
      selection: { category_policy: 'related_allowed', named_types: [] }, requirements: [],
      categories: { state: 'matched', include_any: ['2'], exclude: [], region_id: '32', catalog_version: 'v1' } });
    view.result = { status: 'LIMITED', warnings: [], days: [{
      day_id: 'd1', date: '2026-09-26', status: 'LIMITED', missing_activity_ids: ['food'],
      visits: [{ activity_id: 'a1', place_id: 'p1', name: 'Парк', starts_at: 960, ends_at: 1020,
        travel_before_minutes: 10, arrival_buffer_minutes: 5, price_expected_minor: 0, warnings: [] }],
    }] };
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('Не удалось включить: Поесть.');
    expect(text).toContain('неполный маршрут');
  });

  it('shows the selected origin and exact identity of a walking stop', () => {
    const view = draftView();
    view.draft.points.origin = { lat: 56.326919, lon: 43.992346, locality_id: view.draft.locality.id,
      label: 'Ильинская улица, 13', source: 'place_choice' };
    view.result = { status: 'LIMITED', warnings: ['WALK_WAYPOINTS_INCOMPLETE'], days: [{
      day_id: view.draft.days[0]!.day_id, date: view.draft.days[0]!.date, status: 'LIMITED', missing_activity_ids: [],
      visits: [{ activity_id: 'a1', place_id: 'p1', name: 'Шуховская Башня',
        location_label: 'Канавинский район', starts_at: 976, ends_at: 1036,
        travel_before_minutes: 18, distance_before_meters: 1450, arrival_buffer_minutes: 5,
        price_expected_minor: null, warnings: [], source: { provider: '2gis',
          url: 'https://2gis.ru/n_novgorod/geo/70030077058045532', data_mode: 'live',
          fetched_at: '2026-09-25T00:00:00Z', valid_until: '2026-09-25T00:05:00Z' } }] }] };
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('Старт');
    expect(text).toContain('Ильинская улица, 13');
    expect(text).toContain('Канавинский район');
    expect(text).toContain('https://2gis.ru/n_novgorod/geo/70030077058045532');
    expect(text).toContain('только один ориентир');
  });

  it('renders transit variants, included waiting, actual observation times and the final leg without claiming guarantees', () => {
    const view = draftView(); view.draft.locality.timezone = 'Asia/Yekaterinburg';
    view.draft.shared.mobility = ['public_transport'];
    view.draft.points.destination = { lat: 55.75, lon: 37.62, locality_id: '32', label: 'Дом', source: 'user_map' };
    const source = { provider: '2gis', fetched_at: '2026-09-26T10:00:00Z', valid_until: '2026-09-26T10:05:00Z', data_mode: 'live' };
    const transit = { pedestrian: false, waitingSeconds: 300, transferCount: 0, crossingCount: 1,
      scheduleEvidence: 'unknown' as const, stages: [{ kind: 'passage' as const, transport: null, names: ['6', '8'],
        routes: [{ transport: 'bus', names: ['6'] }, { transport: 'trolleybus', names: ['8'] }],
        stop: 'Площадь', movingSeconds: 600, waitingSeconds: 300 }] };
    view.result = { status: 'AVAILABLE', warnings: ['PT_SCHEDULE_SEARCH_BOUNDED', 'PT_SCHEDULE_UNVERIFIED',
      'TRANSIT_PRICE_UNKNOWN', 'TRANSPORT_COST_UNKNOWN', 'ROUTE_TIME_IS_ESTIMATE', 'PT_SCHEDULE_UNVERIFIED'],
    valid_until: source.valid_until, total_expected_cost_minor: null, days: [{ day_id: 'd1', date: '2026-09-26',
      status: 'AVAILABLE', missing_activity_ids: [], ends_at: 1060,
      visits: [{ activity_id: 'a1', place_id: 'p1', name: 'Музей', starts_at: 985, ends_at: 1045,
        travel_before_minutes: 20, arrival_buffer_minutes: 5, price_expected_minor: null, warnings: [], source }],
      travel_segments: [{ from_id: '@origin', to_id: 'p1', departure_utc: Date.parse('2026-09-26T11:00:00Z') / 1000,
        mode: 'public_transport', coordinates: [], source, transit },
      { from_id: 'p1', to_id: '@destination', departure_utc: Date.parse('2026-09-26T12:25:00Z') / 1000,
        mode: 'public_transport', coordinates: [], source, transit: { ...transit, pedestrian: true, waitingSeconds: 0,
          stages: [{ kind: 'walkway', transport: null, names: [], stop: null, movingSeconds: 600, waitingSeconds: 0 }] } }],
    }] };
    const output = formatChatPlanMessages(view), text = output.map(message => message.text).join('\n');
    expect(text).toContain('Общественный транспорт');
    expect(text).toContain('Автобус 6 / Троллейбус 8'); expect(text).toContain('Площадь');
    expect(text).toContain('Ожидание ≈5 мин уже входит во время в пути');
    expect(text).toContain('15:00'); expect(text).toContain('Asia/Yekaterinburg');
    expect(text).toContain('Данные переходов'); expect(text).toContain('получены');
    expect(text).toContain('Финиш: Дом'); expect(text).toContain('17:40'); expect(text).toContain('В пути 15 мин');
    expect(text).toContain('Пешком');
    expect(text.match(/Стоимость проезда неизвестна/gu)).toHaveLength(1);
    expect(text.match(/Расписание не подтверждено/gu)).toHaveLength(1);
    expect(text).not.toMatch(/проверено в|прибытие гарантировано|PT_SCHEDULE/u);
    expect(output.every(message => message.text.length <= 3800)).toBe(true);
  });

  it('allowlists source URLs and does not manufacture a finish time or provenance from missing observations', () => {
    const view = draftView(); view.draft.locality.timezone = 'not-a-timezone';
    view.draft.points.destination = { lat: 55.75, lon: 37.62, locality_id: '32', label: 'Финишная точка' };
    const urls = ['https://2gis.ru/moscow/firm/123', 'https://2gis.ru.evil.test/moscow/firm/123',
      'https://user:password@2gis.ru/moscow/firm/123', 'https://2gis.ru/moscow/firm/123?secret=private',
      'https://2gis.ru/not-an-official-place'];
    view.result = { status: 'AVAILABLE', warnings: [], days: [{ day_id: 'd1', date: '2026-09-26', status: 'AVAILABLE',
      missing_activity_ids: [], visits: urls.map((url, index) => ({ activity_id: 'a1', place_id: `p${index}`,
        name: `Место ${index}`, starts_at: 960, ends_at: 1020, travel_before_minutes: 10, arrival_buffer_minutes: 5,
        price_expected_minor: null, warnings: [], source: { provider: '2gis', url,
          fetched_at: '2026-09-26T10:00:00Z', valid_until: 'bad-date', data_mode: 'test' } })) }] };
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('https://2gis.ru/moscow/firm/123');
    expect(text).not.toMatch(/evil\.test|password|secret=private|not-an-official-place|bad-date/u);
    expect(text).toContain('UTC'); expect(text).toContain('10:00'); expect(text).toContain('тестовые данные');
    expect(text).toContain('время прибытия не указано'); expect(text).not.toContain('В пути 0 мин');
  });

  it('splits a long transit stage without dropping its last variant, later visits, or the final destination', () => {
    const view = draftView(); view.draft.shared.mobility = ['public_transport'];
    view.draft.points.destination = { lat: 55.75, lon: 37.62, locality_id: '32', label: 'Последний финиш' };
    view.result = PublicPlan.parse({ status: 'AVAILABLE', warnings: ['ROUTE_GEOMETRY_UNAVAILABLE'], days: [{
      day_id: 'd1', date: '2026-09-26', status: 'AVAILABLE', missing_activity_ids: [], ends_at: 1080,
      visits: [{ activity_id: 'a1', place_id: 'p1', name: 'Последнее посещение', starts_at: 990, ends_at: 1050,
        travel_before_minutes: 25, arrival_buffer_minutes: 5, price_expected_minor: null, warnings: [] }],
      travel_segments: [{ from_id: '@origin', to_id: 'p1', departure_utc: 1790000000, mode: 'public_transport', coordinates: [],
        source: { provider: '2gis', fetched_at: '2026-09-26T10:00:00Z', valid_until: '2026-09-26T10:05:00Z', data_mode: 'test' },
        transit: { pedestrian: false, waitingSeconds: null, transferCount: 0, crossingCount: 0, scheduleEvidence: 'unknown',
          stages: [{ kind: 'passage', transport: 'bus', names: [], stop: 'Последняя остановка',
            routes: Array.from({ length: 30 }, (_, index) => ({ transport: 'bus', names: [`${'Название'.repeat(20)} ${index}-последний`] })),
            movingSeconds: null, waitingSeconds: null }] } }],
    }] });
    const messages = formatChatPlanMessages(view), text = messages.map(message => message.text).join('\n');
    expect(messages.every(message => message.text.length <= 3800)).toBe(true);
    expect(text).toContain('29-последний'); expect(text).toContain('Последняя остановка');
    expect(text).toContain('Последнее посещение'); expect(text).toContain('Последний финиш');
    expect(text).toContain('Отдельная оценка ожидания неизвестна');
    expect(text).toContain('на карте может не быть линии пути'); expect(text).not.toContain('Ожидание ≈0');
  });

  it('distinguishes exact event sessions from user-estimated visits with official sources and unknown admission facts', () => {
    const view = draftView();
    const source = { provider: 'kudago', url: 'https://kudago.com/nnv/event/synthetic-event/',
      fetched_at: '2026-09-26T10:00:00Z', valid_until: '2026-09-26T10:05:00Z', data_mode: 'test' };
    const event = { provider: 'kudago', event_id: '123', occurrence_key: 'a'.repeat(64), schedule_kind: 'fixed',
      duration_basis: 'provider_session', minimum_age: 6, official_start_utc: Date.parse('2026-09-26T10:00:30Z') / 1000,
      official_end_utc: Date.parse('2026-09-26T11:00:00Z') / 1000 };
    const visit = { activity_id: 'a1', place_id: 'event-fixed', name: 'Синтетический сеанс', starts_at: 780, ends_at: 840,
      travel_before_minutes: 20, arrival_buffer_minutes: 5, price_expected_minor: 0,
      warnings: ['EVENT_BOOKING_NOT_VERIFIED'], source, event };
    view.result = PublicPlan.parse({ status: 'AVAILABLE', warnings: ['EVENT_BOOKING_NOT_VERIFIED', 'EVENT_AGE_UNKNOWN'],
      days: [{ day_id: 'd1', date: '2026-09-26', status: 'AVAILABLE', missing_activity_ids: [], visits: [visit,
        { ...visit, activity_id: 'a2', place_id: 'event-window', name: 'Выставка', starts_at: 860, ends_at: 905,
          price_expected_minor: null, event: { ...event, schedule_kind: 'visit_window', duration_basis: 'user_estimate', minimum_age: null,
            official_start_utc: undefined, official_end_utc: undefined } }],
      }] });
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('Сеанс по данным KudaGo'); expect(text).toContain('13:00:30');
    expect(text).toContain('Посещение ≈45 мин'); expect(text).toContain('длительность, выбранная вами');
    expect(text).toContain('Возраст: 6+'); expect(text).toContain('Возрастное ограничение неизвестно');
    expect(text).toContain('Вход бесплатный по данным источника'); expect(text).toContain('Стоимость входа неизвестна');
    expect(text).toContain('Событие на KudaGo: https://kudago.com/nnv/event/synthetic-event/');
    expect(text).toContain('Данные событий: KudaGo');
    expect(text.match(/План не покупает билеты/gu)).toHaveLength(1);
    expect(text).not.toMatch(/билет подтверждён|бронь оформлена|EVENT_BOOKING|[a-f0-9]{64}/u);
  });

  it('explains bound event gaps without raw codes or claiming the city has no events', () => {
    const view = draftView(); view.draft.days[0]!.activities = [{ id: 'event-own', label: 'Моя выставка', requirements: [],
      intent_kind: 'event_visit', target: { kind: 'event', provider: 'kudago', event_id: '123', occurrence_key: 'a'.repeat(64) } }];
    view.result = PublicPlan.parse({ status: 'UNAVAILABLE', warnings: [], issues: ['EVENT_NOT_SCHEDULED'], event_gaps: [
      { day_id: 'd1', activity_id: 'event-own', code: 'EVENT_HTTP_BUDGET_EXHAUSTED' },
      { day_id: 'd1', activity_id: 'event-own', code: 'EVENT_HTTP_BUDGET_EXHAUSTED' },
      { day_id: 'd1', activity_id: 'event-own', code: 'EVENT_INTERNAL_PRIVATE_DETAIL' },
    ], days: [] });
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).toContain('Моя выставка'); expect(text).toContain('2026-09-26');
    expect(text.match(/Проверка события не завершена в пределах одного расчёта/gu)).toHaveLength(1);
    expect(text).toContain('проверить выбор заново');
    expect(text).not.toMatch(/EVENT_|INTERNAL|event-own|событий в городе нет/u);
  });

  it('rejects unsafe KudaGo links and never labels a source URL alone as a confirmed event', () => {
    const view = draftView();
    const urls = ['https://kudago.com.evil.test/nnv/event/test/', 'https://user:password@kudago.com/nnv/event/test/',
      'https://kudago.com/nnv/event/test/?private=query', 'https://kudago.com/nnv/place/not-event/'];
    view.result = PublicPlan.parse({ status: 'AVAILABLE', warnings: [], days: [{ day_id: 'd1', date: '2026-09-26',
      status: 'AVAILABLE', missing_activity_ids: [], visits: urls.map((url, index) => ({ activity_id: 'a1', place_id: `event-${index}`,
        name: 'Событие', starts_at: 780, ends_at: 840, travel_before_minutes: 5, arrival_buffer_minutes: 5, price_expected_minor: null,
        warnings: [], source: { provider: 'kudago', url, fetched_at: '2026-09-26T10:00:00Z', valid_until: '2026-09-26T10:05:00Z', data_mode: 'test' },
        event: { provider: 'kudago', event_id: '123', occurrence_key: 'a'.repeat(64), schedule_kind: 'fixed', duration_basis: 'provider_session', minimum_age: null },
      })) }] });
    const text = formatChatPlanMessages(view).map(message => message.text).join('\n');
    expect(text).not.toMatch(/evil\.test|password|private=query|not-event|https:\/\//u);
    expect(text).toContain('официальное время в данных не указано');
    expect(text).not.toContain('Сеанс по данным KudaGo:');
  });

  it('reopens saved event identity and own duration without restoring expired provider facts or invoking providers', async () => {
    const h = harness(), view = draftView(), routeId = '77777777-7777-4777-8777-777777777777';
    view.draft.days[0]!.activities = [{ id: 'saved-event', label: 'Expired provider title', intent_kind: 'event_visit', requirements: [],
      target: { kind: 'event', provider: 'kudago', event_id: '123', occurrence_key: 'a'.repeat(64), visit_duration_minutes: 45 } }];
    const saved = { id: view.id, revision: view.version, expires_at: '2026-10-25T00:00:00Z',
      conditions: projectSavedConditions(view, { now: new Date('2026-09-26T10:00:00Z') }) };
    h.navigation.routes.push({ id: routeId, draftId: view.id, createdAt: '2026-09-26T10:00:00Z', title: 'Saved event',
      requestText: '', localityName: 'Москва', status: 'draft' });
    const search = vi.fn(async () => { throw Error('must not fetch city or event'); });
    const chat = new MaxChatController({ ...h.deps, geography: { ...h.deps.geography, search },
      planning: { ...h.planning, get: () => { throw new PlanningSessionError('DRAFT_NOT_FOUND', 404); }, getSaved: async () => saved } });
    await chat.handle(press('open-saved-event-identity', `nav:open:${routeId}`));
    const text = h.messages.map(message => message.text).join('\n');
    expect(text).toContain('Выбранное событие: сеанс, площадку и условия нужно проверить заново');
    expect(text).toContain('45 мин — ваша оценка'); expect(text).not.toContain('Expired provider title');
    expect(text).not.toMatch(/kudago\.com|13:00|бесплатн/u);
    expect(h.planning.start).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
  });
});
