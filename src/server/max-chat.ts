import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PlanningView } from '../shared/planning-form.js';
import { isExactGreeting } from './intent-start.js';
import { InitialIntentError } from './intent-start.js';
import { PlanningSessionError } from './planning-sessions.js';
import type { ChatPending, PlanningDatabase } from './planning-database.js';
import type { VerifiedLocality } from './live-geography.js';

type Button = { type: 'callback' | 'open_app' | 'request_geo_location'; text: string;
  payload?: string; web_app?: string };
type Message = { text: string; buttons?: Button[][] };
type Incoming = { kind: 'started' | 'message' | 'callback'; userId: number; eventId: string;
  text?: string; location?: { lat: number; lon: number }; payload?: string; callbackId?: string };

export interface MaxChatDependencies {
  database: PlanningDatabase;
  geography: { search(q: string): Promise<(VerifiedLocality & { token: string })[]> };
  planning: {
    start(owner: string, input: unknown): Promise<{ status: 'off_topic' } | { status: 'draft'; view: PlanningView }>;
    get(owner: string, id: string): Promise<PlanningView> | PlanningView;
    edit(owner: string, id: string, input: unknown): Promise<PlanningView> | PlanningView;
    confirm(owner: string, id: string, input: unknown): Promise<PlanningView> | PlanningView;
    calculate(owner: string, id: string, input: unknown): Promise<PlanningView>;
  };
  transport: { send(userId: number, message: Message): Promise<void>; answer(callbackId: string): Promise<void> };
  botUsername: string;
  dailyGeographyCalls: number;
  mapEnabled: boolean;
}

const eventKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const welcomeText = 'Привет! Напишите обычными словами, когда и как хотите провести время. Например: «Завтра после 16 хочу погулять в Казани и поесть». Я соберу план прямо здесь.';
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const appButton = (botUsername: string, text = 'Подробнее и карта'): Button => ({ type: 'open_app', text, web_app: botUsername });
const callback = (text: string, payload: string): Button => ({ type: 'callback', text, payload });
const keyboard = (buttons: Button[][]): Message['buttons'] => buttons;

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
  const lead = result.status === 'AVAILABLE' ? 'Готово — вот план:' : result.status === 'LIMITED'
    ? 'Удалось составить часть плана:' : result.status === 'ERROR'
      ? 'Сервис мест или маршрутов временно не ответил.' : 'Пока нет проверенного плана для этих условий.';
  const messages: Message[] = [{ text: lead }];
  for (const day of result.days) {
    const lines = [`📅 ${day.date}`];
    for (const visit of day.visits) {
      lines.push(`${clock(visit.starts_at)}–${clock(visit.ends_at)}  ${visit.name}`);
      lines.push(`В пути ${visit.travel_before_minutes} мин · запас ${visit.arrival_buffer_minutes} мин · ${visit.price_expected_minor == null ? 'цена неизвестна' : `≈ ${visit.price_expected_minor / 100} ₽`}`);
      if (visit.source) lines.push(`Источник: ${visit.source.provider}`);
    }
    if (day.missing_activity_ids.length) lines.push('Не все пожелания удалось включить.');
    if (!day.visits.length) lines.push('Подтверждённых подходящих мест не нашлось. Можно попробовать другую дату или больший радиус.');
    let chunk = '';
    for (const line of lines) {
      if ((chunk + '\n' + line).length > 3800 && chunk) { messages.push({ text: chunk }); chunk = ''; }
      chunk += (chunk ? '\n' : '') + line.slice(0, 3800);
    }
    if (chunk) messages.push({ text: chunk });
  }
  if (result.total_expected_cost_minor != null) messages.push({ text: `Ожидаемые расходы: ≈ ${result.total_expected_cost_minor / 100} ₽. Время и расходы могут быть приблизительными.` });
  if (messages.length === 1) messages[0]!.text += '\nМожно попробовать другую дату или больший радиус поиска.';
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
  private async welcome(owner: string, userId: number, force = false) {
    return this.deps.database.withOwner(owner, async (state, save) => {
      state.chat ??= { seen: {} };
      if (state.chat.welcomed && !force) return false;
      await this.send(userId, { text: welcomeText });
      state.chat.welcomed = true;
      await save();
      return true;
    });
  }

  async handle(raw: unknown) {
    const update = parseUpdate(raw);
    if (!update) return 'ignored' as const;
    const owner = `max:${update.userId}`;
    const claimed = await this.claim(owner, update.eventId);
    if (claimed === 'done') return 'duplicate' as const;
    if (claimed === 'running') return 'retry_later' as const;
    try {
      if (update.kind === 'callback' && update.callbackId) await this.deps.transport.answer(update.callbackId);
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
        const text = error.code === 'INTENT_INVALID_RESPONSE' ? 'Не удалось надёжно понять пожелание. Попробуйте написать его другими словами.'
          : error.code === 'INTENT_PROVIDER_FAILED' ? 'Сервис разбора сейчас не отвечает. Попробуйте написать запрос позже.'
            : error.code === 'POINT_OUTSIDE_AREA' ? 'Точка за пределами выбранного города. Отправьте другое местоположение или выберите точку на карте.'
              : error.code === 'DAILY_LIMIT' ? 'Сегодня лимит новых запросов исчерпан. Сохранённый план можно посмотреть в мини-приложении.'
                : 'Не получилось обработать этот шаг. Проверьте условия и попробуйте ещё раз.';
        await this.send(update.userId, { text });
        await this.finish(owner, update.eventId);
        return 'handled' as const;
      }
      throw error;
    }
  }

  private async handleMessage(owner: string, update: Incoming) {
    const pending = await this.pending(owner);
    if ((pending?.kind === 'origin' || pending?.kind === 'destination') && update.location) {
      const view = await this.deps.planning.get(owner, pending.draftId);
      const patched = await this.deps.planning.edit(owner, pending.draftId, { base_version: view.version,
        event_id: update.eventId, changes: [{ op: 'point', field: pending.kind, point: {
          ...update.location, label: pending.kind === 'origin' ? 'Моё местоположение' : 'Точка завершения', source: 'user_geolocation' } }] });
      await this.setPending(owner, undefined);
      await this.showDraft(update.userId, patched);
      return;
    }
    const text = update.text?.trim();
    if (text === '/new') {
      await this.setPending(owner, undefined);
      await this.send(update.userId, { text: 'Напишите новое пожелание. Например: «Завтра после 16 хочу погулять в Казани и зайти в кафе».' });
      return;
    }
    if (pending?.kind === 'origin' || pending?.kind === 'destination') {
      await this.send(update.userId, { text: 'Отправьте геолокацию кнопкой под предыдущим сообщением или выберите точку в мини-приложении. Для нового плана напишите /new.' });
      return;
    }
    if (!text) {
      await this.send(update.userId, { text: 'Напишите пожелание о досуге или отправьте геолокацию после запроса точки старта.' });
      return;
    }
    if (pending?.kind === 'city') {
      await this.chooseCity(owner, update.userId, pending.requestText, pending.requestId, text);
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
      await this.send(update.userId, { text: 'Напишите, когда и чем хотите заняться. Например: «Завтра после 16 хочу погулять и поесть в Казани».' });
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

  private async chooseCity(owner: string, userId: number, requestText: string, requestId: string, cityText: string) {
    const choices = await this.deps.database.withOwner(owner, async (_state, _save, db) => {
      await this.deps.database.reserve(db, 'geography', this.deps.dailyGeographyCalls);
      return this.deps.geography.search(cityText);
    });
    if (!choices.length) {
      await this.setPending(owner, { kind: 'city', requestText, requestId, nonce: randomUUID().slice(0, 8) });
      await this.send(userId, { text: 'Не нашёл этот населённый пункт в доступных данных. Уточните название и регион.' });
      return;
    }
    if (choices.length === 1) { await this.beginPlan(owner, userId, requestText, requestId, choices[0]!.token); return; }
    const nonce = randomUUID().slice(0, 8);
    await this.setPending(owner, { kind: 'city', requestText, requestId, nonce,
      choices: choices.map(c => ({ name: c.name, token: c.token })) });
    await this.send(userId, { text: 'Нашёл несколько населённых пунктов. Выберите нужный:',
      buttons: keyboard(choices.map((c, i) => [callback(c.name, `city:${nonce}:${i}`)])) });
  }

  private async beginPlan(owner: string, userId: number, text: string, requestId: string, localityToken: string) {
    const result = await this.deps.planning.start(owner, { event_id: requestId, user_text: text, locality_token: localityToken });
    await this.setPending(owner, undefined);
    if (result.status === 'off_topic') {
      await this.send(userId, { text: 'Напишите, чем хочется заняться и когда. Например: «Завтра вечером погулять в Казани».' });
      return;
    }
    await this.showDraft(userId, result.view);
  }

  private async showDraft(userId: number, view: PlanningView) {
    const owner = `max:${userId}`;
    const buttons: Button[][] = [];
    const issue = view.issues[0];
    let question = '';
    if (issue?.code === 'ORIGIN_REQUIRED') {
      question = '\n\nОткуда удобнее начать? Пришлите текущее местоположение кнопкой ниже.';
      buttons.push([{ type: 'request_geo_location', text: 'Моё местоположение' }]);
      if (this.deps.mapEnabled) buttons.push([appButton(this.deps.botUsername, 'Выбрать на карте')]);
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
    await this.send(userId, { text: summary(view) + question, buttons });
  }

  private async handleCallback(owner: string, update: Incoming) {
    const payload = update.payload ?? '';
    const pending = await this.pending(owner);
    if (payload.startsWith('city:') && pending?.kind === 'city') {
      const [, nonce, rawIndex] = payload.split(':'); const index = Number(rawIndex);
      if (nonce !== pending.nonce || !Number.isSafeInteger(index) || index < 0 || !pending.choices?.[index]) return;
      await this.beginPlan(owner, update.userId, pending.requestText, pending.requestId, pending.choices[index]!.token);
      return;
    }
    const [action, id, version, ...rest] = payload.split(':');
    if (!['mobility', 'window', 'budget', 'next-day', 'clear-destination', 'plan'].includes(action ?? '') || !id || !/^\d+$/u.test(version ?? '')) return;
    const view = await this.deps.planning.get(owner, id);
    if (view.version !== Number(version)) {
      await this.send(update.userId, { text: 'Параметры уже изменились. Показываю актуальную версию.' });
      await this.showDraft(update.userId, view); return;
    }
    if (action === 'plan') {
      const confirmed = await this.deps.planning.confirm(owner, id, { base_version: view.version, event_id: update.eventId + '-confirm' });
      const planned = await this.deps.planning.calculate(owner, id, { base_version: confirmed.version, event_id: update.eventId + '-calculate' });
      const messages = formatChatPlanMessages(planned);
      messages.at(-1)!.buttons = [[appButton(this.deps.botUsername,
        this.deps.mapEnabled ? 'Открыть ленту и карту' : 'Открыть подробный план')]];
      for (let i = 0; i < messages.length; i++) {
        if (i) await new Promise(resolve => setTimeout(resolve, 550));
        await this.send(update.userId, messages[i]!);
      }
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
  const controller = new MaxChatController(deps);
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
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}
  private async post(path: string, body: unknown) {
    const response = await this.fetchImpl(`https://platform-api2.max.ru${path}`, { method: 'POST',
      headers: { Authorization: this.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const payload = await response.json().catch(() => null) as { success?: boolean } | null;
    if (!response.ok || payload?.success === false) throw new Error(`MAX_SEND_HTTP_${response.status}`);
  }
  async send(userId: number, message: Message) {
    const body = { text: message.text,
      ...(message.buttons?.length ? { attachments: [{ type: 'inline_keyboard', payload: { buttons: message.buttons } }] } : {}) };
    await this.post(`/messages?user_id=${userId}`, body);
  }
  async answer(callbackId: string) { await this.post(`/answers?callback_id=${encodeURIComponent(callbackId)}`, {}); }
}
