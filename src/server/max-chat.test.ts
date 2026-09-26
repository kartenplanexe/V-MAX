import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { PlanningView } from '../shared/planning-form.js';
import type { BotNavigation, OwnerState, PlanningDatabase } from './planning-database.js';
import { MaxChatController, formatChatPlanMessages, maxWebhookSecret, navigationButtons, registerMaxChatRoute } from './max-chat.js';

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

function harness() {
  const state: OwnerState = { receipts: {}, attempts: [] };
  const navigation: BotNavigation = { welcomed: false, mode: 'idle', routes: [] };
  const database = { withOwner: async (_owner: string, work: (state: OwnerState, save: () => Promise<void>, client: unknown) => Promise<unknown>) =>
    work(state, async () => {}, {}), withNavigation: async (_owner: string,
      work: (state: BotNavigation, save: () => Promise<void>) => Promise<unknown>) => work(navigation, async () => {}),
    recordUsage: async () => {} } as unknown as PlanningDatabase;
  const messages: { text: string; buttons?: unknown }[] = [];
  let view = draftView();
  const transport = { send: async (_userId: number, message: { text: string; buttons?: unknown }) => { messages.push(message); },
    answer: vi.fn(async () => {}) };
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
  it('welcomes on the native Start event before any chat text and exposes navigation', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    await chat.handle({ update_type: 'bot_started', user: { user_id: 123 }, timestamp: 123456 });
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]?.text).toMatch(/^Привет!/u);
    expect(h.messages[0]?.buttons).toEqual([[expect.objectContaining({ payload: 'nav:new' })]]);
    expect(h.planning.start).not.toHaveBeenCalled();
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
    expect(h.messages.at(-1)?.text).toContain('открытого маршрута');
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

  it('offers explicit refresh for an expired route, then uses its saved request only after the click', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    await chat.handle(message('route-old', 'Хочу погулять завтра с 16 до 19 в Москве'));
    const routeId = h.navigation.activeRouteId!;
    h.planning.get = vi.fn(async () => { throw new Error('unexpected'); }) as typeof h.planning.get;
    h.planning.get = vi.fn(async () => { const { PlanningSessionError } = await import('./planning-sessions.js');
      throw new PlanningSessionError('DRAFT_NOT_FOUND', 404); }) as typeof h.planning.get;
    await chat.handle(press('expired-open', `nav:open:${routeId}`));
    expect(h.messages.at(-1)?.text).toContain('данные устарели');
    expect(h.planning.start).toHaveBeenCalledTimes(1);
    await chat.handle(press('expired-refresh', `nav:refresh:${routeId}`));
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

  it('does not send two prompts for the first greeting', async () => {
    const h = harness(); const chat = new MaxChatController(h.deps);
    expect(await chat.handle(message('hello-first', 'Привет'))).toBe('handled');
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]?.text).toMatch(/^Привет!/u);
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
    expect(output.every(m => m.text.length <= 4000)).toBe(true);
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
});
