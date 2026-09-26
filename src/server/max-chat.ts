import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { getCACertificates } from 'node:tls';
import type { FastifyInstance } from 'fastify';
import type { PlanningView } from '../shared/planning-form.js';
import { isExactGreeting } from './intent-start.js';
import { InitialIntentError } from './intent-start.js';
import { PlanningSessionError } from './planning-sessions.js';
import type { BotNavigation, ChatPending, PlanningDatabase, SavedRoute } from './planning-database.js';
import type { AddressChoice, VerifiedLocality } from './live-geography.js';
import { russianTrustedRootCa } from './max-ca.js';

type Button = { type: 'callback' | 'open_app' | 'request_geo_location'; text: string;
  payload?: string; web_app?: string };
type Message = { text: string; buttons?: Button[][] };
type Incoming = { kind: 'started' | 'message' | 'callback'; userId: number; eventId: string;
  text?: string; location?: { lat: number; lon: number }; payload?: string; callbackId?: string };

export interface MaxChatDependencies {
  database: PlanningDatabase;
  geography: { search(q: string): Promise<(VerifiedLocality & { token: string })[]>;
    searchAddress(q: string, cityId: string): Promise<AddressChoice[]> };
  planning: {
    start(owner: string, input: unknown): Promise<{ status: 'off_topic' } | { status: 'draft'; view: PlanningView }>;
    get(owner: string, id: string): Promise<PlanningView> | PlanningView;
    edit(owner: string, id: string, input: unknown): Promise<PlanningView> | PlanningView;
    confirm(owner: string, id: string, input: unknown): Promise<PlanningView> | PlanningView;
    calculate(owner: string, id: string, input: unknown): Promise<PlanningView>;
    remove(owner: string, id: string): Promise<void> | void;
  };
  transport: { send(userId: number, message: Message): Promise<void>; answer(callbackId: string): Promise<void> };
  botUsername: string;
  mapEnabled: boolean;
  onIntentDiagnostic?: (code: string, diagnostic: InitialIntentError['diagnostic']) => void;
  onCallbackDiagnostic?: (code: string) => void;
}

const eventKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const welcomeText = 'Привет! Я помогу составить план досуга прямо в чате. Опишите желание своими словами — например: «Завтра после 16 хочу погулять в Казани и поесть». Или выберите действие ниже.';
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const appButton = (botUsername: string, text = 'Подробнее и карта'): Button => ({ type: 'open_app', text, web_app: botUsername });
const callback = (text: string, payload: string): Button => ({ type: 'callback', text, payload });
const keyboard = (buttons: Button[][]): Message['buttons'] => buttons;
type NavigationSurface = 'menu' | 'draft' | 'result' | 'list';
export const navigationButtons = (state: BotNavigation, surface: NavigationSurface = 'menu'): Button[][] => {
  const newRoute = callback('➕ Новый маршрут', 'nav:new');
  const routes = callback('📋 Мои маршруты', 'nav:list:0');
  const exit = callback(state.mode === 'awaiting_request' ? '↩️ Отменить новый маршрут' : '↩️ Выйти из планирования', 'nav:exit');
  if (surface === 'list') {
    if (state.mode === 'planning' && state.activeRouteId) return [
      [callback('↩️ К текущему маршруту', `nav:open:${state.activeRouteId}`), newRoute], [exit],
    ];
    return state.mode === 'awaiting_request' ? [[newRoute, exit]] : [[newRoute]];
  }
  if (state.mode === 'awaiting_request') return state.routes.length ? [[routes, exit]] : [[exit]];
  if (state.mode !== 'planning' || !state.activeRouteId)
    return state.routes.length ? [[newRoute, routes]] : [[newRoute]];
  if (surface === 'draft') return [[routes, exit]];
  if (surface === 'result') return [[newRoute, routes], [exit]];
  return [[callback('↩️ Продолжить маршрут', `nav:open:${state.activeRouteId}`)], [newRoute, routes], [exit]];
};
export const routeTitle = (view: PlanningView) => {
  const first = view.draft.days[0];
  const activity = first?.activities.map(item => item.label).slice(0, 2).join(' → ');
  return [view.draft.locality.name, first?.date, activity].filter(Boolean).join(' · ').slice(0, 120);
};

function parseUpdate(raw: unknown): Incoming | null {
  if (!raw || typeof raw !== 'object') return null;
  const update = raw as Record<string, any>;
  if (update.update_type === 'bot_started' && Number.isSafeInteger(update.user?.user_id)) {
    return { kind: 'started', userId: update.user.user_id, eventId: eventKey(`started:${update.user.user_id}:${update.timestamp}`) };
  }
  if (update.update_type === 'message_created') {
    const message = update.message;
    if (!Number.isSafeInteger(message?.sender?.user_id) || message.sender.is_bot ||
        message?.recipient?.chat_type !== 'dialog' || typeof message?.body?.mid !== 'string') return null;
    const location = message.body.attachments?.find((a: any) => a?.type === 'location' &&
      Number.isFinite(a.latitude ?? a.payload?.latitude) && Number.isFinite(a.longitude ?? a.payload?.longitude));
    return { kind: 'message', userId: message.sender.user_id, eventId: eventKey(`message:${message.body.mid}`),
      text: typeof message.body.text === 'string' ? message.body.text.trim().slice(0, 4000) : undefined,
      ...(location ? { location: { lat: location.latitude ?? location.payload.latitude,
        lon: location.longitude ?? location.payload.longitude } } : {}) };
  }
  if (update.update_type === 'message_callback') {
    const item = update.callback;
    if (!Number.isSafeInteger(item?.user?.user_id) || typeof item?.callback_id !== 'string' ||
        typeof item?.payload !== 'string' || (update.message && update.message.recipient?.chat_type !== 'dialog')) return null;
    return { kind: 'callback', userId: item.user.user_id, eventId: eventKey(`callback:${item.callback_id}`),
      callbackId: item.callback_id, payload: item.payload };
  }
  return null;
}

/** Webhook secret is not a second manually managed credential; never expose the derived value. */
export function maxWebhookSecret(botToken: string) {
  return createHash('sha256').update('v-max:webhook:v1:' + botToken).digest('hex');
}
export function validMaxWebhookSecret(actual: unknown, botToken: string) {
  if (!botToken || typeof actual !== 'string') return false;
  const expected = Buffer.from(maxWebhookSecret(botToken));
  const given = Buffer.from(actual);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function summary(view: PlanningView) {
  const parts = [`Я правильно понял?\n📍 ${view.draft.locality.name}`];
  for (const day of view.draft.days) {
    const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
      .format(new Date(`${day.date}T12:00:00Z`));
    parts.push(`📅 ${date}${day.window ? ` · ${day.window.start}–${day.window.end}` : ' · время уточним'}`);
    if (day.activities.length) parts.push(`✨ ${day.activities.map(a => a.label).join(' → ')}`);
  }
  const mobility = view.draft.shared.mobility?.[0];
  if (mobility) parts.push(`🚶 ${mobility === 'walking' ? 'Пешком' : mobility === 'driving' ? 'На машине' : 'На велосипеде'}`);
  const budget = view.draft.shared.budget;
  if (budget?.kind === 'limit') parts.push(`💳 До ${budget.amount_rub} ₽`);
  if (view.draft.points.origin) parts.push(`↗️ Старт: ${view.draft.points.origin.label ?? 'выбранная точка'}`);
  if (Object.values(view.provenance).includes('suggested')) parts.push('Время без точных часов — наше предложение, его можно изменить.');
  return parts.join('\n').slice(0, 3900);
}

export function formatChatPlanMessages(view: PlanningView): Message[] {
  const result = view.result;
  if (!result) return [{ text: 'План ещё не рассчитан.' }];
  const routeCheckFailed = result.warnings.some(warning =>
    ['ROUTING_PROVIDER_FAILURE', 'ROUTE_MATRIX_INCOMPLETE'].includes(warning));
  const searchIncomplete = result.warnings.includes('RETRIEVAL_PARTIAL');
  const tentative = result.warnings.includes('OPENING_HOURS_UNVERIFIED');
  const lead = result.status === 'AVAILABLE' ? 'Готово — вот план:' : result.status === 'LIMITED'
    ? tentative ? 'Предварительный план: доступность места на это время не подтверждена.' : 'Удалось составить часть плана:' : result.status === 'ERROR'
      ? 'Сервис мест или маршрутов временно не ответил.' : routeCheckFailed
        ? 'Места могли найтись, но сейчас не удалось проверить путь до них.'
        : searchIncomplete ? 'Поиск мест завершился не полностью; проверенного плана пока нет.'
          : 'Пока нет проверенного плана для этих условий.';
  const messages: Message[] = [{ text: lead }];
  const planOrigin = result.origin ?? view.draft.points.origin;
  for (const day of result.days) {
    const lines = [`📅 ${day.date}`];
    const draftDay = view.draft.days.find(candidate => candidate.day_id === day.day_id);
    if (day.visits.length && planOrigin) {
      lines.push(`📍 Старт${draftDay?.window ? ` ${draftDay.window.start}` : ''}: ${planOrigin.label ?? 'выбранная точка'}`);
    }
    for (const visit of day.visits) {
      lines.push(`${clock(visit.starts_at)}–${clock(visit.ends_at)}  ${visit.name}`);
      if (visit.location_label) lines.push(`📍 ${visit.location_label}`);
      lines.push(`В пути ${visit.travel_before_minutes} мин${visit.distance_before_meters == null ? '' : ` / ≈${Math.round(visit.distance_before_meters / 100) / 10} км`} · запас ${visit.arrival_buffer_minutes} мин · ${visit.price_expected_minor == null ? 'цена неизвестна' : `≈ ${visit.price_expected_minor / 100} ₽`}`);
      if (visit.warnings.includes('OPENING_HOURS_UNVERIFIED')) lines.push('Часы работы не указаны; проверьте доступность перед выходом.');
      if (visit.source) lines.push(`Источник: ${visit.source.provider}`);
      if (visit.source?.provider === '2gis' && visit.source.url?.startsWith('https://2gis.ru/'))
        lines.push(`Место в 2ГИС: ${visit.source.url}`);
    }
    if (result.warnings.includes('WALK_WAYPOINTS_INCOMPLETE') && day.visits.length === 1)
      lines.push('Пока удалось подобрать только один ориентир прогулки; это не полный прогулочный маршрут.');
    if (day.missing_activity_ids.length) lines.push('Не все пожелания удалось включить.');
    if (!day.visits.length) lines.push(routeCheckFailed
      ? 'Не будем выдавать непроверенный маршрут. Повторите расчёт позже.'
      : searchIncomplete ? 'Поиск охватил только часть мест. Для этих условий проверенный маршрут не получился.'
        : 'В проверенной части поиска подходящий маршрут не получился. Можно изменить время или точку старта.');
    let chunk = '';
    for (const line of lines) {
      if ((chunk + '\n' + line).length > 3800 && chunk) { messages.push({ text: chunk }); chunk = ''; }
      chunk += (chunk ? '\n' : '') + line.slice(0, 3800);
    }
    if (chunk) messages.push({ text: chunk });
  }
  if (result.days.some(day => day.visits.length) && result.total_expected_cost_minor != null)
    messages.push({ text: `Ожидаемые расходы: ≈ ${result.total_expected_cost_minor / 100} ₽. Время и расходы могут быть приблизительными.` });
  if (messages.length === 1) messages[0]!.text += '\nМожно изменить время или точку старта.';
  return messages;
}

export class MaxChatController {
  constructor(private readonly deps: MaxChatDependencies) {}

  private async pending(owner: string) {
    return this.deps.database.withOwner(owner, async (state) => structuredClone(state.chat?.pending));
  }
  private async setPending(owner: string, pending: ChatPending | undefined) {
    await this.deps.database.withOwner(owner, async (state, save) => {
      state.chat ??= { seen: {} }; state.chat.pending = pending; await save();
    });
  }
  private async claim(owner: string, key: string) {
    return this.deps.database.withOwner(owner, async (state, save) => {
      state.chat ??= { seen: {} };
      const now = Date.now();
      for (const [id, receipt] of Object.entries(state.chat.seen)) if (now - receipt.at > 1_800_000) delete state.chat.seen[id];
      const previous = state.chat.seen[key];
      if (previous?.status === 'done') return 'done';
      if (previous && now - previous.at < 60_000) return 'running';
      state.chat.seen[key] = { at: now, status: 'pending' }; await save(); return 'claimed';
    });
  }
  private async finish(owner: string, key: string) {
    await this.deps.database.withOwner(owner, async (state, save) => {
      state.chat ??= { seen: {} }; state.chat.seen[key] = { at: Date.now(), status: 'done' }; await save();
    });
  }
  private async send(userId: number, message: Message) { await this.deps.transport.send(userId, message); }
  private async navigation(owner: string) {
    return this.deps.database.withNavigation(owner, async state => structuredClone(state));
  }
  private async changeNavigation<T>(owner: string, change: (state: BotNavigation) => T) {
    return this.deps.database.withNavigation(owner, async (state, save) => {
      const result = change(state); await save(); return result;
    });
  }
  private async welcome(owner: string, userId: number, force = false) {
    return this.deps.database.withNavigation(owner, async (state, save) => {
      if (state.welcomed && !force) return false;
      const active = state.mode === 'planning' ? state.routes.find(route => route.id === state.activeRouteId) : null;
      await this.send(userId, { text: welcomeText + (active ? `\n\nСейчас открыт маршрут: ${active.title}` : ''),
        buttons: navigationButtons(state) });
      state.welcomed = true;
      await save();
      return true;
    });
  }

  private async startNew(owner: string, userId: number) {
    await this.setPending(owner, undefined);
    const state = await this.changeNavigation(owner, state => {
      state.mode = 'awaiting_request'; delete state.activeRouteId; delete state.deletePendingRouteId;
      return structuredClone(state);
    });
    await this.send(userId, { text: 'Новый маршрут. Напишите, как хотите провести время — например: «Завтра после 16 погулять в Казани и поесть».',
      buttons: navigationButtons(state) });
  }

  private async exitPlanning(owner: string, userId: number) {
    await this.setPending(owner, undefined);
    const state = await this.changeNavigation(owner, state => {
      state.mode = 'idle'; delete state.activeRouteId; delete state.deletePendingRouteId;
      return structuredClone(state);
    });
    await this.send(userId, { text: state.routes.length
      ? 'Вышли из планирования. Сохранённые маршруты — в «Моих маршрутах».' : 'Вы вне режима планирования.',
      buttons: navigationButtons(state) });
  }

  private async listRoutes(owner: string, userId: number, page = 0) {
    const state = await this.changeNavigation(owner, value => {
      delete value.deletePendingRouteId;
      return structuredClone(value);
    });
    const routes = [...state.routes].reverse();
    if (!routes.length) {
      await this.send(userId, { text: 'У вас пока нет маршрутов. Составим первый?', buttons: [[callback('➕ Новый маршрут', 'nav:new')]] });
      return;
    }
    const maxPage = Math.ceil(routes.length / 5) - 1;
    const current = Math.max(0, Math.min(page, maxPage));
    const slice = routes.slice(current * 5, current * 5 + 5);
    const lines = slice.map((route, index) => `${current * 5 + index + 1}. ${route.title}${route.id === state.activeRouteId ? ' · открыт' : ''}`);
    const buttons: Button[][] = slice.map(route => [callback(route.title.slice(0, 48), `nav:open:${route.id}`),
      callback('Удалить', `nav:delete-confirm:${route.id}`)]);
    if (current > 0 || current < maxPage) buttons.push([
      ...(current > 0 ? [callback('← Назад', `nav:list:${current - 1}`)] : []),
      ...(current < maxPage ? [callback('Дальше →', `nav:list:${current + 1}`)] : []),
    ]);
    buttons.push(...navigationButtons(state, 'list'));
    await this.send(userId, { text: `Мои маршруты (${routes.length}):\n${lines.join('\n')}\n\nВыберите маршрут, чтобы продолжить. Записи хранятся до 30 дней; любую можно удалить. Места при повторном расчёте проверяются заново.`, buttons });
  }

  private async openRoute(owner: string, userId: number, routeId: string) {
    const route = await this.changeNavigation(owner, state => {
      const selected = state.routes.find(item => item.id === routeId);
      if (!selected) return null;
      state.mode = 'planning'; state.activeRouteId = routeId; delete state.deletePendingRouteId;
      return structuredClone(selected);
    });
    if (!route) { await this.listRoutes(owner, userId); return; }
    await this.setPending(owner, undefined);
    try {
      const view = await this.deps.planning.get(owner, route.draftId);
      if (view.result) await this.sendPlan(userId, view);
      else await this.showDraft(userId, view);
    } catch (error) {
      if (!(error instanceof PlanningSessionError) || error.code !== 'DRAFT_NOT_FOUND') throw error;
      const state = await this.navigation(owner);
      await this.send(userId, { text: `Маршрут «${route.title}» открыт. Его данные устарели; для нового расчёта нужно ещё раз проверить город и места.`,
        buttons: [[callback('🔄 Обновить маршрут', `nav:refresh:${route.id}`)], ...navigationButtons(state, 'draft')] });
    }
  }

  private async sendPlan(userId: number, view: PlanningView) {
    const messages = formatChatPlanMessages(view);
    const state = await this.navigation(`max:${userId}`);
    const route = state.routes.find(item => item.id === state.activeRouteId && item.draftId === view.id);
    if (route) messages[0]!.text = `Маршрут: ${route.title}\n\n${messages[0]!.text}`;
    messages.at(-1)!.buttons = [[appButton(this.deps.botUsername,
      this.deps.mapEnabled ? 'Открыть ленту и карту' : 'Открыть подробный план')], ...navigationButtons(state, 'result')];
    for (let i = 0; i < messages.length; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, 550));
      await this.send(userId, messages[i]!);
    }
  }

  async handle(raw: unknown) {
    const update = parseUpdate(raw);
    if (!update) return 'ignored' as const;
    const owner = `max:${update.userId}`;
    const claimed = await this.claim(owner, update.eventId);
    if (claimed === 'done') return 'duplicate' as const;
    if (claimed === 'running') return 'retry_later' as const;
    try {
      if (update.kind === 'callback' && update.callbackId) {
        try { await this.deps.transport.answer(update.callbackId); }
        catch (error) {
          // A callback acknowledgement is best-effort: MAX may reject an empty
          // answer, but the user's navigation action must still be processed.
          this.deps.onCallbackDiagnostic?.(error instanceof Error ? error.message : 'UNKNOWN');
        }
      }
      if (update.kind === 'started' || update.text === '/start') await this.welcome(owner, update.userId, true);
      else if (update.kind === 'callback') await this.handleCallback(owner, update);
      else {
        const firstWelcome = await this.welcome(owner, update.userId);
        if (!firstWelcome || !isExactGreeting(update.text ?? '')) await this.handleMessage(owner, update);
      }
      await this.finish(owner, update.eventId);
      return 'handled' as const;
    } catch (error) {
      if (error instanceof InitialIntentError || error instanceof PlanningSessionError) {
        if (error instanceof InitialIntentError)
          this.deps.onIntentDiagnostic?.(error.code, error.diagnostic ?? { stage: 'control' });
        const text = error.code === 'INTENT_INVALID_RESPONSE' ? 'Не удалось надёжно понять пожелание. Попробуйте написать его другими словами.'
          : error.code === 'INTENT_PROVIDER_FAILED' ? 'Сервис разбора сейчас не отвечает. Попробуйте написать запрос позже.'
            : error.code === 'CATALOG_UNAVAILABLE' ? 'Каталог 2ГИС сейчас недоступен. Новый маршрут пока не создать; сохранённые маршруты можно открыть через «Мои маршруты».'
            : error.code === 'POINT_OUTSIDE_AREA' ? 'Точка за пределами выбранного города. Укажите другой адрес, местоположение или точку на карте.'
              : error.code === 'GEOGRAPHY_UNAVAILABLE' ? 'Сейчас не получилось проверить адрес в 2ГИС. Попробуйте позже или отправьте местоположение.'
                : 'Не получилось обработать этот шаг. Проверьте условия и попробуйте ещё раз.';
        await this.send(update.userId, { text });
        await this.finish(owner, update.eventId);
        return 'handled' as const;
      }
      throw error;
    }
  }

  private async handleMessage(owner: string, update: Incoming) {
    const text = update.text?.trim();
    if (text === '/new') { await this.startNew(owner, update.userId); return; }
    if (text === '/routes') { await this.listRoutes(owner, update.userId); return; }
    if (text === '/exit') { await this.exitPlanning(owner, update.userId); return; }
    if (text === '/menu') {
      const state = await this.navigation(owner);
      const active = state.routes.find(route => route.id === state.activeRouteId);
      await this.send(update.userId, { text: active ? `Сейчас планируем: ${active.title}`
        : state.mode === 'awaiting_request' ? 'Жду описание нового маршрута.' : 'Сейчас вы вне режима планирования.',
      buttons: navigationButtons(state) });
      return;
    }
    const pending = await this.pending(owner);
    if ((pending?.kind === 'origin' || pending?.kind === 'origin_address' || pending?.kind === 'destination') && update.location) {
      const view = await this.deps.planning.get(owner, pending.draftId);
      const field = pending.kind === 'destination' ? 'destination' : 'origin';
      const patched = await this.deps.planning.edit(owner, pending.draftId, { base_version: view.version,
        event_id: update.eventId, changes: [{ op: 'point', field, point: {
          ...update.location, label: field === 'origin' ? 'Моё местоположение' : 'Точка завершения', source: 'user_geolocation' } }] });
      await this.setPending(owner, undefined);
      await this.showDraft(update.userId, patched);
      return;
    }
    if (pending?.kind === 'origin_address' && text) {
      await this.chooseAddress(owner, update.userId, pending.draftId, text); return;
    }
    if (pending?.kind === 'origin' && text) {
      const state = await this.navigation(owner);
      await this.send(update.userId, { text: 'Сейчас выбираем стартовую точку открытого маршрута. Нажмите «Моё местоположение» или «Ввести адрес» под сводкой; новый маршрут можно начать отдельно.',
        buttons: navigationButtons(state, 'draft') });
      return;
    }
    if (pending?.kind === 'destination') {
      await this.send(update.userId, { text: 'Отправьте геолокацию кнопкой под предыдущим сообщением или выберите точку в мини-приложении. Для нового плана напишите /new.' });
      return;
    }
    if (!text) {
      await this.send(update.userId, { text: 'Напишите пожелание о досуге или отправьте геолокацию после запроса точки старта.' });
      return;
    }
    if (pending?.kind === 'city') {
      await this.chooseCity(owner, update.userId, pending.requestText, pending.requestId, text, pending.routeId);
      return;
    }
    if (pending?.kind === 'party') {
      const total = Number(text);
      if (!Number.isSafeInteger(total) || total < 1 || total > 100) {
        await this.send(update.userId, { text: 'Сколько будет человек? Пришлите одно число от 1 до 100.' }); return;
      }
      const view = await this.deps.planning.get(owner, pending.draftId);
      const patched = await this.deps.planning.edit(owner, pending.draftId, { base_version: view.version,
        event_id: update.eventId, changes: [{ op: 'party', total }] });
      await this.setPending(owner, undefined); await this.showDraft(update.userId, patched); return;
    }
    if (isExactGreeting(text)) {
      const state = await this.navigation(owner);
      await this.send(update.userId, { text: 'Напишите, когда и чем хотите заняться. Например: «Завтра после 16 хочу погулять и поесть в Казани».',
        buttons: navigationButtons(state) });
      return;
    }
    const nav = await this.navigation(owner);
    if (nav.mode === 'planning' && nav.activeRouteId) {
      const route = nav.routes.find(item => item.id === nav.activeRouteId);
      await this.send(update.userId, { text: `Сейчас открыт маршрут «${route?.title ?? 'мой маршрут'}». Чтобы не потерять его условия, новый текст не создаёт другой план автоматически. Выберите «Новый маршрут» или откройте детали текущего.`,
        buttons: [[appButton(this.deps.botUsername, 'Изменить текущий план')], ...navigationButtons(nav)] });
      return;
    }
    const city = text.match(/(?:^|[\s,.;!?])(?:в|во)\s+([А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+)?)/u)?.[1];
    if (city) {
      await this.chooseCity(owner, update.userId, text, update.eventId, city);
      return;
    }
    await this.setPending(owner, { kind: 'city', requestText: text, requestId: update.eventId, nonce: randomUUID().slice(0, 8) });
    await this.send(update.userId, { text: 'В каком городе или населённом пункте составить план? Напишите название — остальное пожелание уже запомнил.' });
  }

  private async chooseCity(owner: string, userId: number, requestText: string, requestId: string, cityText: string, routeId?: string) {
    const choices = await this.deps.database.withOwner(owner, async (_state, _save, db) => {
      await this.deps.database.recordUsage(db, 'geography');
      return this.deps.geography.search(cityText);
    });
    if (!choices.length) {
      await this.setPending(owner, { kind: 'city', requestText, requestId, routeId, nonce: randomUUID().slice(0, 8) });
      await this.send(userId, { text: 'Не нашёл этот населённый пункт в доступных данных. Уточните название и регион.' });
      return;
    }
    if (choices.length === 1) { await this.beginPlan(owner, userId, requestText, requestId, choices[0]!.token, routeId); return; }
    const nonce = randomUUID().slice(0, 8);
    await this.setPending(owner, { kind: 'city', requestText, requestId, routeId, nonce,
      choices: choices.map(c => ({ name: c.name, token: c.token })) });
    await this.send(userId, { text: 'Нашёл несколько населённых пунктов. Выберите нужный:',
      buttons: keyboard(choices.map((c, i) => [callback(c.name, `city:${nonce}:${i}`)])) });
  }

  private async chooseAddress(owner: string, userId: number, draftId: string, query: string) {
    const q = query.trim();
    if (q.length < 4 || q.length > 120) {
      await this.send(userId, { text: 'Напишите адрес с улицей и номером дома — от 4 до 120 символов.' }); return;
    }
    const view = await this.deps.planning.get(owner, draftId);
    const choices = await this.addressChoices(owner, q, view.draft.locality.id);
    if (!choices.length) {
      await this.setPending(owner, { kind: 'origin_address', draftId });
      await this.send(userId, { text: 'Не нашёл точный адрес в выбранном городе. Напишите улицу и номер дома иначе или отправьте местоположение.' });
      return;
    }
    const nonce = randomUUID().slice(0, 8);
    await this.setPending(owner, { kind: 'origin_address', draftId, query: q, nonce });
    await this.send(userId, { text: 'Где начинаем? Выберите найденный адрес:',
      buttons: keyboard(choices.map(choice => [callback(choice.label.slice(0, 80), `origin-address-choice:${nonce}:${choice.id}`)])) });
  }

  private async addressChoices(owner: string, query: string, cityId: string) {
    return this.deps.database.withOwner(owner, async (_state, _save, db) => {
      await this.deps.database.recordUsage(db, 'geography');
      return this.deps.geography.searchAddress(query, cityId);
    });
  }

  private async beginPlan(owner: string, userId: number, text: string, requestId: string, localityToken: string, routeId?: string) {
    const nav = await this.navigation(owner);
    if (routeId && (nav.activeRouteId !== routeId || !nav.routes.some(route => route.id === routeId))) {
      await this.listRoutes(owner, userId); return;
    }
    const result = await this.deps.planning.start(owner, { event_id: requestId, user_text: text, locality_token: localityToken });
    await this.setPending(owner, undefined);
    if (result.status === 'off_topic') {
      const state = await this.navigation(owner);
      await this.send(userId, { text: 'Напишите, чем хочется заняться и когда. Например: «Завтра вечером погулять в Казани».', buttons: navigationButtons(state) });
      return;
    }
    await this.changeNavigation(owner, state => {
      const existing = routeId ? state.routes.find(item => item.id === routeId) : undefined;
      if (routeId && !existing) throw new PlanningSessionError('ROUTE_NOT_FOUND', 404);
      if (existing) {
        existing.draftId = result.view.id; existing.title = routeTitle(result.view);
        existing.localityName = result.view.draft.locality.name; existing.status = 'draft';
      } else {
        const saved: SavedRoute = { id: randomUUID(), createdAt: new Date().toISOString(), title: routeTitle(result.view),
          requestText: text, localityName: result.view.draft.locality.name, draftId: result.view.id, status: 'draft' };
        state.routes.push(saved); routeId = saved.id;
      }
      state.mode = 'planning'; state.activeRouteId = routeId;
    });
    await this.showDraft(userId, result.view);
  }

  private async showDraft(userId: number, view: PlanningView) {
    const owner = `max:${userId}`;
    const nav = await this.navigation(owner);
    const active = nav.routes.find(route => route.id === nav.activeRouteId && route.draftId === view.id);
    const buttons: Button[][] = [];
    const issue = view.issues[0];
    let question = '';
    if (issue?.code === 'ORIGIN_REQUIRED') {
      question = '\n\nОткуда удобнее начать? Выберите способ:';
      buttons.push([{ type: 'request_geo_location', text: 'Моё местоположение' }]);
      if (this.deps.mapEnabled) buttons.push([appButton(this.deps.botUsername, 'Выбрать на карте')]);
      buttons.push([callback('Ввести адрес', `origin-address:${view.id}:${view.version}`)]);
      await this.setPending(owner, { kind: 'origin', draftId: view.id });
    } else if (issue?.code === 'DESTINATION_REQUIRED') {
      question = '\n\nГде закончить маршрут? Отправьте геолокацию нужной точки или уберите финиш.';
      buttons.push([{ type: 'request_geo_location', text: 'Отправить точку финиша' }]);
      buttons.push([callback('Финиш не важен', `clear-destination:${view.id}:${view.version}`)]);
      if (this.deps.mapEnabled) buttons.push([appButton(this.deps.botUsername, 'Выбрать на карте')]);
      await this.setPending(owner, { kind: 'destination', draftId: view.id });
    } else if (issue?.code === 'TRANSPORT_REQUIRED') {
      question = '\n\nКак будем передвигаться?';
      buttons.push(view.capabilities.modes.map(mode => callback(
        mode === 'walking' ? 'Пешком' : mode === 'driving' ? 'Машина' : 'Велосипед',
        `mobility:${view.id}:${view.version}:${mode}`)));
      await this.setPending(owner, undefined);
    } else if (issue?.code === 'BUDGET_SCOPE_REQUIRED') {
      question = '\n\nУточните, на кого и на какой срок указан бюджет:';
      buttons.push([callback('На всех за день', `budget:${view.id}:${view.version}:whole_party:per_day`),
        callback('На человека за день', `budget:${view.id}:${view.version}:per_person:per_day`)]);
      buttons.push([callback('На всех за поездку', `budget:${view.id}:${view.version}:whole_party:whole_trip`),
        callback('На человека за поездку', `budget:${view.id}:${view.version}:per_person:whole_trip`)]);
      await this.setPending(owner, undefined);
    } else if (issue?.code === 'PARTY_REQUIRED') {
      question = '\n\nСколько будет человек? Напишите одно число.';
      await this.setPending(owner, { kind: 'party', draftId: view.id });
    } else if (issue?.code === 'WINDOW_EXPIRED') {
      question = '\n\nЭто время уже прошло. Перенести тот же план на завтра?';
      buttons.push([callback('На завтра', `next-day:${view.id}:${view.version}`)]);
      buttons.push([appButton(this.deps.botUsername, 'Изменить время')]);
      await this.setPending(owner, undefined);
    } else if (issue?.code === 'WINDOW_REQUIRED') {
      question = '\n\nВ какое время вы свободны? Можно выбрать предложение:';
      buttons.push([callback('09–11', `window:${view.id}:${view.version}:09:00:11:00`),
        callback('13–15', `window:${view.id}:${view.version}:13:00:15:00`),
        callback('18–20', `window:${view.id}:${view.version}:18:00:20:00`)]);
      await this.setPending(owner, undefined);
    } else if (!issue) {
      question = '\n\nЕсли всё верно, составлю маршрут и проверю время в пути.';
      buttons.push([callback('Составить план', `plan:${view.id}:${view.version}`)]);
      buttons.push([appButton(this.deps.botUsername, 'Изменить детали')]);
      await this.setPending(owner, undefined);
    } else {
      question = '\n\nЭтот параметр нужно уточнить перед расчётом. Откройте условия или напишите новый запрос.';
      buttons.push([appButton(this.deps.botUsername, 'Уточнить детали')]);
      await this.setPending(owner, undefined);
    }
    buttons.push(...navigationButtons(nav, 'draft'));
    await this.send(userId, { text: `Маршрут: ${active?.title ?? routeTitle(view)}\n\n${summary(view)}${question}`, buttons });
  }

  private async handleCallback(owner: string, update: Incoming) {
    const payload = update.payload ?? '';
    if (payload === 'nav:new') { await this.startNew(owner, update.userId); return; }
    if (payload === 'nav:exit') { await this.exitPlanning(owner, update.userId); return; }
    if (/^nav:list:\d{1,2}$/u.test(payload)) {
      await this.listRoutes(owner, update.userId, Number(payload.split(':')[2])); return;
    }
    if (/^nav:open:[0-9a-f-]{36}$/u.test(payload)) {
      await this.openRoute(owner, update.userId, payload.slice('nav:open:'.length)); return;
    }
    if (/^nav:refresh:[0-9a-f-]{36}$/u.test(payload)) {
      const routeId = payload.slice('nav:refresh:'.length);
      const state = await this.navigation(owner);
      const route = state.routes.find(item => item.id === routeId);
      if (!route || state.activeRouteId !== routeId) { await this.listRoutes(owner, update.userId); return; }
      await this.chooseCity(owner, update.userId, route.requestText, update.eventId, route.localityName, route.id);
      return;
    }
    if (/^nav:delete-confirm:[0-9a-f-]{36}$/u.test(payload)) {
      const routeId = payload.slice('nav:delete-confirm:'.length);
      const route = await this.changeNavigation(owner, state => {
        const found = state.routes.find(item => item.id === routeId);
        if (found) state.deletePendingRouteId = routeId;
        return found ? structuredClone(found) : null;
      });
      if (!route) { await this.listRoutes(owner, update.userId); return; }
      await this.send(update.userId, { text: `Удалить маршрут «${route.title}» из вашего списка?`,
        buttons: [[callback('Да, удалить', `nav:delete:${routeId}`), callback('Отмена', 'nav:list:0')]] });
      return;
    }
    if (/^nav:delete:[0-9a-f-]{36}$/u.test(payload)) {
      const routeId = payload.slice('nav:delete:'.length);
      const selected = await this.navigation(owner);
      const route = selected.deletePendingRouteId === routeId ? selected.routes.find(item => item.id === routeId) : null;
      if (!route) { await this.listRoutes(owner, update.userId); return; }
      try { await this.deps.planning.remove(owner, route.draftId); }
      catch (error) {
        if (!(error instanceof PlanningSessionError) || error.code !== 'DRAFT_NOT_FOUND') throw error;
      }
      const removed = await this.changeNavigation(owner, state => {
        if (state.deletePendingRouteId !== routeId) return false;
        delete state.deletePendingRouteId;
        state.routes = state.routes.filter(route => route.id !== routeId);
        if (state.activeRouteId === routeId) { delete state.activeRouteId; state.mode = 'idle'; }
        return true;
      });
      if (removed) await this.setPending(owner, undefined);
      await this.listRoutes(owner, update.userId);
      return;
    }
    const pending = await this.pending(owner);
    if (payload.startsWith('city:') && pending?.kind === 'city') {
      const [, nonce, rawIndex] = payload.split(':'); const index = Number(rawIndex);
      if (nonce !== pending.nonce || !Number.isSafeInteger(index) || index < 0 || !pending.choices?.[index]) return;
      await this.beginPlan(owner, update.userId, pending.requestText, pending.requestId, pending.choices[index]!.token, pending.routeId);
      return;
    }
    if (payload.startsWith('origin-address-choice:') && pending?.kind === 'origin_address' && pending.query && pending.nonce) {
      const [, nonce, id] = payload.split(':');
      if (nonce !== pending.nonce || !/^\d+$/u.test(id ?? '')) return;
      const view = await this.deps.planning.get(owner, pending.draftId);
      const choices = await this.addressChoices(owner, pending.query, view.draft.locality.id);
      const selected = choices.find(choice => choice.id === id);
      if (!selected) { await this.send(update.userId, { text: 'Этот адрес уже не удалось подтвердить. Введите его снова.' }); return; }
      const patched = await this.deps.planning.edit(owner, view.id, { base_version: view.version,
        event_id: update.eventId, changes: [{ op: 'point', field: 'origin', point: {
          ...selected.point, label: selected.label, source: 'place_choice' } }] });
      await this.setPending(owner, undefined);
      await this.showDraft(update.userId, patched);
      return;
    }
    const [action, id, version, ...rest] = payload.split(':');
    if (!['origin-address', 'mobility', 'window', 'budget', 'next-day', 'clear-destination', 'plan'].includes(action ?? '') || !id || !/^\d+$/u.test(version ?? '')) return;
    const nav = await this.navigation(owner);
    if (!nav.routes.some(route => route.id === nav.activeRouteId && route.draftId === id)) {
      await this.send(update.userId, { text: 'Эта кнопка относится к другому маршруту. Откройте нужный из списка.',
        buttons: nav.routes.length ? [[callback('📋 Мои маршруты', 'nav:list:0')]] : navigationButtons(nav) });
      return;
    }
    const view = await this.deps.planning.get(owner, id);
    if (view.version !== Number(version)) {
      await this.send(update.userId, { text: 'Параметры уже изменились. Показываю актуальную версию.' });
      await this.showDraft(update.userId, view); return;
    }
    if (action === 'origin-address') {
      await this.setPending(owner, { kind: 'origin_address', draftId: id });
      await this.send(update.userId, { text: `Напишите адрес в городе ${view.draft.locality.name}: улицу и номер дома. Я покажу подходящие варианты.` });
      return;
    }
    if (action === 'plan') {
      const confirmed = await this.deps.planning.confirm(owner, id, { base_version: view.version, event_id: update.eventId + '-confirm' });
      const planned = await this.deps.planning.calculate(owner, id, { base_version: confirmed.version, event_id: update.eventId + '-calculate' });
      await this.changeNavigation(owner, state => {
        const route = state.routes.find(item => item.id === state.activeRouteId && item.draftId === id);
        if (route) route.status = 'planned';
      });
      await this.sendPlan(update.userId, planned);
      return;
    }
    let changes: unknown[];
    if (action === 'mobility' && view.capabilities.modes.includes(rest[0] ?? ''))
      changes = [{ op: 'mobility', mode: rest[0] }];
    else if (action === 'budget' && view.draft.shared.budget?.kind === 'limit' &&
      ['whole_party', 'per_person'].includes(rest[0] ?? '') && ['per_day', 'whole_trip'].includes(rest[1] ?? ''))
      changes = [{ op: 'budget', value: { ...view.draft.shared.budget, basis: rest[0], period: rest[1] } }];
    else if (action === 'next-day') {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: view.draft.locality.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const value = (type: string) => parts.find(p => p.type === type)!.value;
      const today = `${value('year')}-${value('month')}-${value('day')}`;
      const first = view.draft.days[0]!.date;
      const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const shift = Math.max(0, Math.round((tomorrow.getTime() - new Date(`${first}T12:00:00Z`).getTime()) / 86_400_000));
      if (!shift) return;
      changes = view.draft.days.map(d => { const date = new Date(`${d.date}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() + shift); return { op: 'date', day_id: d.day_id,
          date: date.toISOString().slice(0, 10) }; });
    }
    else if (action === 'clear-destination') changes = [{ op: 'clear_destination' }];
    else if (action === 'window' && rest.length === 4 && view.draft.days.length)
      changes = [{ op: 'window', day_ids: view.draft.days.map(d => d.day_id), start: `${rest[0]}:${rest[1]}`, end: `${rest[2]}:${rest[3]}` }];
    else return;
    const patched = await this.deps.planning.edit(owner, id, { base_version: view.version, event_id: update.eventId, changes });
    await this.showDraft(update.userId, patched);
  }
}

export function registerMaxChatRoute(app: FastifyInstance, deps: MaxChatDependencies, botToken: string) {
  const controller = new MaxChatController({ ...deps,
    onIntentDiagnostic: (code, diagnostic) => app.log.warn({ code, diagnostic }, 'MAX intent validation failed'),
    onCallbackDiagnostic: code => app.log.warn({ code: /^MAX_SEND_[A-Z0-9_]+$/u.test(code) ? code : 'OTHER' },
      'MAX callback acknowledgement failed') });
  app.post('/api/max/webhook', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!validMaxWebhookSecret(request.headers['x-max-bot-api-secret'], botToken))
      return reply.code(401).send({ status: 'unauthorized' });
    try {
      const status = await controller.handle(request.body);
      if (status === 'retry_later') return reply.code(503).send({ status });
      return { status };
    } catch (error) {
      app.log.warn({ code: error instanceof Error ? error.message : 'UNKNOWN' }, 'MAX chat update failed');
      return reply.code(503).send({ status: 'retry_later' });
    }
  });
}

export class MaxApiTransport {
  constructor(private readonly token: string) {}
  private async post(path: string, body: unknown) {
    const json = JSON.stringify(body);
    await new Promise<void>((resolve, reject) => {
      // MAX uses the Russian Trusted CA. Scope this additional trust anchor to MAX
      // instead of disabling TLS verification or changing trust for other providers.
      const request = httpsRequest(`https://platform-api2.max.ru${path}`, {
        method: 'POST', ca: [...getCACertificates('default'), russianTrustedRootCa], timeout: 15_000,
        headers: { Authorization: this.token, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json) },
      }, response => {
        let received = 0; let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          received += Buffer.byteLength(chunk);
          if (received > 1_000_000) request.destroy(new Error('MAX_SEND_RESPONSE_TOO_LARGE'));
          else responseBody += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) return reject(new Error(`MAX_SEND_HTTP_${status}`));
          let payload: { success?: boolean } | null = null;
          try { payload = JSON.parse(responseBody); } catch { /* MAX may return an empty body. */ }
          if (payload?.success === false) return reject(new Error('MAX_SEND_PROVIDER_REJECTED'));
          resolve();
        });
      });
      request.on('timeout', () => request.destroy(new Error('MAX_SEND_TIMEOUT')));
      request.on('error', (error: NodeJS.ErrnoException) => {
        if (/^MAX_SEND_[A-Z0-9_]+$/u.test(error.message)) return reject(error);
        const code = error.code && /^[A-Z0-9_]{3,60}$/u.test(error.code) ? error.code : 'NETWORK_ERROR';
        reject(new Error(`MAX_SEND_${code}`));
      });
      request.end(json);
    });
  }
  async send(userId: number, message: Message) {
    const body = { text: message.text,
      ...(message.buttons?.length ? { attachments: [{ type: 'inline_keyboard', payload: { buttons: message.buttons } }] } : {}) };
    await this.post(`/messages?user_id=${userId}`, body);
  }
  async answer(callbackId: string) { await this.post(`/answers?callback_id=${encodeURIComponent(callbackId)}`, {}); }
}
