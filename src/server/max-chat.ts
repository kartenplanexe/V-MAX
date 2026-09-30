import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { getCACertificates } from 'node:tls';
import type { FastifyInstance } from 'fastify';
import type { PlanningView } from '../shared/planning-form.js';
import { candidatePreviewNotice, compactPlacesNotice, candidateSourceLink, selectionGapNotice } from '../shared/candidate-preview.js';
import { clarificationReview } from '../shared/clarification-review.js';
import { defaultSearchRadiusMeters } from '../shared/search-radius.js';
import { isExactGreeting } from './intent-start.js';
import { InitialIntentError } from './intent-start.js';
import { PlanningSessionError } from './planning-sessions.js';
import type { BotNavigation, ChatPending, PlanningDatabase, SavedRoute } from './planning-database.js';
import type { AddressChoice, VerifiedLocality } from './live-geography.js';
import type { SavedConditionsView } from '../shared/saved-conditions.js';
import { savedConditionsText } from '../shared/saved-conditions-text.js';
import { partialSearchNotice, planFailureNotice, planWarningCodes, unavailablePlanNotice } from '../shared/plan-evidence-text.js';
import { russianTrustedRootCa } from './max-ca.js';
import { mobilityText } from '../shared/route-travel-text.js';
import { validMaxWorkerSecret } from './max-async.js';
import { dgisDirectionsLink } from '../shared/dgis-links.js';
import { placeSourceLink, planDataEvidence, splitMaxText, travelSegmentText, eventVisitText, eventGapText } from './max-plan-text.js';

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
    getSaved?(owner: string, id: string): Promise<SavedConditionsView>;
    restore?(owner: string, id: string, input: unknown): Promise<PlanningView>;
  };
  transport: { send(userId: number, message: Message): Promise<string | void>;
    delete?(messageId: string): Promise<void>; answer(callbackId: string): Promise<void> };
  botUsername: string;
  mapEnabled: boolean;
  routingMode?: 'external' | 'verified';
  onIntentDiagnostic?: (code: string, diagnostic: InitialIntentError['diagnostic']) => void;
  onCallbackDiagnostic?: (code: string) => void;
  onStepDiagnostic?: (code: string) => void;
}

const eventKey = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const welcomeText = 'Привет! Я помогу составить план досуга прямо в чате. Опишите желание своими словами — например: «Завтра после 16 хочу погулять в Казани и поесть». Или выберите действие ниже.\n\nТекст обработает Alice AI. Не присылайте телефон, документы и другие личные сведения. Подробнее — /privacy.';
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

/** Drop profiles and unrelated MAX fields before managed queue delivery. */
export function minimalMaxUpdate(raw: unknown): unknown | null {
  const parsed = parseUpdate(raw);
  if (!parsed) return null;
  const original = raw as Record<string, any>;
  if (parsed.kind === 'started') return { update_type: 'bot_started',
    user: { user_id: parsed.userId }, timestamp: original.timestamp };
  if (parsed.kind === 'callback') return { update_type: 'message_callback', callback: {
    user: { user_id: parsed.userId }, callback_id: parsed.callbackId, payload: parsed.payload } };
  return { update_type: 'message_created', message: { sender: { user_id: parsed.userId },
    recipient: { chat_type: 'dialog' }, body: { mid: original.message.body.mid, text: parsed.text,
      ...(parsed.location ? { attachments: [{ type: 'location', latitude: parsed.location.lat, longitude: parsed.location.lon }] } : {}) } } };
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
  const mobility = view.draft.shared.mobility?.length === 1 ? view.draft.shared.mobility[0] : undefined;
  if (view.draft.shared.party?.total) parts.push(`Участников: ${view.draft.shared.party.total}`);
  const childAges = view.draft.shared.party?.child_ages;
  if (childAges) parts.push(childAges.length ? `Возраст детей: ${childAges.join(', ')} лет` : 'Группа без детей');
  if (mobility) parts.push(`🚶 ${mobilityText(mobility)}`);
  const budget = view.draft.shared.budget;
  if (budget?.kind === 'limit') {
    const scope = `${budget.basis === 'whole_party' ? 'на всех' : budget.basis === 'per_person' ? 'на человека' : '(единицу уточним)'} ${budget.period === 'whole_trip' ? 'за поездку' : budget.period === 'per_day' ? 'за день' : '(срок уточним)'}`;
    parts.push(budget.enforcement === 'estimated'
      ? `💳 Ориентир ${budget.amount_rub} ₽ ${scope}. Цены оценим по среднему чеку на человека; соблюдение суммы не гарантируется.`
      : `💳 До ${budget.amount_rub} ₽ ${scope} — строгий лимит`);
  }
  if (view.draft.points.origin) parts.push(`↗️ Старт: ${view.draft.points.origin.label ?? 'выбранная точка'}`);
  parts.push(`Радиус от старта: ${new Intl.NumberFormat('ru-RU').format((view.draft.shared.search_radius_meters ?? defaultSearchRadiusMeters(view.draft.shared.mobility)) / 1000)} км. Можно изменить в условиях мини-приложения.`);
  if (Object.values(view.provenance).includes('suggested')) parts.push('Время без точных часов — наше предложение, его можно изменить.');
  return parts.join('\n').slice(0, 3900);
}

export function formatChatPlanMessages(view: PlanningView): Message[] {
  const result = view.result;
  if (!result) return [{ text: 'План ещё не рассчитан.' }];
  const routeCheckFailed = result.warnings.some(warning =>
    ['ROUTING_PROVIDER_FAILURE', 'ROUTE_MATRIX_INCOMPLETE'].includes(warning));
  const searchIncomplete = planWarningCodes(result).includes('RETRIEVAL_PARTIAL');
  const tentative = result.warnings.includes('OPENING_HOURS_UNVERIFIED');
  const warnings = new Set(result.warnings);
  const segments = result.days.flatMap(day => day.travel_segments ?? []);
  const timezone = view.draft.locality.timezone;
  const unknownFare = ['TRANSIT_PRICE_UNKNOWN', 'TRANSPORT_COST_UNKNOWN'].some(code => warnings.has(code));
  const lead = result.status === 'PLACES_FOUND' ? 'Подобрал варианты мест. Путь и время дороги можно посмотреть в 2ГИС по ссылкам ниже.' : result.status === 'AVAILABLE' ? 'Готово — вот план:' : result.status === 'LIMITED'
    ? tentative ? 'Предварительный план: доступность места на это время не подтверждена.' : 'Удалось составить часть плана:' : result.status === 'ERROR'
      ? planFailureNotice(result) : routeCheckFailed
        ? 'Места могли найтись, но сейчас не удалось проверить путь до них.'
        : searchIncomplete ? 'Поиск мест завершился не полностью; проверенного плана пока нет.'
          : 'Пока нет проверенного плана для этих условий.';
  const messages: Message[] = [{ text: lead }];
  if (result.candidate_preview) {
    const lines = ['Найденные места', result.selection_policy ? compactPlacesNotice : candidatePreviewNotice];
    const observed = result.candidate_preview.groups.flatMap(group => group.places.map(place => Date.parse(place.source.fetched_at)));
    if (result.status === 'PLACES_FOUND' && Date.now() >= Math.min(...observed) + 1_800_000)
      lines.push('Данные могли измениться: подборке больше 30 минут. Перед выходом обновите места.');
    const missing = view.draft.days.flatMap(day => day.activities.filter(activity =>
      !result.candidate_preview!.groups.some(group => group.day_id === day.day_id && group.activity_id === activity.id))
      .map(activity => `${view.draft.days.length > 1 ? `${day.date} · ` : ''}${activity.label}: ${selectionGapNotice(result.selection_gaps?.find(gap => gap.day_id === day.day_id && gap.activity_id === activity.id)?.reason)}`));
    lines.push(...missing);
    for (const group of result.candidate_preview.groups) {
      const day = view.draft.days.find(value => value.day_id === group.day_id);
      const activity = day?.activities.find(value => value.id === group.activity_id);
      if (!day || !activity) continue;
      lines.push(`\n${view.draft.days.length > 1 ? `${day.date} · ` : ''}${activity.label} · ${group.places.length}`);
      for (const place of group.places.slice(0, 3)) {
        lines.push(`• ${place.name}${place.location_label ? ` — ${place.location_label}` : ''}`);
        if (place.event_visit) {
          const event = place.event_visit;
          const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
          lines.push(`${time(event.starts_at)}–${time(event.ends_at)} · ${event.schedule_kind === 'fixed' ? 'сеанс' : 'планируемое посещение'}`);
          lines.push(event.admission_upper_minor === null ? 'Стоимость билетов уточните у организатора.' : event.admission_upper_minor === 0
            ? 'Вход бесплатный.' : `На билеты для вашей группы — до ${event.admission_upper_minor / 100} ₽ по данным афиши.`);
        } else if (place.estimated_visit_minutes !== undefined) lines.push(`На посещение — примерно ${place.estimated_visit_minutes} мин.`);
        const link = candidateSourceLink(place.source); if (link) lines.push(link);
        const directions = dgisDirectionsLink(place.point, view.draft.shared.mobility?.[0], view.draft.points.origin);
        if (directions) lines.push(`Перейти в 2ГИС: ${directions}`);
      }
      if (group.places.length > 3) lines.push(`Ещё ${group.places.length - 3} — в мини-приложении.`);
    }
    if (result.candidate_preview.groups.some(group => group.places.some(place => place.source.data_mode !== 'live')))
      lines.push('Среди вариантов есть учебные или подготовленные данные; это не живая проверка мест.');
    lines.push('Полный список и время получения данных — в мини-приложении.');
    messages.push({ text: lines.join('\n') });
  }
  if (result.days.some(day => day.visits.length)) messages.push({ text:
    `${mobilityText(view.draft.shared.mobility?.[0])}. Время в плане расчётное; прибытие и доступность не гарантируются.` });
  if (result.data_mode === 'test' || result.days.some(day => day.visits.some(visit => visit.source?.data_mode === 'test')) ||
      segments.some(segment => segment.source.data_mode === 'test')) messages.push({ text: 'Учебный расчёт: использованы тестовые данные.' });
  if (warnings.has('PT_SCHEDULE_SEARCH_BOUNDED')) messages.push({ text:
    'Проверены отдельные отправления в заданном окне. Между ними могут быть другие рейсы; можно изменить время или старт.' });
  if (warnings.has('PT_SCHEDULE_UNVERIFIED') || segments.some(segment => segment.transit &&
      !segment.transit.pedestrian && segment.transit.scheduleEvidence === 'unknown')) messages.push({ text:
    'Расписание не подтверждено данными провайдера; уточните отправление перед выходом.' });
  if (unknownFare) messages.push({ text: 'Стоимость проезда неизвестна; итоговые расходы на всю поездку не подтверждены.' });
  if (warnings.has('PT_WALKING_SEGMENT') && !segments.some(segment => segment.transit?.pedestrian))
    messages.push({ text: 'Часть переходов в режиме ОТ выполняется полностью пешком.' });
  if (warnings.has('ROUTE_GEOMETRY_UNAVAILABLE')) messages.push({ text:
    'Геометрия части переходов недоступна: на карте может не быть линии пути.' });
  if (result.days.some(day => day.visits.length) && searchIncomplete) messages.push({ text: partialSearchNotice });
  if (result.issues?.includes('ROUTING_SCOPE_TOO_LARGE')) messages.push({ text:
    'В одном расчёте не удалось проверить пути для всех занятий. Разделите их по дням или уменьшите число занятий в условиях маршрута.' });
  if (result.issues?.includes('BUDGET_PRICE_DATA_REQUIRED')) messages.push({ text:
    'Для части мест нет цены, по которой можно проверить ваш бюджет. Средний чек не гарантирует итоговую стоимость. Можно явно выбрать приблизительный расчёт по среднему чеку на человека; места без известной цены останутся исключены.' });
  if (result.issues?.includes('TRANSPORT_COST_POLICY_REQUIRED')) messages.push({ text:
    'Цена проезда неизвестна, поэтому общий лимит расходов проверить нельзя. Можно выбрать пеший режим или явно убрать ограничение бюджета.' });
  if (result.warnings.includes('BUDGET_ESTIMATED_NOT_GUARANTEED')) messages.push({ text:
    'Вы выбрали приблизительный бюджет. Расходы рассчитаны по оценкам; фактическая сумма может оказаться выше лимита.' });
  if (result.days.some(day => day.visits.some(visit => visit.event))) messages.push({ text:
    'План не покупает билеты и не оформляет бронирование. Наличие мест и условия посещения уточните у организатора.' });
  for (const text of new Set((result.event_gaps ?? []).map(gap => {
    const day = view.draft.days.find(item => item.day_id === gap.day_id);
    const label = day?.activities.find(activity => activity.id === gap.activity_id)?.label ?? 'Выбранное событие';
    return `${day?.date ?? 'Выбранный день'} · ${label}: ${eventGapText(gap.code)}`;
  }))) messages.push({ text });
  const planOrigin = result.origin ?? view.draft.points.origin;
  for (const day of result.days) {
    const lines = [`📅 ${day.date}`];
    const draftDay = view.draft.days.find(candidate => candidate.day_id === day.day_id);
    if (day.visits.length && planOrigin) {
      lines.push(`📍 Старт${draftDay?.window ? ` ${draftDay.window.start}` : ''}: ${planOrigin.label ?? 'выбранная точка'}`);
    }
    let previous = '@origin';
    for (const visit of day.visits) {
      const segment = day.travel_segments?.find(candidate => candidate.from_id === previous && candidate.to_id === visit.place_id);
      lines.push(...travelSegmentText(segment, timezone));
      lines.push(`${clock(visit.starts_at)}–${clock(visit.ends_at)}  ${visit.name}`);
      lines.push(...eventVisitText(visit, timezone));
      if (visit.location_label) lines.push(`📍 ${visit.location_label}`);
      lines.push(`В пути ${visit.travel_before_minutes} мин${visit.distance_before_meters == null ? '' : ` / ≈${Math.round(visit.distance_before_meters / 100) / 10} км`} · запас ${visit.arrival_buffer_minutes} мин · ${visit.price_expected_minor == null ? 'цена неизвестна' : `≈ ${visit.price_expected_minor / 100} ₽`}`);
      if (visit.warnings.includes('OPENING_HOURS_UNVERIFIED')) lines.push('Часы работы не указаны; проверьте доступность перед выходом.');
      if (visit.warnings.includes('AGE_ELIGIBILITY_UNVERIFIED')) lines.push('Возрастные ограничения места не указаны. Возможность посещения с детьми нужно уточнить.');
      const url = placeSourceLink(visit.source);
      if (url) lines.push(`Место в 2ГИС: ${url}`);
      previous = visit.place_id;
    }
    const last = day.visits.at(-1), destination = view.draft.points.destination;
    if (last && destination) {
      lines.push(`🏁 Финиш: ${destination.label ?? 'выбранная точка'}`);
      const finalSegment = day.travel_segments?.find(segment => segment.from_id === last.place_id && segment.to_id === '@destination');
      lines.push(...travelSegmentText(finalSegment, timezone));
      if (day.ends_at !== undefined && Number.isFinite(day.ends_at) && day.ends_at >= last.ends_at)
        lines.push(`В пути ${day.ends_at - last.ends_at} мин · расчётное прибытие ${clock(day.ends_at)}.`);
      else lines.push('Расчётное время прибытия не указано.');
    }
    if (result.warnings.includes('WALK_WAYPOINTS_INCOMPLETE') && day.visits.length === 1)
      lines.push('Пока удалось подобрать только один ориентир прогулки; это не полный прогулочный маршрут.');
    if (day.missing_activity_ids.length) {
      const labels = day.missing_activity_ids.map(id => draftDay?.activities.find(activity => activity.id === id)?.label ?? 'часть пожеланий');
      lines.push(`Не удалось включить: ${labels.join(', ')}.`);
      lines.push('Это неполный маршрут — оставшиеся пожелания не считаем выполненными.');
    }
    if (!day.visits.length) lines.push(unavailablePlanNotice(result));
    messages.push({ text: lines.join('\n') });
  }
  const evidence = planDataEvidence(result, timezone);
  if (evidence.length) messages.push({ text: evidence.join('\n') });
  if (result.days.some(day => day.visits.length) && result.total_expected_cost_minor != null && !unknownFare)
    messages.push({ text: `Ожидаемые расходы: ≈ ${result.total_expected_cost_minor / 100} ₽. Время и расходы могут быть приблизительными.` });
  if (messages.length === 1 && result.status !== 'ERROR') messages[0]!.text += '\nМожно изменить время или точку старта.';
  return messages.flatMap(message => splitMaxText(message.text).map(text => ({ ...message, text })));
}

export class MaxChatController {
  private readonly sent = new Map<number, { active: string[]; transient: string[]; result?: string[]; resultDraftId?: string }>();
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
  private async send(userId: number, message: Message, transient = false) {
    const id = await this.deps.transport.send(userId, message);
    if (typeof id === 'string' && id.length <= 200 && id.length > 0) {
      const batch = this.sent.get(userId);
      batch?.[transient ? 'transient' : 'active'].push(id);
    }
  }
  private async settleMessages(owner: string, userId: number) {
    const batch = this.sent.get(userId);
    if (!batch) return;
    const queued = await this.deps.database.withNavigation(owner, async (state, save) => {
      const previous = state.activeMessageIds ?? [];
      const previousResult = state.resultMessageIds ?? [];
      const replaceResult = Boolean(batch.result?.length);
      const removedResult = Boolean(state.resultDraftId && !state.routes.some(route => route.draftId === state.resultDraftId));
      if (replaceResult) { state.resultMessageIds = batch.result; state.resultDraftId = batch.resultDraftId; }
      else if (removedResult) { delete state.resultMessageIds; delete state.resultDraftId; }
      if (batch.active.length) state.activeMessageIds = batch.active;
      state.cleanupMessageIds = [...new Set([
        ...(state.cleanupMessageIds ?? []), ...previous.filter(id => batch.active.length > 0 && id !== state.greetingMessageId),
        ...batch.transient,
        ...(replaceResult || removedResult ? previousResult : []),
      ])].filter(id => id !== state.greetingMessageId && !state.resultMessageIds?.includes(id));
      await save();
      return (state.cleanupMessageIds ?? []).slice(0, 20);
    });
    if (!this.deps.transport.delete) return;
    const deleted: string[] = [];
    for (const id of queued) {
      if (deleted.length || queued.indexOf(id) > 0) await new Promise(resolve => setTimeout(resolve, 550));
      try { await this.deps.transport.delete(id); deleted.push(id); }
      catch (error) { this.deps.onStepDiagnostic?.(error instanceof Error ? error.message : 'MAX_DELETE_FAILED'); }
    }
    if (deleted.length) await this.deps.database.withNavigation(owner, async (state, save) => {
      state.cleanupMessageIds = (state.cleanupMessageIds ?? []).filter(id => !deleted.includes(id));
      await save();
    });
  }
  private async navigation(owner: string) {
    return this.deps.database.withNavigation(owner, async state => structuredClone(state));
  }
  private async prompt(owner: string, userId: number, text: string, choices: Button[][] = []) {
    const state = await this.navigation(owner);
    const route = state.routes.find(item => item.id === state.activeRouteId);
    await this.send(userId, { text: `${route ? `Маршрут: ${route.title}\n\n` : ''}${text}`,
      buttons: [...choices, ...navigationButtons(state)] });
  }
  private async changeNavigation<T>(owner: string, change: (state: BotNavigation) => T) {
    return this.deps.database.withNavigation(owner, async (state, save) => {
      const result = change(state); await save(); return result;
    });
  }
  private async welcome(owner: string, userId: number) {
    return this.deps.database.withNavigation(owner, async (state, save) => {
      if (state.welcomed) return false;
      const id = await this.deps.transport.send(userId, { text: welcomeText });
      if (typeof id === 'string' && id.length <= 200 && id.length > 0) state.greetingMessageId = id;
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
    await this.send(userId, { text: `Мои маршруты (${routes.length}):\n${lines.join('\n')}\n\nВыберите маршрут, чтобы продолжить. Готовые подборки доступны до удаления; незавершённые условия — до 30 дней. При обновлении места проверяются заново.`, buttons });
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
      const saved = await this.readSaved(owner, route.draftId);
      if (saved) {
        const summary = savedConditionsText(saved);
        await this.send(userId, { text: `${summary.slice(0, 3400)}${summary.length > 3400 ? '\nПолные условия доступны в мини-приложении.' : ''}`,
          buttons: [[callback('Продолжить с этими условиями', `nav:refresh:${route.id}`)],
            [appButton(this.deps.botUsername, 'Посмотреть сохранённые условия')], ...navigationButtons(state, 'draft')] });
        return;
      }
      if (!route.requestText.trim()) {
        await this.send(userId, { text: `Условия маршрута «${route.title}» больше не сохранены. Исходного пожелания в этой записи нет. Чтобы составить новый маршрут, напишите новое пожелание.`,
          buttons: [[callback('Написать новое пожелание', 'nav:new')], ...navigationButtons(state, 'draft')] });
        return;
      }
      await this.send(userId, { text: `Данные маршрута «${route.title}» устарели. В этой записи сохранился только исходный запрос; прежние правки восстановить нельзя. Можно явно начать заново по исходному запросу.`,
        buttons: [[callback('Начать по исходному запросу', `nav:restart:${route.id}`)], ...navigationButtons(state, 'draft')] });
    }
  }

  private async readSaved(owner: string, draftId: string): Promise<SavedConditionsView | null> {
    if (!this.deps.planning.getSaved) return null;
    try { return await this.deps.planning.getSaved(owner, draftId); }
    catch (error) {
      if (error instanceof PlanningSessionError && ['SAVED_CONDITIONS_NOT_FOUND', 'DRAFT_NOT_FOUND'].includes(error.code)) return null;
      throw error;
    }
  }

  private async sendPlan(userId: number, view: PlanningView) {
    const messages = formatChatPlanMessages(view);
    const state = await this.navigation(`max:${userId}`);
    const route = state.routes.find(item => item.id === state.activeRouteId && item.draftId === view.id);
    if (route) messages[0]!.text = `Маршрут: ${route.title}\n\n${messages[0]!.text}`;
    messages.at(-1)!.buttons = [[callback(view.result?.status === 'ERROR' ? 'Повторить расчёт' : 'Проверить заново',
      `replan:${view.id}:${view.version}`)], [appButton(this.deps.botUsername,
      view.result?.candidate_preview ? 'Посмотреть найденные места' : this.deps.mapEnabled ? 'Открыть ленту и карту' : 'Открыть подробный план')], ...navigationButtons(state, 'result')];
    if (view.result?.issues?.includes('BUDGET_PRICE_DATA_REQUIRED') && view.draft.shared.budget?.kind === 'limit' &&
        view.draft.shared.budget.enforcement !== 'estimated') {
      messages.at(-1)!.buttons!.unshift([callback('Считать приблизительно по среднему чеку', `budget-policy:${view.id}:${view.version}:estimated`)]);
    }
    for (let i = 0; i < messages.length; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, 550));
      await this.send(userId, messages[i]!);
    }
    if (view.result && ['AVAILABLE', 'LIMITED', 'PLACES_FOUND'].includes(view.result.status)) {
      const batch = this.sent.get(userId);
      if (batch) {
        batch.result = batch.active.slice(-(messages.length), -1);
        batch.resultDraftId = view.id;
      }
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
      this.sent.set(update.userId, { active: [], transient: [] });
      if (update.kind === 'started' || update.text === '/start') {
        await this.welcome(owner, update.userId);
        const state = await this.navigation(owner);
        await this.send(update.userId, { text: state.mode === 'planning' ? 'Продолжим текущий маршрут?' : 'Что хотите сделать?',
          buttons: navigationButtons(state) });
      }
      else if (update.kind === 'callback') await this.handleCallback(owner, update);
      else {
        const firstWelcome = await this.welcome(owner, update.userId);
        if (firstWelcome && isExactGreeting(update.text ?? '')) {
          const state = await this.navigation(owner);
          await this.send(update.userId, { text: 'Что хотите сделать?', buttons: navigationButtons(state) });
        } else await this.handleMessage(owner, update);
      }
      await this.settleMessages(owner, update.userId);
      await this.finish(owner, update.eventId);
      this.sent.delete(update.userId);
      return 'handled' as const;
    } catch (error) {
      if (error instanceof InitialIntentError || error instanceof PlanningSessionError) {
        this.deps.onStepDiagnostic?.(error.code);
        if (error instanceof InitialIntentError)
          this.deps.onIntentDiagnostic?.(error.code, error.diagnostic ?? { stage: 'control' });
        const savedErrorText: Record<string, string> = {
          SAVED_CONDITIONS_NOT_FOUND: 'Сохранённые условия удалены или срок их хранения истёк. Выберите маршрут в «Моих маршрутах».',
          SAVED_CONDITIONS_STALE: 'Условия изменились. Откройте маршрут ещё раз перед восстановлением.',
          SAVED_RESTORE_FAILED: 'Не удалось обновить данные. Сохранённые условия остались доступны; откройте маршрут и повторите действие позже.',
          RESTORE_INTERRUPTED: 'Обновление было прервано. Откройте сохранённые условия и явно начните новую попытку.',
          SAVED_CATEGORY_RECONFIRM_REQUIRED: 'Не удалось безопасно восстановить категории мест. Ваши условия сохранены и доступны в деталях; для нового подбора уточните занятия в новом маршруте.',
          SAVED_EXCLUSIONS_RECONFIRM_REQUIRED: 'Ограничения выбора мест нужно уточнить заново. Сохранённые условия остаются доступны; автоматически убирать запреты не будем.',
          SAVED_SEMANTIC_POLICY_CHANGED: 'Правила подбора изменились. Сохранённые условия нужно уточнить заново перед расчётом.',
          SAVED_UNSUPPORTED_CONDITIONS: 'Часть сохранённых условий требует нового уточнения. Автоматически убирать их из запроса не будем.',
          BUDGET_ASSUMPTION_RECONFIRM_REQUIRED: 'Для приблизительного бюджета нужно заново подтвердить способ расчёта. Сохранённые условия остаются доступны.',
          POINT_RECONFIRM_REQUIRED: 'Сохранённую точку нужно выбрать заново в выбранном городе.',
          SAVED_RESTORE_UNAVAILABLE: 'Восстановление условий пока недоступно. Исходный запрос автоматически не отправлялся на новый разбор.',
        };
        const text = savedErrorText[error.code] ?? (error.code === 'INTENT_INVALID_RESPONSE' ? 'Не получилось надёжно сопоставить пожелание с данными 2ГИС. Это ошибка разбора, а не вашего текста. Можно повторить попытку или отправить новое пожелание.'
          : error.code === 'INTENT_NEEDS_CLARIFICATION' ? 'Не получилось надёжно разобрать условия пожелания. Можно повторить разбор или отправить новое пожелание.'
          : error.code === 'INTENT_PROVIDER_FAILED' ? 'Сервис разбора сейчас не отвечает. Попробуйте написать запрос позже.'
            : error.code === 'CATALOG_UNAVAILABLE' ? 'Каталог 2ГИС сейчас недоступен. Новый маршрут пока не создать; сохранённые маршруты можно открыть через «Мои маршруты».'
            : error.code === 'POINT_OUTSIDE_AREA' ? 'Точка за пределами выбранного города. Укажите другой адрес, местоположение или точку на карте.'
              : error.code === 'GEOGRAPHY_UNAVAILABLE' ? 'Сейчас не получилось проверить адрес в 2ГИС. Попробуйте позже или отправьте местоположение.'
                : 'Не получилось обработать этот шаг. Проверьте условия и попробуйте ещё раз.');
        const retry = await this.pending(owner);
        const state = await this.navigation(owner);
        await this.send(update.userId, { text,
          buttons: retry?.kind === 'intent_retry'
            ? [[callback('🔄 Повторить разбор', `intent-retry:${retry.nonce}`)], ...navigationButtons(state)]
            : navigationButtons(state) });
        await this.settleMessages(owner, update.userId);
        await this.finish(owner, update.eventId);
        this.sent.delete(update.userId);
        return 'handled' as const;
      }
      this.sent.delete(update.userId);
      throw error;
    }
  }

  private async handleMessage(owner: string, update: Incoming) {
    const text = update.text?.trim();
    if (text === '/privacy') {
      await this.prompt(owner, update.userId, 'Для плана сохраняются ваш идентификатор MAX, пожелания и выбранные условия. Текст разбирает Alice AI; поиск и карта используют 2ГИС, афиша — KudaGo. Геолокация необязательна. Готовые подборки доступны до удаления через «Мои маршруты».\n\nПравовые документы доступны по ссылке «Политика обработки данных» в форме нового запроса. Реквизиты оператора и контакт для обращений пока не заполнены.', [[appButton(this.deps.botUsername, 'Открыть мини-приложение')]]);
      return;
    }
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
    if (pending?.kind === 'intent_retry') await this.setPending(owner, undefined);
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
      await this.showDraft(update.userId, await this.deps.planning.get(owner, pending.draftId));
      return;
    }
    if (pending?.kind === 'destination') {
      await this.showDraft(update.userId, await this.deps.planning.get(owner, pending.draftId));
      return;
    }
    if (!text) {
      await this.prompt(owner, update.userId, 'Напишите пожелание о досуге или отправьте геолокацию после запроса точки старта.');
      return;
    }
    if (pending?.kind === 'city') {
      await this.chooseCity(owner, update.userId, pending.requestText, pending.requestId, text, pending.routeId);
      return;
    }
    if (pending?.kind === 'party') {
      const total = Number(text);
      if (!Number.isSafeInteger(total) || total < 1 || total > 100) {
        await this.prompt(owner, update.userId, 'Сколько будет человек? Пришлите одно число от 1 до 100.'); return;
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
    await this.prompt(owner, update.userId, 'В каком городе или населённом пункте составить план? Напишите название — остальное пожелание уже запомнил.');
  }

  private async chooseCity(owner: string, userId: number, requestText: string, requestId: string, cityText: string, routeId?: string) {
    const choices = await this.deps.database.withOwner(owner, async (_state, _save, db) => {
      await this.deps.database.recordUsage(db, 'geography');
      return this.deps.geography.search(cityText);
    });
    if (!choices.length) {
      await this.setPending(owner, { kind: 'city', requestText, requestId, routeId, nonce: randomUUID().slice(0, 8) });
      await this.prompt(owner, userId, 'Не нашёл этот населённый пункт в доступных данных. Уточните название и регион.');
      return;
    }
    if (choices.length === 1) { await this.beginPlan(owner, userId, requestText, requestId, choices[0]!.token, routeId, cityText); return; }
    const nonce = randomUUID().slice(0, 8);
    await this.setPending(owner, { kind: 'city', requestText, requestId, routeId, nonce, localityQuery: cityText,
      choices: choices.map(c => ({ name: c.name, token: c.token })) });
    await this.prompt(owner, userId, 'Нашёл несколько населённых пунктов. Выберите нужный:', choices.map((c, i) => [callback(c.name, `city:${nonce}:${i}`)]));
  }

  private async chooseAddress(owner: string, userId: number, draftId: string, query: string) {
    const q = query.trim();
    if (q.length < 4 || q.length > 120) {
      await this.prompt(owner, userId, 'Напишите адрес с улицей и номером дома — от 4 до 120 символов.'); return;
    }
    const view = await this.deps.planning.get(owner, draftId);
    const choices = await this.addressChoices(owner, q, view.draft.locality.id);
    if (!choices.length) {
      await this.setPending(owner, { kind: 'origin_address', draftId });
      await this.prompt(owner, userId, 'Не нашёл точный адрес в выбранном городе. Напишите улицу и номер дома иначе или отправьте местоположение.');
      return;
    }
    const nonce = randomUUID().slice(0, 8);
    await this.setPending(owner, { kind: 'origin_address', draftId, query: q, nonce });
    await this.prompt(owner, userId, 'Где начинаем? Выберите найденный адрес:', choices.map(choice => [callback(choice.label.slice(0, 80), `origin-address-choice:${nonce}:${choice.id}`)]));
  }

  private async addressChoices(owner: string, query: string, cityId: string) {
    return this.deps.database.withOwner(owner, async (_state, _save, db) => {
      await this.deps.database.recordUsage(db, 'geography');
      return this.deps.geography.searchAddress(query, cityId);
    });
  }

  private async beginPlan(owner: string, userId: number, text: string, requestId: string, localityToken: string, routeId?: string, localityQuery?: string) {
    const nav = await this.navigation(owner);
    if (routeId && (nav.activeRouteId !== routeId || !nav.routes.some(route => route.id === routeId))) {
      await this.listRoutes(owner, userId); return;
    }
    let result: Awaited<ReturnType<MaxChatDependencies['planning']['start']>>;
    try {
      const route = routeId ? nav.routes.find(item => item.id === routeId) : undefined;
      const saved = route ? await this.readSaved(owner, route.draftId) : null;
      if (saved && !this.deps.planning.restore) throw new PlanningSessionError('SAVED_RESTORE_UNAVAILABLE', 503);
      result = saved
        ? { status: 'draft', view: await this.deps.planning.restore!(owner, saved.id,
          { event_id: requestId, base_revision: saved.revision, locality_token: localityToken }) }
        : await this.deps.planning.start(owner, { event_id: requestId, user_text: text, locality_token: localityToken,
          ...(localityQuery ? { locality_query: localityQuery } : {}) });
    } catch (error) {
      // A failed city-selected parse must not leave the chat waiting for another
      // city. Preserve only a short-lived, explicit retry of the same request.
      if (error instanceof InitialIntentError && ['INTENT_INVALID_RESPONSE', 'INTENT_NEEDS_CLARIFICATION',
        'INTENT_PROVIDER_FAILED'].includes(error.code)) {
        await this.setPending(owner, { kind: 'intent_retry', requestText: text, localityToken,
          routeId, localityQuery, nonce: randomUUID().slice(0, 8) });
      } else await this.setPending(owner, undefined);
      throw error;
    }
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
    if (issue?.code === 'INPUT_CLARIFICATION_REQUIRED') {
      const unresolved = view.draft.clarifications![0]!;
      const review = clarificationReview(view.draft, unresolved);
      question = `\n\nНужно уточнить: «${unresolved.text.slice(0, 400)}». Остальные пожелания сохранены.`;
      if (review) {
        question += `\nСейчас указано: ${review.current.slice(0, 700)}`;
        if (review.ready) buttons.push([callback(review.label, `clarify:${view.id}:${view.version}:${unresolved.id}`)]);
      } else question += '\nЭто условие пока не представлено в доступных полях. Расчёт заблокирован, чтобы его не потерять.';
      buttons.push([appButton(this.deps.botUsername, 'Уточнить в форме')]);
      await this.setPending(owner, undefined);
    } else if (issue?.code === 'ORIGIN_REQUIRED') {
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
    } else if (issue?.code === 'TRANSPORT_REQUIRED' || issue?.code === 'WALK_ROUTE_REQUIRES_WALKING') {
      question = issue.code === 'WALK_ROUTE_REQUIRES_WALKING'
        ? '\n\nДля прогулки между местами нужен пеший маршрут. Смешивать поездку и пешую часть пока не умеем. Переключить на пеший?'
        : '\n\nКак будем передвигаться?';
      buttons.push(view.capabilities.modes.filter(mode => issue.code !== 'WALK_ROUTE_REQUIRES_WALKING' || mode === 'walking').map(mode => callback(
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
    } else if (issue?.code === 'BUDGET_PRICE_BASIS_REQUIRED') {
      question = '\n\nСредний чек можно использовать только как ориентир на человека. Итоговая сумма может быть выше бюджета. Как считать?';
      buttons.push([callback('По среднему чеку на человека', `budget-policy:${view.id}:${view.version}:estimated`)]);
      buttons.push([callback('Оставить строгий лимит', `budget-policy:${view.id}:${view.version}:strict`)]);
      await this.setPending(owner, undefined);
    } else if (issue?.code === 'WINDOW_EXPIRED') {
      question = '\n\nЭто время уже прошло. Перенести тот же план на завтра?';
      buttons.push([callback('На завтра', `next-day:${view.id}:${view.version}`)]);
      buttons.push([appButton(this.deps.botUsername, 'Изменить время')]);
      await this.setPending(owner, undefined);
    } else if (issue?.code === 'WINDOW_REQUIRED') {
      question = '\n\nВ какое время вы свободны? Можно выбрать предложение:';
      buttons.push([callback('09–12', `window:${view.id}:${view.version}:09:00:12:00`),
        callback('13–16', `window:${view.id}:${view.version}:13:00:16:00`),
        callback('17–20', `window:${view.id}:${view.version}:17:00:20:00`)]);
      await this.setPending(owner, undefined);
    } else if (!issue) {
      question = this.deps.routingMode === 'external' ? '\n\nПодберу варианты мест. Дорогу и время в пути посмотрите в 2ГИС; выполнимость общего плана здесь не проверяется.' : '\n\nЕсли всё верно, составлю маршрут и проверю время в пути.';
      buttons.push([callback(this.deps.routingMode === 'external' ? 'Подобрать места' : 'Составить план', `plan:${view.id}:${view.version}`)]);
      buttons.push([appButton(this.deps.botUsername, 'Изменить детали')]);
      await this.setPending(owner, undefined);
    } else {
      question = '\n\nЭтот параметр нужно уточнить перед расчётом. Откройте условия или напишите новый запрос.';
      buttons.push([appButton(this.deps.botUsername, 'Уточнить детали')]);
      await this.setPending(owner, undefined);
    }
    buttons.push(...navigationButtons(nav, 'draft'));
    const heading = `Маршрут: ${(active?.title ?? routeTitle(view)).slice(0, 200)}\n\n`;
    const details = summary(view), remaining = 3800 - heading.length - question.length;
    const more = '\nПолные условия доступны в мини-приложении.';
    const visibleDetails = details.length <= remaining ? details : details.slice(0, Math.max(0, remaining - more.length)) + more;
    // Preserve the actionable question when the summary is long (MAX: 4000 chars).
    await this.send(userId, { text: `${heading}${visibleDetails}${question}`, buttons });
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
      const saved = await this.readSaved(owner, route.draftId);
      if (saved) {
        await this.setPending(owner, { kind: 'city', requestText: route.requestText, requestId: update.eventId,
          routeId, nonce: randomUUID().slice(0, 8) });
        await this.send(update.userId, { text: 'Ваши изменённые условия сохранены. В каком городе продолжить? Напишите название — получим свежие данные, затем проверим даты и точку старта.' });
        return;
      }
      await this.openRoute(owner, update.userId, route.id);
      return;
    }
    if (/^nav:restart:[0-9a-f-]{36}$/u.test(payload)) {
      const routeId = payload.slice('nav:restart:'.length), state = await this.navigation(owner);
      const route = state.routes.find(item => item.id === routeId);
      if (!route || state.activeRouteId !== routeId) { await this.listRoutes(owner, update.userId); return; }
      if (await this.readSaved(owner, route.draftId)) { await this.openRoute(owner, update.userId, route.id); return; }
      if (!route.requestText.trim()) { await this.startNew(owner, update.userId); return; }
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
    if (payload.startsWith('intent-retry:') && pending?.kind === 'intent_retry') {
      if (payload.slice('intent-retry:'.length) !== pending.nonce) return;
      await this.beginPlan(owner, update.userId, pending.requestText, update.eventId,
        pending.localityToken, pending.routeId, pending.localityQuery);
      return;
    }
    if (payload.startsWith('city:') && pending?.kind === 'city') {
      const [, nonce, rawIndex] = payload.split(':'); const index = Number(rawIndex);
      if (nonce !== pending.nonce || !Number.isSafeInteger(index) || index < 0 || !pending.choices?.[index]) return;
      await this.beginPlan(owner, update.userId, pending.requestText, pending.requestId, pending.choices[index]!.token, pending.routeId, pending.localityQuery);
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
    if (!['origin-address', 'mobility', 'window', 'budget', 'budget-policy', 'next-day', 'clear-destination', 'plan', 'replan', 'clarify'].includes(action ?? '') || !id || !/^\d+$/u.test(version ?? '')) return;
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
      await this.prompt(owner, update.userId, `Напишите адрес в городе ${view.draft.locality.name}: улицу и номер дома. Я покажу подходящие варианты.`);
      return;
    }
    if (action === 'clarify') {
      const changed = await this.deps.planning.edit(owner, id, { base_version: view.version, event_id: update.eventId,
        changes: [{ op: 'resolve_clarification', clarification_id: rest[0] }] });
      await this.showDraft(update.userId, changed); return;
    }
    if (action === 'plan' || action === 'replan') {
      if (view.result && action === 'plan') { await this.sendPlan(update.userId, view); return; }
      const confirmed = view.phase === 'DRAFT'
        ? await this.deps.planning.confirm(owner, id, { base_version: view.version, event_id: update.eventId + '-confirm' })
        : view;
      await this.send(update.userId, { text: this.deps.routingMode === 'external' ? 'Подбираю места. Результат и ссылки на 2ГИС пришлю сюда.' : 'Подбираю места и проверяю дорогу. Это может занять до двух минут; результат пришлю сюда.' }, true);
      const planned = await this.deps.planning.calculate(owner, id, { base_version: confirmed.version, event_id: update.eventId + '-calculate',
        ...(action === 'replan' && confirmed.result ? { refresh: true } : {}) });
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
    else if (action === 'budget-policy' && view.draft.shared.budget?.kind === 'limit' && ['strict', 'estimated'].includes(rest[0] ?? '')) {
      const { price_basis_assumption: _previousAssumption, ...budget } = view.draft.shared.budget;
      changes = [{ op: 'budget', value: { ...budget, enforcement: rest[0],
        ...(rest[0] === 'estimated' ? { price_basis_assumption: 'per_person' } : {}) } }];
    }
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

export function registerMaxChatRoute(app: FastifyInstance, deps: MaxChatDependencies, botToken: string,
  options: { dispatch?: (update: unknown) => Promise<void> } = {}) {
  const controller = new MaxChatController({ ...deps,
    onIntentDiagnostic: (code, diagnostic) => app.log.warn({ code, diagnostic }, 'MAX intent validation failed'),
    onCallbackDiagnostic: code => app.log.warn({ code: /^MAX_SEND_[A-Z0-9_]+$/u.test(code) ? code : 'OTHER' },
      'MAX callback acknowledgement failed'),
    onStepDiagnostic: code => app.log.warn({ code: /^[A-Z0-9_]{3,70}$/.test(code) ? code : 'OTHER' }, 'MAX planning step failed') });
  const processUpdate = async (raw: unknown) => {
    const update = parseUpdate(raw);
    return update ? deps.database.withChatUpdate(`max:${update.userId}`, () => controller.handle(raw)) : 'ignored';
  };
  app.post('/api/max/webhook', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!validMaxWebhookSecret(request.headers['x-max-bot-api-secret'], botToken))
      return reply.code(401).send({ status: 'unauthorized' });
    try {
      if (options.dispatch) {
        const update = minimalMaxUpdate(request.body);
        if (!update) return { status: 'ignored' };
        await options.dispatch(update);
        return { status: 'accepted' };
      }
      const status = await processUpdate(request.body);
      if (status === 'retry_later') return reply.code(503).send({ status });
      return { status };
    } catch (error) {
      const code = error instanceof Error && /^(?:MAX_SEND|INTENT|GEOGRAPHY|DATABASE|PLAN|SAVED|CHAT)_[A-Z0-9_]{1,70}$/u.test(error.message) ? error.message : 'OTHER';
      app.log.warn({ code }, 'MAX chat update failed');
      return reply.code(503).send({ status: 'retry_later' });
    }
  });
  app.post('/api/max/worker', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!validMaxWorkerSecret(request.headers['x-vmax-worker-secret'], botToken))
      return reply.code(401).send({ status: 'unauthorized' });
    const until = Date.now() + 30_000;
    while (true) {
      try {
        const status = await processUpdate(request.body);
        if (status !== 'retry_later') return { status };
      } catch (error) {
        if (!(error instanceof PlanningSessionError) || !['CHAT_UPDATE_BUSY', 'CHAT_BUSY'].includes(error.code)) {
          app.log.warn({ code: 'WORKER_FAILED' }, 'MAX async worker failed');
          return reply.code(503).send({ status: 'retry_later' });
        }
      }
      if (Date.now() >= until) {
        app.log.warn({ code: 'WORKER_BUSY' }, 'MAX async worker failed');
        return reply.code(503).send({ status: 'retry_later' });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
}

export class MaxApiTransport {
  constructor(private readonly token: string) {}
  private async request(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const json = body === undefined ? '' : JSON.stringify(body);
    return new Promise<unknown>((resolve, reject) => {
      const request = httpsRequest(`https://platform-api2.max.ru${path}`, {
        method, ca: [...getCACertificates('default'), russianTrustedRootCa], timeout: 15_000,
        headers: { Authorization: this.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }) },
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
          if (status < 200 || status >= 300) return reject(new Error(`MAX_${method === 'DELETE' ? 'DELETE' : 'SEND'}_HTTP_${status}`));
          let payload: unknown = null;
          try { payload = JSON.parse(responseBody); } catch { /* Empty responses are allowed. */ }
          if (payload && typeof payload === 'object' && 'success' in payload && payload.success === false)
            return reject(new Error(method === 'DELETE' ? 'MAX_DELETE_PROVIDER_REJECTED' : 'MAX_SEND_PROVIDER_REJECTED'));
          resolve(payload);
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
    const result = await this.request('POST', `/messages?user_id=${userId}`, body);
    const id = (result as { message?: { body?: { mid?: unknown } } } | null)?.message?.body?.mid;
    return typeof id === 'string' ? id : undefined;
  }
  async delete(messageId: string) {
    await this.request('DELETE', `/messages?message_id=${encodeURIComponent(messageId)}`);
  }
  async answer(callbackId: string) { await this.request('POST', `/answers?callback_id=${encodeURIComponent(callbackId)}`, {}); }
}
