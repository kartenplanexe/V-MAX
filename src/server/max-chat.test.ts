import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { PlanningView } from '../shared/planning-form.js';
import type { OwnerState, PlanningDatabase } from './planning-database.js';
import { MaxChatController, formatChatPlanMessages, maxWebhookSecret, registerMaxChatRoute } from './max-chat.js';

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
  const database = { withOwner: async (_owner: string, work: (state: OwnerState, save: () => Promise<void>, client: unknown) => Promise<unknown>) =>
    work(state, async () => {}, {}), reserve: async () => {} } as unknown as PlanningDatabase;
  const messages: { text: string; buttons?: unknown }[] = [];
  let view = draftView();
  const transport = { send: async (_userId: number, message: { text: string; buttons?: unknown }) => { messages.push(message); },
    answer: vi.fn(async () => {}) };
  const planning = {
    start: vi.fn(async () => ({ status: 'draft' as const, view })),
    get: async () => view,
    edit: async (_owner: string, _id: string, input: { changes: { op: string }[] }) => {
      view = { ...view, version: view.version + 1, issues: [], draft: { ...view.draft,
        points: { origin: { lat: 55.75, lon: 37.61, locality_id: '32', label: 'Моё местоположение', source: 'user_geolocation' as const } } } };
      expect(input.changes[0]?.op).toBe('point'); return view;
    },
    confirm: async () => { view = { ...view, version: view.version + 1, phase: 'CONFIRMED' }; return view; },
    calculate: async () => { view = { ...view, version: view.version + 1, phase: 'RESULT', result: {
      status: 'AVAILABLE', warnings: [], days: [{ day_id: 'd1', date: '2026-09-26', status: 'AVAILABLE', missing_activity_ids: [],
        visits: [{ activity_id: 'a1', place_id: 'p1', name: 'Парк', starts_at: 960, ends_at: 1020,
          travel_before_minutes: 10, arrival_buffer_minutes: 5, price_expected_minor: 0, warnings: [] }] }] } }; return view; },
  };
  const deps = { database, geography: { search: async () => [{ id: '32', name: 'Москва', region_id: '32',
    timezone: 'Europe/Moscow', center: { lat: 55.75, lon: 37.61 }, token: 'trusted-city' }] },
    planning, transport, botUsername: 't801_hakaton_max_bot', dailyGeographyCalls: 100, mapEnabled: false };
  return { deps, messages, state, planning, transport };
}

const message = (mid: string, text?: string, attachments?: unknown[]) => ({ update_type: 'message_created',
  message: { sender: { user_id: 123, is_bot: false }, recipient: { chat_type: 'dialog' },
    body: { mid, text, attachments } } });

describe('MAX chat', () => {
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
    expect(h.messages.at(-1)?.buttons).toEqual([[expect.objectContaining({ text: 'Открыть подробный план' })]]);
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
});
