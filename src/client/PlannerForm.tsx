import { changesFor } from '../shared/planning-edits';
import { useEffect, useState } from 'react';
import type { Change, PlanningView } from '../shared/planning-form';
import { DEFAULT_SEARCH_RADIUS_METERS } from '../shared/search-radius';
import type { PublicConfig } from '../shared/public-config';
import './planner-form.css';
import { PointPicker } from './PointPicker';
import { AddressPicker, type AddressChoice } from './AddressPicker';
import { PlanResult } from './PlanResult';
import { ConditionsPanel, type ConditionSectionId } from './ConditionsPanel';
import { InitialRequestForm } from './InitialRequestForm';
import { ClarificationsPanel } from './ClarificationsPanel';
import { Action, Icon, Sheet } from './PlannerUi';
import { readMaxLaunchData, waitForMaxLaunchData } from './max-launch-data';
import type { SavedConditionsView } from '../shared/saved-conditions';
import { SavedConditionsPanel } from './SavedConditionsPanel';
import { partialSearchNotice, routingUnavailableNotice } from '../shared/plan-evidence-text';
import { useColorScheme } from '@maxhub/max-ui';
import { AlternativePanel } from './AlternativePanel';
import type { AlternativePreview, AlternativeTarget } from '../shared/route-alternatives';
import type { ShareCreated, SharePreview } from '../shared/route-sharing';
import { SharePanel, SharedRoutePreview } from './SharePanel';
import { SavedRoutesPanel } from './SavedRoutesPanel';
import type { SavedRouteActivation, SavedRouteList } from '../shared/saved-route-list';
import type { ManualChoices } from '../shared/manual-planning';
import type { EventSearchPreview, EventAvailabilityPreview } from '../shared/event-selection';
import { EventPanel, type EventPanelTarget } from './EventPanel';
import { eventFactDeadline, selectedEventDisplay, SelectedEventItem } from './EventFacts';
import { useExpired } from './PlannerUi';

type Draft = PlanningView['draft'];
type Bootstrap = { token: string; view: PlanningView | null; expiredRoute?: string; saved?: SavedConditionsView };
const messages: Record<string, string> = {
  ACTIVITY_REQUIRED: 'Выберите хотя бы одно занятие или событие для этого дня.',
  ACTIVITIES_REQUIRED: 'Выберите хотя бы одно занятие или событие для этого дня.',
  EVENT_RECHECK_REQUIRED: 'Сохранённый выбор события нужно перепроверить перед расчётом.',
  AGE_ELIGIBILITY_DATA_REQUIRED: 'Источник не подтвердил возрастное ограничение для вашей группы. Выберите другое событие или уточните данные у организатора.',
  EVENT_PREVIEW_EXPIRED: 'Срок проверки афиши истёк. Обновите афишу и выберите вариант снова.',
  EVENT_PREVIEW_STALE: 'Условия плана изменились. Откройте актуальные условия и повторите выбор.',
  EVENT_SELECTION_CHANGED: 'Выбранный сеанс или площадка изменились. Ваше пожелание сохранено — перепроверьте или выберите событие заново.',
  EVENT_DURATION_REQUIRED: 'Для посещения выставки укажите свою оценку длительности: от 5 до 720 минут.',
  EVENT_LOCALITY_UNSUPPORTED: 'Для этого города пока нет подключённой афиши. Можно выбрать другие занятия.',
  EVENT_OUTSIDE_LOCALITY: 'Площадка события находится вне выбранного города. Выберите другое событие.',
  UNKNOWN_EVENT_ACTIVITY: 'Выбранное занятие изменилось. Откройте актуальные условия.',
  EVENT_RESELECT_REQUIRED: 'Для события выберите другой сеанс через афишу — обычная замена места к нему не применяется.',
  EVENT_DURATION_NOT_APPLICABLE: 'У этого сеанса официальная длительность. Выберите его без своей оценки времени.',
  EVENT_DURATION_OUTSIDE_WINDOW: 'Указанная длительность не помещается в часы посещения. Измените её или выберите другой вариант.',
  EVENT_LOCATION_CHANGED: 'Площадка события изменилась. Выберите событие заново и подтвердите новое место.',
  EVENT_PROVIDER_ERROR: 'Не удалось связаться с афишей. Условия сохранены; повторите проверку позже.',
  EVENT_PROVIDER_SCHEMA_ERROR: 'Источник не подтвердил пригодные сведения о событии. Условия сохранены.',
  EVENT_HTTP_BUDGET_EXHAUSTED: 'Проверка афиши остановлена по лимиту запросов. Условия сохранены; можно повторить позже.',
  EVENT_DEADLINE_EXCEEDED: 'Проверка афиши заняла слишком много времени. Условия сохранены; повторите позже.',
  EVENT_PREVIEW_NOT_FOUND: 'Эта подборка больше недоступна. Обновите афишу.',
  EVENT_PREVIEW_CAPACITY: 'Сейчас слишком много проверок афиши. Подождите немного и повторите.',
  EVENT_CHOICE_NOT_FOUND: 'Выбранного варианта нет в текущей подборке. Обновите афишу.',
  INTENT_CONFIG_REQUIRED: 'Разбор текста сейчас недоступен. Выберите город и нажмите «Выбрать вручную».',
  PLANNER_NOT_CONFIGURED: 'Планировщик пока недоступен. Попробуйте открыть его позже.',
  GEOGRAPHY_UNAVAILABLE: 'Не удалось получить города из 2ГИС. Проверьте подключение и повторите поиск.',
  ADDRESS_QUERY_REQUIRED: 'Укажите улицу и номер дома — от 4 до 120 символов.',
  LOCALITY_SELECTION_EXPIRED: 'Выберите город ещё раз — время выбора истекло.',
  OPERATION_IN_PROGRESS: 'Предыдущее действие ещё выполняется. Дождитесь результата.',
  INTENT_INTERRUPTED: 'Разбор был прерван. Напишите новый запрос; предыдущий автоматически не повторяется.',
  PLAN_INTERRUPTED: 'Расчёт прервался. Можно запустить его снова.',
  CATALOG_UNAVAILABLE: 'Каталог категорий 2ГИС сейчас недоступен. Новый план не составлен; сохранённые маршруты можно открыть позже.',
  INVALID_REQUEST_TEXT: 'Напишите пожелания — не более 4000 символов.',
  INTENT_INVALID_RESPONSE: 'Не удалось надёжно разобрать пожелания. План не создан.',
  INTENT_NEEDS_CLARIFICATION: 'В запросе есть неоднозначное или неподдержанное условие. Мы не стали его угадывать.',
  INTENT_PROVIDER_FAILED: 'Сервис разбора запроса не ответил. Автоматического повтора не было.',
  INTENT_TRUNCATED: 'Ответ оборвался. Неполные параметры не сохранялись.',
  INTENT_RUN_LIMIT: 'Не удалось завершить разбор запроса. Попробуйте снова.',
  INTENT_IN_PROGRESS: 'Разбор уже выполняется. Дождитесь результата.',
  INTENT_BUSY: 'Разбор запросов занят. Попробуйте позже.',
  LOCALITY_RESOLUTION_REQUIRED: 'Город в пожеланиях отличается от выбранного. Выберите нужный город перед отправкой.',
  BUDGET_SCOPE_REQUIRED: 'Уточните: бюджет на человека или на всех, на день или на весь план.',
  BUDGET_PRICE_BASIS_REQUIRED: 'Для приблизительного бюджета явно выберите расчёт по среднему чеку на человека.',
  BUDGET_PRICE_DATA_REQUIRED: 'Для части мест нет цены, позволяющей проверить бюджет. Можно выбрать приблизительный расчёт по среднему чеку на человека; соблюдение лимита тогда не гарантируется.',
  DESTINATION_REQUIRED: 'В запросе указан финиш. Выберите его или явно отмените это условие.',
  AUTH_REQUIRED: 'Не удалось подтвердить сеанс MAX. Закройте мини-приложение и откройте снова из чата с ботом.',
  DRAFT_NOT_FOUND: 'Этот черновик больше недоступен. Загрузите сохранённые условия, чтобы продолжить.',
  SAVED_CONDITIONS_NOT_FOUND: 'Срок хранения условий истёк или запись удалена. Выберите другой маршрут в чате.',
  SAVED_CONDITIONS_STALE: 'Сохранённые условия уже изменились. Обновите страницу перед восстановлением.',
  SAVED_RESTORE_FAILED: 'Не удалось обновить данные. Сохранённые условия остались доступны; повторите действие позже.',
  RESTORE_INTERRUPTED: 'Обновление было прервано. Откройте сохранённые условия и явно начните новую попытку.',
  SAVED_CATEGORY_RECONFIRM_REQUIRED: 'Часть ограничений выбора мест нельзя безопасно восстановить. Условия сохранены здесь; уточните эти пожелания в новом маршруте. Автоматически менять ограничения не будем.',
  SAVED_SEMANTIC_POLICY_CHANGED: 'Правила подбора изменились. Сохранённые условия требуют нового уточнения.',
  SAVED_EXCLUSIONS_RECONFIRM_REQUIRED: 'Запреты на выбор мест нужно уточнить заново. Ваши условия сохранены; автоматически убирать запреты не будем.',
  SAVED_UNSUPPORTED_CONDITIONS: 'Часть сохранённых условий требует нового уточнения. Автоматически убирать их из запроса не будем.',
  BUDGET_ASSUMPTION_RECONFIRM_REQUIRED: 'Сохранённый приблизительный бюджет требует явного согласия на способ расчёта.',
  POINT_RECONFIRM_REQUIRED: 'Точку нужно выбрать заново в выбранном городе.',
  STALE_VERSION: 'Параметры уже изменились. Загрузите сохранённую версию и проверьте её.',
  STALE_RESULT: 'Параметры изменились во время расчёта. Подтвердите новую версию.',
  INVALID_ACTION: 'Проверьте даты, время и числовые значения. Начало должно быть раньше окончания.',
  INCOMPLETE_DRAFT: 'Перед расчётом исправьте отмеченные параметры.',
  ORIGIN_REQUIRED: 'Выберите точку старта.', WINDOW_REQUIRED: 'Укажите время начала и окончания.',
  WINDOW_EXPIRED: 'Это время уже прошло. Выберите другую дату или время.',
  TIME_CONFLICT: 'Время начала и окончания не соответствует продолжительности.',
  DUPLICATE_DATE: 'У каждого дня должна быть своя дата.',
  TRANSPORT_REQUIRED: 'Выберите доступный способ передвижения.',
  WALK_ROUTE_REQUIRES_WALKING: 'Для прогулки между местами выберите пеший маршрут. Смешивать поездку и пешую часть пока не умеем.',
  UNSUPPORTED_TRANSPORT: 'Этот способ передвижения пока не подключён.',
  PARTY_REQUIRED: 'Укажите общее число участников, включая детей.',
  PARTY_SIZE_CONFLICT: 'Число участников не может быть меньше числа детей. Проверьте состав группы.',
  TRANSPORT_COST_POLICY_REQUIRED: 'Не можем подтвердить общий бюджет вместе со стоимостью транспорта. Выберите пеший маршрут или уберите лимит расходов.',
  POINT_OUTSIDE_AREA: 'Точка вне области выбранного города. Выберите другой старт или город.',
  POINT_VERIFICATION_UNAVAILABLE: 'Проверка выбранной точки пока недоступна.',
  PLAN_IN_PROGRESS: 'Расчёт уже выполняется. Подождите и загрузите сохранённую версию.',
  PLANNER_BUSY: 'Планировщик занят. Попробуйте немного позже.',
  PLANNING_FAILED: 'Сервис расчёта сейчас недоступен. Ваши параметры сохранены.',
  SESSION_CAPACITY: 'Слишком много открытых планов. Вернитесь к последнему или подождите.',
  CATALOG_MISMATCH: 'Категории нужно обновить перед подбором мест.',
  INPUT_CLARIFICATION_REQUIRED: 'Часть пожеланий нужно уточнить. Понятные условия уже сохранены.',
  CLARIFICATION_VALUE_REQUIRED: 'Сначала укажите значение в условиях, затем подтвердите уточнение.',
  CLARIFICATION_NOT_FOUND: 'Это уточнение уже изменилось. Загрузите сохранённую версию.',
  ACTIVITY_EXCLUSIONS_REVIEW_REQUIRED: 'Этот тип конфликтует с сохранёнными исключениями занятия. Выберите совместимый тип; исключения не сняты.',
  SHARE_CLARIFICATION_REQUIRED: 'Перед отправкой маршрута разберите оставшиеся уточнения.',
  PLANNING_PIPELINE_FAILED: 'Не удалось завершить расчёт. Ваши параметры сохранены — попробуйте позже.',
  ROUTING_PROVIDER_UNAVAILABLE: routingUnavailableNotice,
  ROUTE_RECHECK_FAILED: 'Время дороги изменилось: прежний план больше не помещается. Попробуйте расширить свободное окно.',
  PLAN_EXPIRED_OR_INVALID: 'Данные устарели во время расчёта. Этот план не выдаём как проверенный.',
  ROUTING_BUDGET_EXCEEDED: 'Для такого плана требуется слишком много расчётов маршрута. Сократите число занятий.',
  ROUTING_BUDGET_OR_DEADLINE_EXCEEDED: 'Не удалось закончить проверку переходов за один расчёт. Можно повторить попытку или разделить занятия по дням.',
  ROUTING_SCOPE_TOO_LARGE: 'Не удалось проверить все сочетания мест в одном расчёте. Уменьшите число занятий или разделите их по дням.',
  ALTERNATIVE_EXPIRED: 'Срок проверки замены истёк. Подберите альтернативу ещё раз.',
  ALTERNATIVE_NOT_FOUND: 'Эта замена больше недоступна. Подберите новую.',
  ALTERNATIVE_PREVIEW_FAILED: 'Не удалось проверить замену. Текущий маршрут сохранён.',
  RESULT_REQUIRED: 'Для замены сначала нужен актуальный маршрут.',
  UNKNOWN_STOP: 'Эта остановка уже изменилась. Откройте текущий маршрут.',
  SHARE_NOT_FOUND: 'Ссылка недоступна: возможно, она отозвана или срок действия истёк.',
  SHARE_EXPIRED: 'Срок действия ссылки истёк.',
  SHARE_REVOKED: 'Автор отозвал эту ссылку.',
  SHARED_PLAN_NOT_FOUND: 'Ссылка недоступна: возможно, она отозвана или срок действия истёк.',
  SHARE_SOURCE_STALE: 'Условия уже изменились. Закройте панель и создайте ссылку заново.',
  SHARE_CAPACITY: 'Достигнут предел активных ссылок. Отзовите ненужную ссылку перед созданием новой.',
  SHARED_IMPORT_INTERRUPTED: 'Сохранение копии было прервано. Ваш прежний маршрут не изменился; повторите действие.',
  SHARED_IMPORT_FAILED: 'Не удалось сохранить копию. Ваш прежний маршрут остался доступен.',
  SHARED_IMPORT_EXPIRED: 'Черновик этой копии уже истёк. Откройте сохранённые условия в «Моих маршрутах».',
  SHARED_IMPORT_NEEDS_INPUT: 'Условия плана нужно уточнить заново. Автоматически снимать ограничения не будем.',
  INVALID_MANUAL_REQUEST: 'Проверьте даты, время и выбранные занятия.',
  MANUAL_CATALOG_CHANGED: 'Каталог обновился. Выберите категории ещё раз.',
  ACTIVITY_OPTIONS_UNAVAILABLE: 'В этом черновике из прежней версии добавление занятий недоступно. Создайте новый план или продолжите редактировать существующие условия.',
  TOO_MANY_ACTIVITIES: 'В одном плане можно указать до 120 занятий. Уберите лишние перед добавлением.',
  MANUAL_CATEGORY_UNAVAILABLE: 'Эта категория больше недоступна. Обновите список занятий.',
  MANUAL_CREATION_FAILED: 'Не удалось сохранить ручной план. Попробуйте позже.',
  MANUAL_WALK_UNAVAILABLE: 'Для этого города пока нет подходящих категорий для прогулки.',
};
const warningText = (code: string) => ({
  EVENT_BOOKING_NOT_VERIFIED: 'Наличие билетов и регистрация не проверены. Уточните условия на странице события.',
  EVENT_VISIT_DURATION_ESTIMATED: 'Длительность посещения события выбрана вами; это не продолжительность официального сеанса.',
  EVENT_AGE_UNKNOWN: 'Источник не указал возрастное ограничение события. Уточните его у организатора.',
  PRICE_UNKNOWN: 'Не все цены известны: общий бюджет не подтверждён.',
  PRICE_ESTIMATED: 'Цена — ориентир, а не гарантированная стоимость.',
  BUDGET_ESTIMATED_NOT_GUARANTEED: 'Расходы оценены приблизительно. Соблюдение лимита не гарантируется.',
  TRANSPORT_COST_UNKNOWN: 'Стоимость транспорта неизвестна.',
  RETRIEVAL_PARTIAL: partialSearchNotice,
  ROUTE_MATRIX_INCOMPLETE: 'Не все переходы удалось проверить. Такие переходы исключены из плана.',
  ROUTING_PROVIDER_FAILURE: 'Часть запросов маршрутов завершилась ошибкой.',
  ROUTE_TIME_IS_ESTIMATE: 'Время дороги рассчитано с запасом, но не гарантирует прибытие.',
  ROUTE_GEOMETRY_UNAVAILABLE: 'Линия части маршрута недоступна. Порядок остановок и время в пути показаны в списке.',
  TRANSIT_PRICE_UNKNOWN: 'Стоимость общественного транспорта неизвестна и не включена в оценку расходов.',
  PT_SCHEDULE_SEARCH_BOUNDED: 'Расписание транспорта проверено только для рассчитанного времени отправления.',
  PT_SCHEDULE_UNVERIFIED: 'Расписание транспорта не подтверждено. Проверьте отправление перед поездкой.',
  PT_WALKING_SEGMENT: 'На части пути транспорт не требуется: этот участок проходит пешком.',
  OPENING_HOURS_UNVERIFIED: 'Часы работы прогулочного места не указаны. Проверьте доступность перед выходом.',
  WALK_WAYPOINTS_INCOMPLETE: 'Для прогулки найден только один подходящий ориентир. Это неполный маршрут. Можно изменить время, дату или точку старта.',
  CROWDING_NOT_USED_WITHOUT_TIME_SPECIFIC_FACT: 'Загруженность на выбранное время неизвестна и не учитывалась.',
  AVERAGE_CHECK_UNIT_UNVERIFIED: 'Средний чек не подтверждает стоимость вашего посещения.',
  AVERAGE_CHECK_BASIS_ASSUMED_PER_PERSON: 'По вашему выбору средний чек принят как ориентир на человека, а не подтверждённая цена.',
}[code] ?? (code.startsWith('PREFERENCE_NOT_VERIFIED:') ? `Пожелание не подтверждено: ${code.slice(24)}` : 'Часть сведений о месте требует уточнения.'));
const humanError = (code: string) => messages[code] ?? 'Не удалось выполнить действие. Проверьте параметры и попробуйте ещё раз.';
const modeLabels: Record<string, string> = { walking: 'Пешком', driving: 'На машине', cycling: 'На велосипеде', public_transport: 'Общественным транспортом' };
const displayDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(new Date(`${value}T12:00:00Z`).getTime())
  ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`)) : 'Выберите дату';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const recoveryCodes = new Set(['DRAFT_NOT_FOUND', 'STALE_VERSION', 'PLAN_IN_PROGRESS', 'PLANNER_BUSY',
  'CONNECTION_UNCERTAIN', 'INVALID_SERVER_RESPONSE']);
const requestErrorCode = (cause: unknown) => cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
const canReloadAfterError = (cause: unknown) => {
  const code = requestErrorCode(cause); return typeof code === 'string' && recoveryCodes.has(code);
};
async function request<T>(path: string, token?: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method, credentials: 'omit', cache: 'no-store', headers: {
      ...(token ? { 'X-Max-Init-Data': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw Object.assign(new Error(method === 'GET'
      ? 'Не удалось связаться с сервисом. Проверьте соединение и попробуйте снова.'
      : 'Нет ответа от сервиса. Проверьте соединение. Перед повторным расчётом откройте актуальные условия: предыдущее действие могло выполниться.'), { code: 'CONNECTION_UNCERTAIN' });
  }
  let result: { error?: string };
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response');
    result = value as { error?: string };
  } catch {
    throw Object.assign(new Error(method === 'GET'
      ? 'Не удалось прочитать ответ сервиса. Попробуйте загрузить данные снова.'
      : 'Не удалось прочитать ответ сервиса. Загрузите сохранённую версию перед повтором: предыдущее действие могло выполниться.'), { code: 'INVALID_SERVER_RESPONSE' });
  }
  if (!response.ok) throw Object.assign(new Error(humanError(result.error ?? 'UNKNOWN')), { code: result.error ?? 'UNKNOWN' });
  return result as T;
}

export function PlannerForm() {
  const colorScheme = useColorScheme();
  const [session, setSession] = useState<Bootstrap | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('Открываем план…'), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [launchToken, setLaunchToken] = useState(''), [canRecover, setCanRecover] = useState(false);
  const [pendingLaunchShare, setPendingLaunchShare] = useState('');
  const [reloadRequested, setReloadRequested] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false), [newOpen, setNewOpen] = useState(false);
  const [detailsSection, setDetailsSection] = useState<ConditionSectionId | null>(null);
  const [pointEditor, setPointEditor] = useState<'address' | 'map' | null>(null), [mapsAvailable, setMapsAvailable] = useState(false);
  const [alternative, setAlternative] = useState<AlternativePreview | null>(null);
  const [shareOpen, setShareOpen] = useState(false), [shareCreated, setShareCreated] = useState<ShareCreated | null>(null);
  const [incoming, setIncoming] = useState<{ token: string; preview: SharePreview } | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const [shareDraftId, setShareDraftId] = useState('');
  const [dataOpen, setDataOpen] = useState(false);
  const [eventPanel, setEventPanel] = useState<{ target?: EventPanelTarget } | null>(null);
  const [eventPending, setEventPending] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch('/api/public-config', { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
      .then((value: PublicConfig | null) => { if (active) setMapsAvailable(Boolean(value?.maps.enabled)); }).catch(() => {});
    void waitForMaxLaunchData(() => readMaxLaunchData(window.WebApp?.initData, window.location.hash)).then(token => {
      if (!active) return;
      if (!token) { setBusy(''); setError('Откройте мини-приложение из чата с ботом — MAX передаст данные для входа.'); return; }
      setLaunchToken(token);
      const launch = new URLSearchParams(token).get('start_param');
      const launchShare = launch && /^share_[A-Za-z0-9_-]{43}$/u.test(launch) ? launch.slice(6) : '';
      setPendingLaunchShare(launchShare);
      request<Omit<Bootstrap, 'token'>>('/api/planning/bootstrap', token)
        .then(async value => { if (active) { setSession({ ...value, token }); setDraft(value.view ? structuredClone(value.view.draft) : null);
          if (launchShare) {
            try { const preview = await request<SharePreview>('/api/planning/shares/resolve', token, 'POST', { token: launchShare });
              if (active) { setIncoming({ token: launchShare, preview }); setPendingLaunchShare(''); } }
            catch (cause) { if (active) { setError(cause instanceof Error ? cause.message : 'Не удалось открыть ссылку.');
              setCanRecover(canReloadAfterError(cause)); if (!canReloadAfterError(cause)) setPendingLaunchShare(''); } }
          }
          if (active) setBusy(''); } })
        .catch(cause => { if (active) { setBusy(''); setError(cause instanceof Error ? cause.message : 'Не удалось открыть план.');
          setCanRecover(requestErrorCode(cause) !== 'AUTH_REQUIRED'); } });
    });
    return () => { active = false; };
  }, []);
  const view = session?.view, dirty = Boolean(view && draft && !same(view.draft, draft));
  const eventDeadlines = Object.values(view?.event_previews ?? {}).map(value => Date.parse(eventFactDeadline(value))).filter(value => value > Date.now());
  const eventDeadline = eventDeadlines.length ? new Date(Math.min(...eventDeadlines)).toISOString() : undefined;
  useExpired(eventDeadline);
  function accept(value: PlanningView) {
    setSession(current => current ? { token: current.token, view: value } : null);
    setDraft(structuredClone(value.draft)); setNewOpen(false); setIncoming(null);
  }
  async function act(label: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError(''); setNotice(''); setCanRecover(false);
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие. Попробуйте снова.'); setCanRecover(canReloadAfterError(cause)); }
    finally { setBusy(''); }
  }
  async function reloadSavedState() {
    const token = session?.token || launchToken;
    if (!token) return;
    // Reading server state never retries a mutation or confirms a new plan.
    // Keep local edits intact until this request has actually succeeded.
    const value = await request<Omit<Bootstrap, 'token'>>('/api/planning/bootstrap', token);
    setSession({ ...value, token }); setDraft(value.view ? structuredClone(value.view.draft) : null);
    setDetailsOpen(false); setPointEditor(null); setEventPanel(null); setAlternative(null);
    setNewOpen(false); setIncoming(null); setSavedOpen(false); setShareOpen(false); setReloadRequested(false);
    if (pendingLaunchShare) {
      try {
        const preview = await request<SharePreview>('/api/planning/shares/resolve', token, 'POST', { token: pendingLaunchShare });
        setIncoming({ token: pendingLaunchShare, preview }); setPendingLaunchShare('');
      } catch (cause) { if (!canReloadAfterError(cause)) setPendingLaunchShare(''); throw cause; }
      return;
    }
    setNotice(value.view || value.saved ? 'Загружена сохранённая версия. Проверьте условия перед расчётом.' : 'Сохранённого черновика нет. Можно начать новый маршрут.');
  }
  function requestReload() {
    if (busy) return;
    if (dirty) setReloadRequested(true);
    else void act('Загружаем сохранённую версию…', reloadSavedState);
  }
  function errorNotice() {
    return error && <div className="notice notice--error" role="alert"><Icon name="alert" /><div className="notice-content"><p>{error}</p>
      {canRecover && (session?.token || launchToken) && <Action variant="secondary" stretched disabled={!!busy} onClick={requestReload}>
        {session ? 'Загрузить сохранённую версию' : 'Попробовать снова'}</Action>}
    </div></div>;
  }
  const patch = (edit: (value: Draft) => void) => setDraft(current => { if (!current) return current; const next = structuredClone(current); edit(next); return next; });
  async function calculate(current = session?.view, refresh = false) {
    if (!session || !current) return;
    const base = `/api/planning/drafts/${current.id}`;
    if (current.phase === 'DRAFT') {
      current = await request<PlanningView>(base + '/confirm', session.token, 'POST', { base_version: current.version, event_id: crypto.randomUUID() });
      accept(current);
    }
    setBusy('Подбираем места и проверяем маршрут…');
    accept(await request<PlanningView>(base + '/plan', session.token, 'POST', { base_version: current.version, event_id: crypto.randomUUID(),
      ...(refresh && current.result ? { refresh: true } : {}) }));
  }
  async function retryResult() {
    if (!session?.view) return;
    const displayed = session.view;
    const latest = await request<PlanningView>(`/api/planning/drafts/${displayed.id}`, session.token);
    accept(latest);
    if (!same(latest.draft, displayed.draft)) {
      setNotice('Условия уже изменились. Загружена сохранённая версия — проверьте её перед расчётом.');
      return;
    }
    await calculate(latest, true);
  }
  function openConditions(section: ConditionSectionId | null = null) { setDetailsSection(section); setDetailsOpen(true); }
  async function save() {
    if (!session?.view || !draft) return;
    const changes = changesFor(session.view, draft);
    if (!changes.length) return;
    const next = await request<PlanningView>(`/api/planning/drafts/${session.view.id}`, session.token, 'PATCH', { base_version: session.view.version, event_id: crypto.randomUUID(), changes });
    const hadResult = Boolean(session.view.result); accept(next); setDetailsOpen(false);
    if (hadResult && !next.issues.length) await calculate(next);
    else setNotice('Условия сохранены. Проверьте их перед расчётом.');
  }
  async function quickSave(change: Change) {
    if (!session?.view) return;
    accept(await request<PlanningView>(`/api/planning/drafts/${session.view.id}`, session.token, 'PATCH', { base_version: session.view.version, event_id: crypto.randomUUID(), changes: [change] }));
  }
  async function locate(saveImmediately = false) {
    if (!navigator.geolocation) throw new Error('Геолокация недоступна. Укажите адрес или выберите точку на карте.');
    const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve,
      () => reject(new Error('Не удалось получить местоположение. Укажите адрес или выберите точку на карте.')), { timeout: 10_000, maximumAge: 60_000 }));
    const point = { lat: position.coords.latitude, lon: position.coords.longitude, label: 'Моё местоположение', source: 'user_geolocation' as const };
    if (saveImmediately) await quickSave({ op: 'point', field: 'origin', point });
    else patch(value => { value.points.origin = { ...point, locality_id: value.locality.id }; });
  }
  async function searchAddress(query: string): Promise<AddressChoice[]> {
    if (!session?.view) return [];
    return (await request<{ choices: AddressChoice[] }>('/api/planning/addresses', session.token, 'POST', { draft_id: session.view.id, q: query })).choices;
  }
  async function searchLocality(query: string) {
    return (await request<{ choices: { name: string; token: string }[] }>(`/api/planning/localities?q=${encodeURIComponent(query)}`, session?.token)).choices;
  }
  async function previewAlternative(target: AlternativeTarget) {
    if (!session?.view) return;
    setAlternative(await request<AlternativePreview>(`/api/planning/drafts/${session.view.id}/alternatives/preview`, session.token, 'POST', { ...target, base_version: session.view.version, event_id: crypto.randomUUID() }));
  }
  function browseEvents(target?: EventPanelTarget) { if (dirty || busy) return; setDetailsOpen(false); setEventPanel({ target }); }
  async function recheckEvent(dayId: string, activityId: string) {
    if (!session?.view) return;
    accept(await request<PlanningView>(`/api/planning/drafts/${session.view.id}/events/recheck`, session.token, 'POST', { base_version: session.view.version, event_id: crypto.randomUUID(), day_id: dayId, activity_id: activityId }));
    setNotice('Событие перепроверено. Проверьте условия перед расчётом.');
  }
  function activityTitle(dayId: string, activity: Draft['days'][number]['activities'][number]) {
    return activity.intent_kind === 'event_visit' && view ? selectedEventDisplay(view, dayId, activity.id)?.title ?? activity.label : activity.label;
  }
  const showingNew = Boolean(session && (newOpen || !view && !session.saved));
  const eventNeedsCheck = Boolean(view?.draft.days.some(day => day.activities.some(activity => activity.intent_kind === 'event_visit' && !selectedEventDisplay(view, day.day_id, activity.id))));
  const firstIssue = view?.issues[0] ?? (eventNeedsCheck ? { code: 'EVENT_RECHECK_REQUIRED' } : undefined);
  const ready = Boolean(view && !view.issues.length && !dirty && !eventNeedsCheck);
  return <main data-theme={colorScheme} className={`planner-page ${view?.result && !newOpen ? 'planner-page--result' : ''}`}>
    <header className="planner-header"><div className="planner-heading"><span className="header-route" aria-hidden="true"><Icon name="route" /></span><div>
      <h1>{incoming ? 'Общий маршрут' : showingNew ? 'Новый маршрут' : session?.saved && !view ? 'Сохранённый маршрут' : view?.result ? (draft && draft.days.length > 1 ? 'Планы по дням' : 'План дня') : 'Ваш план'}</h1>
      <p>{!showingNew && draft ? draft.locality.name : 'Досуг в вашем ритме'}</p></div></div>
      <div className="header-actions">{session && <Action variant="ghost" className="header-action" disabled={!!busy} aria-label="Мои маршруты" onClick={() => setSavedOpen(true)}><Icon name="list" /><span>Мои</span></Action>}
      {session && (view || session.saved) && <Action variant="ghost" className="header-action" aria-label={newOpen ? 'К плану' : 'Новый'} disabled={!!busy} onClick={() => { setNewOpen(!newOpen); setIncoming(null); setError(''); setNotice(''); }}>
        <Icon name={newOpen ? 'close' : 'plus'} /><span>{newOpen ? 'К плану' : 'Новый'}</span></Action>}
      </div>
    </header>
    {errorNotice()}
    {notice && <div className="notice" role="status"><Icon name="check" /><p>{notice}</p></div>}
    {busy && <div className="planner-progress" role="status" aria-live="polite"><span className="progress-dot" aria-hidden="true" /><span>{busy}</span></div>}
    {!session && !busy && !canRecover && <section className="empty-state"><h2>Продолжим в MAX</h2><p>План доступен только вам. Войдите через чат с ботом.</p>
      <a className="app-link" href="https://max.ru/t801_hakaton_max_bot">Открыть чат с ботом <Icon name="arrow" /></a></section>}
    {incoming && session && <SharedRoutePreview preview={incoming.preview} busy={!!busy} search={searchLocality} close={() => setIncoming(null)} importRoute={localityToken => void act('Сохраняем вашу копию условий…', async () => {
      accept(await request<PlanningView>('/api/planning/shares/import', session.token, 'POST', { token: incoming.token, event_id: crypto.randomUUID(), locality_token: localityToken }));
      setNotice('Это ваша копия. Проверьте дату, город и старт перед расчётом.');
    })} />}
    {showingNew && !incoming && <>{session?.expiredRoute && <div className="notice"><p>Срок черновика «{session.expiredRoute}» истёк. Можно составить новый маршрут.</p></div>}
      <InitialRequestForm disabled={!!busy} search={searchLocality}
        manualOptions={token => request<ManualChoices>('/api/planning/manual/options', session!.token, 'POST', { locality_token: token })}
        manualSubmit={value => void act('Сохраняем условия…', async () => { accept(await request<PlanningView>('/api/planning/manual/requests', session!.token, 'POST', { ...value, event_id: crypto.randomUUID() })); })}
        submit={value => act('Разбираем пожелания…', async () => {
        if (!session) return;
        const reply = await request<{ status: string; view?: PlanningView }>('/api/planning/requests', session.token, 'POST', { ...value, event_id: crypto.randomUUID() });
        if (reply.view) accept(reply.view); else setNotice('Опишите, как хотите провести свободное время: прогулка, музей, кафе или другие занятия.');
      })} /></>}
    {session?.saved && !view && !newOpen && !incoming && <SavedConditionsPanel key={`${session.saved.id}:${session.saved.revision}`} saved={session.saved} disabled={!!busy} search={searchLocality}
      restore={token => act('Обновляем данные для сохранённого маршрута…', async () => {
        const saved = session.saved!;
        accept(await request<PlanningView>(`/api/planning/saved/${encodeURIComponent(saved.id)}/restore`, session.token, 'POST', { event_id: crypto.randomUUID(), base_revision: saved.revision, locality_token: token }));
        setNotice('Условия восстановлены. Проверьте дату, старт и ограничения.');
      })} />}
    {view && draft && !newOpen && !incoming && <div className={`planner-workspace${view.result ? ' planner-workspace--result' : ''}`}>
      <aside className="summary-rail" aria-label="Условия маршрута"><div className="route-summary"><p className="summary-label">Ваши пожелания</p>
        <h2>{(draft.days.length === 1 ? draft.days[0]!.activities.map(activity => activityTitle(draft.days[0]!.day_id, activity)).join(' → ') : [...new Set(draft.days.flatMap(day => day.activities.map(activity => activityTitle(day.day_id, activity))))].join(' · ')) || 'Выберите, чем заняться'}</h2>
        <div className="constraint-chips"><button type="button" onClick={() => openConditions('time')}><Icon name="calendar" />{draft.days.length === 1 ? displayDate(draft.days[0]!.date) : `${draft.days.length} дня`}</button>
          <button type="button" onClick={() => openConditions('time')}><Icon name="clock" />{new Set(draft.days.map(day => `${day.window?.start}:${day.window?.end}`)).size > 1 ? 'Время по дням' : draft.days[0]?.window ? `${draft.days[0].window.start}–${draft.days[0].window.end}` : 'Выбрать время'}</button>
          <button type="button" onClick={() => openConditions('people')}><Icon name="walk" />{modesLabel(draft.shared.mobility?.[0])}</button>
          {Number.isFinite(draft.shared.search_radius_meters) && <button type="button" onClick={() => openConditions('points')}><Icon name="pin" />Радиус {new Intl.NumberFormat('ru-RU').format(draft.shared.search_radius_meters! / 1000)} км</button>}
          {draft.shared.budget?.kind === 'limit' && <button type="button" onClick={() => openConditions('budget')}><Icon name="wallet" />{new Intl.NumberFormat('ru-RU').format(draft.shared.budget.amount_rub)} ₽{draft.shared.budget.enforcement === 'estimated' ? ' ≈' : ''}</button>}</div>
        <div className="summary-actions"><Action variant="ghost" className="edit-conditions" onClick={() => openConditions()} disabled={!!busy} iconBefore={<Icon name="filters" />}>Изменить условия</Action>
        <Action variant="ghost" className="edit-conditions" onClick={() => browseEvents()} disabled={!!busy || dirty} iconBefore={<Icon name="calendar" />}>Добавить событие</Action></div>
      </div>
      {dirty && <div className="notice"><p>Есть несохранённые изменения.</p><Action variant="secondary" onClick={() => openConditions()}>Продолжить редактирование</Action></div>}
      {view.capabilities.data_mode === 'test' && !view.result && <p className="data-label">Учебный пример · синтетические данные</p>}
      </aside>
      <div className="planner-content">{view.result && !dirty ? <PlanResult key={`${view.id}:${view.version}`} view={view} mapsAvailable={mapsAvailable} busy={!!busy} editSearch={() => openConditions('points')}
        edit={() => openConditions()} share={() => setShareOpen(true)} chooseEvent={browseEvents} replace={target => void act('Проверяем замену…', () => previewAlternative(target))} retry={() => void act('Проверяем места заново…', retryResult)} warningText={warningText} humanError={humanError} /> : <section className="clarification" aria-labelledby="next-step">
        {draft.days.flatMap(day => day.activities.filter(activity => activity.intent_kind === 'event_visit').map(activity => <SelectedEventItem key={JSON.stringify([day.day_id, activity.id])} view={view} dayId={day.day_id} activityId={activity.id} busy={!!busy || dirty}
          recheck={() => void act('Перепроверяем событие…', () => recheckEvent(day.day_id, activity.id))} chooseOther={() => browseEvents({ day_id: day.day_id, replace_activity_id: activity.id })}
          remove={() => void act('Убираем событие…', () => quickSave({ op: 'remove_activity', day_id: day.day_id, activity_id: activity.id }))} />))}
        {(firstIssue?.code === 'INPUT_CLARIFICATION_REQUIRED' || firstIssue?.code === 'CATALOG_MISMATCH') ? <><h2 id="next-step">Уточним пожелания</h2><p>То, что удалось понять, уже в условиях. Осталось разобраться с этим:</p>
          <ClarificationsPanel view={view} busy={!!busy || dirty} edit={openConditions}
            resolve={id => void act('Сохраняем уточнение…', () => quickSave({ op: 'resolve_clarification', clarification_id: id }))}
            loadActivities={() => request<ManualChoices>(`/api/planning/drafts/${view.id}/activity-options`, session!.token)}
            choose={(dayId, activityId, choice, options) => void act('Сохраняем занятие…', () => quickSave({ op: 'activity_choice', day_id: dayId,
              activity_id: activityId, catalog_version: options.catalog_version, choice }))} /></> :
          firstIssue?.code === 'ORIGIN_REQUIRED' ? <><span className="step-symbol"><Icon name="pin" /></span><h2 id="next-step">Откуда начинаем?</h2><p>Выберите удобную точку — от неё посчитаем время в пути.</p>
          <div className="choice-list"><Action stretched disabled={!!busy} onClick={() => void act('Определяем местоположение…', () => locate(true))} iconBefore={<Icon name="pin" />}>Моё местоположение</Action>
            <Action variant="secondary" stretched disabled={!!busy} onClick={() => setPointEditor('address')}>Указать адрес</Action>
            {mapsAvailable && <Action variant="ghost" stretched disabled={!!busy} onClick={() => setPointEditor('map')}>Выбрать на карте</Action>}</div></> :
          firstIssue?.code === 'TRANSPORT_REQUIRED' ? <><span className="step-symbol"><Icon name="walk" /></span><h2 id="next-step">Как будете передвигаться?</h2><p>Проверим дорогу для выбранного способа.</p>
            <div className="choice-list">{view.capabilities.modes.map(mode => <Action variant="secondary" key={mode} disabled={!!busy} onClick={() => void act('Сохраняем…', () => quickSave({ op: 'mobility', mode }))}>{modeLabels[mode] ?? mode}</Action>)}</div></> :
          (firstIssue?.code === 'ACTIVITY_REQUIRED' || firstIssue?.code === 'ACTIVITIES_REQUIRED') ? <><span className="step-symbol"><Icon name="calendar" /></span><h2 id="next-step">Чем займёмся?</h2><p>Добавьте занятие или выберите событие из афиши. Затем проверим время, дорогу и остальные условия.</p>
            <Action stretched disabled={!!busy} onClick={() => openConditions()}>Выбрать занятия</Action>
            <Action variant="secondary" stretched disabled={!!busy || dirty} onClick={() => browseEvents()}>Открыть афишу</Action></> :
          firstIssue?.code === 'EVENT_RECHECK_REQUIRED' ? <><h2 id="next-step">Проверим выбранные события</h2><p>Используйте «Перепроверить событие» выше. Собственные пожелания остаются в плане.</p></> :
          firstIssue ? <><span className="step-symbol"><Icon name="filters" /></span><h2 id="next-step">Уточним один момент</h2><p>{humanError(firstIssue.code)}</p>
            <Action stretched disabled={!!busy} onClick={() => openConditions()}>Уточнить условия</Action></> :
          <><span className="step-symbol"><Icon name="route" /></span><h2 id="next-step">Всё готово к расчёту</h2><p>Подберём места и проверим, что посещения и дорога помещаются в ваше время.</p>
            {draft.points.origin && <div className="start-summary"><Icon name="pin" /><span><small>Начало маршрута</small><strong>{draft.points.origin.label ?? 'Выбранная точка'}</strong></span></div>}
            <p className="field-hint">Область подбора — {new Intl.NumberFormat('ru-RU').format((draft.shared.search_radius_meters ?? DEFAULT_SEARCH_RADIUS_METERS) / 1000)} км от старта. Радиус можно изменить в условиях.</p>
            <Action stretched disabled={!!busy || !ready || view.phase === 'PLANNING'} onClick={() => void act('Подбираем места…', () => calculate())}>Составить план</Action></>}
        {view.phase === 'PLANNING' && <Action variant="secondary" onClick={() => void act('Проверяем статус…', async () => { accept(await request<PlanningView>(`/api/planning/drafts/${view.id}`, session!.token)); })}>Проверить статус расчёта</Action>}
      </section>}</div>
      {eventPanel && <Sheet title="События для вашего дня" canClose={!eventPending} onClose={() => setEventPanel(null)}><EventPanel key={`${view.id}:${view.version}`} view={view} target={eventPanel.target} pending={setEventPending}
        search={dayId => request<EventSearchPreview>(`/api/planning/drafts/${view.id}/events/search`, session!.token, 'POST', { base_version: view.version, event_id: crypto.randomUUID(), day_id: dayId })}
        availability={value => request<EventAvailabilityPreview>(`/api/planning/drafts/${view.id}/events/availability`, session!.token, 'POST', { base_version: view.version, event_id: crypto.randomUUID(), ...value })}
        select={async value => { accept(await request<PlanningView>(`/api/planning/drafts/${view.id}/events/select`, session!.token, 'POST', { base_version: view.version, event_id: crypto.randomUUID(), ...value })); setEventPanel(null); setNotice('Событие добавлено к условиям. Проверьте порядок и подтвердите расчёт.'); }}
        refresh={async () => { accept(await request<PlanningView>(`/api/planning/drafts/${view.id}`, session!.token)); setEventPanel(null); }} /></Sheet>}
      {alternative && <Sheet title="Заменить остановку" onClose={() => setAlternative(null)}><AlternativePanel preview={alternative} current={view} busy={!!busy} close={() => setAlternative(null)} apply={id => void act('Применяем замену…', async () => {
        accept(await request<PlanningView>(`/api/planning/drafts/${view.id}/alternatives/apply`, session!.token, 'POST', { base_version: alternative.base_version, event_id: crypto.randomUUID(), alternative_id: id })); setAlternative(null);
      })} />{errorNotice()}</Sheet>}
      {shareOpen && <Sheet title="Поделиться маршрутом" onClose={() => setShareOpen(false)}><SharePanel created={shareDraftId === view.id ? shareCreated : null} busy={!!busy} party={view.draft.shared.party} create={points => void act('Создаём ссылку…', async () => {
        const saved = await request<SavedConditionsView>(`/api/planning/saved/${view.id}`, session!.token);
        setShareCreated(await request<ShareCreated>('/api/planning/shares', session!.token, 'POST', { draft_id: view.id, base_revision: saved.revision, event_id: crypto.randomUUID(), include_private_points: points }));
        setShareDraftId(view.id);
      })} revoke={() => void act('Отзываем ссылку…', async () => {
        if (!shareCreated) return; await request('/api/planning/shares/revoke', session!.token, 'POST', { share_id: shareCreated.share_id, event_id: crypto.randomUUID() }); setShareCreated(null); setNotice('Ссылка отозвана.');
      })} />{errorNotice()}</Sheet>}
      {detailsOpen && <Sheet title="Условия плана" className="conditions-sheet" onClose={() => setDetailsOpen(false)}><ConditionsPanel draft={draft} view={view} busy={!!busy} dirty={dirty} mapsAvailable={mapsAvailable} patch={patch} searchAddress={searchAddress}
        initialSection={detailsSection} loadActivities={() => request<ManualChoices>(`/api/planning/drafts/${view.id}/activity-options`, session!.token)}
        locate={() => void act('Определяем местоположение…', () => locate())} save={() => void act('Применяем условия…', save)} cancel={() => { setDraft(structuredClone(view.draft)); setDetailsOpen(false); }}
        browseEvents={browseEvents} recheckEvent={(dayId, activityId) => void act('Перепроверяем событие…', () => recheckEvent(dayId, activityId))} />
        {errorNotice()}</Sheet>}
      {pointEditor && <Sheet title={pointEditor === 'address' ? 'Точка старта' : 'Старт на карте'} onClose={() => setPointEditor(null)}>
        {pointEditor === 'address' ? <AddressPicker city={draft.locality.name} search={searchAddress} disabled={!!busy} onClose={() => setPointEditor(null)} onSelect={choice => void act('Сохраняем старт…', async () => {
          await quickSave({ op: 'point', field: 'origin', point: { ...choice.point, label: choice.label, source: 'place_choice' } }); setPointEditor(null);
        })} /> : (view.capabilities.map_center || draft.points.origin) && <PointPicker center={draft.points.origin ?? view.capabilities.map_center!} onClose={() => setPointEditor(null)} onSelect={point => void act('Сохраняем старт…', async () => {
          await quickSave({ op: 'point', field: 'origin', point: { ...point, label: 'Выбранная точка на карте', source: 'user_map' } }); setPointEditor(null);
        })} />}
        {errorNotice()}
      </Sheet>}
    </div>}
    {savedOpen && session && <Sheet title="Мои маршруты" onClose={() => setSavedOpen(false)}><SavedRoutesPanel busy={!!busy} load={cursor => request<SavedRouteList>(`/api/planning/saved${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, session.token)} remove={async item => {
      await request(`/api/planning/saved/${encodeURIComponent(item.id)}/delete`, session.token, 'POST', { event_id: crypto.randomUUID(), base_revision: item.revision });
      setNotice('Маршрут удалён.'); setError(''); if (shareDraftId === item.id) setShareCreated(null);
      if (session.view?.id === item.id || session.saved?.id === item.id) { setSession({ token: session.token, view: null }); setDraft(null); setNewOpen(false); setShareCreated(null); }
    }} open={id => void act('Открываем маршрут…', async () => {
      const value = await request<SavedRouteActivation>(`/api/planning/saved/${encodeURIComponent(id)}/activate`, session.token, 'POST', { event_id: crypto.randomUUID() });
      setSession({ ...value, token: session.token }); setDraft(value.view ? structuredClone(value.view.draft) : null); setNewOpen(false); setIncoming(null); setSavedOpen(false); setDetailsOpen(false); setAlternative(null);
    })} />{errorNotice()}</Sheet>}
    {reloadRequested && <Sheet title="Загрузить сохранённую версию?" canClose={!busy} onClose={() => setReloadRequested(false)}>
      <p>Правки в этой форме ещё не сохранены. Загрузка заменит их последней версией с сервера.</p>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <div className="sheet-actions"><Action stretched disabled={!!busy} onClick={() => void act('Загружаем сохранённую версию…', reloadSavedState)}>Загрузить сохранённую версию</Action>
        <Action variant="ghost" stretched disabled={!!busy} onClick={() => setReloadRequested(false)}>Продолжить правку</Action></div>
    </Sheet>}
    <footer className="planner-footer"><Action variant="ghost" onClick={() => setDataOpen(true)}>О данных</Action></footer>
    {dataOpen && <Sheet title="О данных" onClose={() => setDataOpen(false)}><div className="data-information">
      <p>Текст пожеланий разбирает Alice AI. Места и географические данные получаем из 2ГИС, сведения о событиях — из KudaGo.</p>
      <h3>Что сохраняется</h3><p>Черновик доступен 30 минут. Результат расчёта актуален не более 5 минут и может истечь раньше. После этого места и дорогу нужно проверить заново.</p>
      <p>Ваши собственные условия хранятся до 30 дней после последнего изменения. К ним можно вернуться через «Мои маршруты». Исходное пожелание сохраняется с маршрутом; удалить его можно вместе с маршрутом.</p>
      <h3>Когда вы делитесь</h3><p>Ссылка действует до 7 дней. Её может открыть любой пользователь MAX, у которого она есть. Личные точки старта и финиша передаются только при вашем явном выборе.</p>
      <h3>Как удалить</h3><p>В «Моих маршрутах» выберите «Удалить». Удаление маршрута отключает созданные для него ссылки. Собственные копии других пользователей это не удаляет.</p>
    </div></Sheet>}
  </main>;
}
const modesLabel = (mode: string | undefined) => mode ? modeLabels[mode] ?? mode : 'Передвижение';
