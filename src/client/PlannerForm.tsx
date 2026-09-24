import { useEffect, useRef, useState } from 'react';
import type { Change, PlanningView } from '../shared/planning-form';
import './planner-form.css';
import { PointPicker } from './PointPicker';
import { PlanMap } from './PlanMap';
import { readMaxLaunchData, waitForMaxLaunchData } from './max-launch-data';

type Draft = PlanningView['draft'];
type Bootstrap = { token: string; view: PlanningView | null };
type LocalityChoice = { id: string; name: string; region_id: string; timezone: string; token: string; center: { lat: number; lon: number } };
let bootstrap: Promise<Bootstrap> | undefined;
const messages: Record<string, string> = {
  PLANNER_NOT_CONFIGURED: 'Планировщик пока недоступен. Попробуйте открыть его позже.',
  GEOGRAPHY_UNAVAILABLE: 'Не удалось получить города из 2ГИС. Проверьте подключение и повторите поиск.',
  GEOGRAPHY_RATE_LIMIT: 'Слишком частый поиск города. Подождите минуту.',
  LOCALITY_SELECTION_EXPIRED: 'Выберите город ещё раз — время выбора истекло.',
  DAILY_LIMIT: 'Сегодня доступный лимит запросов исчерпан. Сохранённые параметры можно посмотреть и изменить.',
  OPERATION_IN_PROGRESS: 'Предыдущее действие ещё выполняется. Дождитесь результата.',
  INTENT_INTERRUPTED: 'Разбор был прерван. Напишите новый запрос; предыдущий автоматически не повторяется.',
  PLAN_INTERRUPTED: 'Расчёт прервался. Можно запустить его снова.',
  CATALOG_UNAVAILABLE: 'Справочник мест этого города сейчас недоступен. План не был составлен.',
  INVALID_REQUEST_TEXT: 'Напишите пожелания — не более 4000 символов.',
  INTENT_INVALID_RESPONSE: 'Не удалось надёжно разобрать пожелания. План не создан.',
  INTENT_NEEDS_CLARIFICATION: 'В запросе есть неоднозначное или неподдержанное условие. Мы не стали его угадывать.',
  INTENT_PROVIDER_FAILED: 'Сервис разбора запроса не ответил. Автоматического повтора не было.',
  INTENT_TRUNCATED: 'Ответ оборвался. Неполные параметры не сохранялись.',
  INTENT_RUN_LIMIT: 'Лимит обращений к нейросети на этот запуск закончился.',
  INTENT_RATE_LIMIT: 'Слишком много новых запросов. Подождите десять минут; поля уже созданного плана можно менять без нейросети.',
  INTENT_IN_PROGRESS: 'Разбор уже выполняется. Дождитесь результата.',
  INTENT_BUSY: 'Разбор запросов занят. Попробуйте позже.',
  LOCALITY_RESOLUTION_REQUIRED: 'Город в пожеланиях отличается от выбранного. Выберите нужный город перед отправкой.',
  BUDGET_SCOPE_REQUIRED: 'Уточните: бюджет на человека или на всех, на день или на весь план.',
  DESTINATION_REQUIRED: 'В запросе указан финиш. Выберите его или явно отмените это условие.',
  AUTH_REQUIRED: 'Не удалось подтвердить сеанс MAX. Закройте мини-приложение и откройте снова из чата с ботом.',
  DRAFT_NOT_FOUND: 'Этот черновик больше недоступен. Обновите страницу.',
  STALE_VERSION: 'Параметры уже изменились. Загрузите сохранённую версию и проверьте её.',
  STALE_RESULT: 'Параметры изменились во время расчёта. Подтвердите новую версию.',
  INVALID_ACTION: 'Проверьте даты, время и числовые значения. Начало должно быть раньше окончания.',
  INCOMPLETE_DRAFT: 'Перед расчётом исправьте отмеченные параметры.',
  ORIGIN_REQUIRED: 'Выберите точку старта.', WINDOW_REQUIRED: 'Укажите время начала и окончания.',
  WINDOW_EXPIRED: 'Это время уже прошло. Выберите другую дату или время.',
  TIME_CONFLICT: 'Время начала и окончания не соответствует продолжительности.',
  DUPLICATE_DATE: 'У каждого дня должна быть своя дата.',
  TRANSPORT_REQUIRED: 'Выберите доступный способ передвижения.',
  UNSUPPORTED_TRANSPORT: 'Этот способ передвижения пока не подключён.',
  PARTY_REQUIRED: 'Для бюджета на человека укажите число участников.',
  TRANSPORT_COST_POLICY_REQUIRED: 'Пока не можем проверить общий бюджет поездки на машине. Выберите пеший маршрут или не задавайте лимит.',
  POINT_OUTSIDE_AREA: 'Точка вне области выбранного города. Выберите другой старт или город.',
  POINT_VERIFICATION_UNAVAILABLE: 'Проверка выбранной точки пока недоступна.',
  PLAN_IN_PROGRESS: 'Расчёт уже выполняется. Подождите и загрузите сохранённую версию.',
  PLAN_RATE_LIMIT: 'Доступны три расчёта за десять минут. Попробуйте позже.',
  PLANNER_BUSY: 'Планировщик занят. Попробуйте немного позже.',
  PLANNING_FAILED: 'Сервис расчёта сейчас недоступен. Ваши параметры сохранены.',
  SESSION_CAPACITY: 'Слишком много открытых планов. Вернитесь к последнему или подождите.',
  CATALOG_MISMATCH: 'Категории нужно обновить перед подбором мест.',
  PLANNING_PIPELINE_FAILED: 'Не удалось завершить расчёт. Ваши параметры сохранены — попробуйте позже.',
  ROUTE_RECHECK_FAILED: 'Время дороги изменилось: прежний план больше не помещается. Попробуйте расширить свободное окно.',
  PLAN_EXPIRED_OR_INVALID: 'Данные устарели во время расчёта. Этот план не выдаём как проверенный.',
  ROUTING_BUDGET_EXCEEDED: 'Для такого плана требуется слишком много расчётов маршрута. Сократите число занятий.',
};
const warningText = (code: string) => ({
  PRICE_UNKNOWN: 'Не все цены известны: общий бюджет не подтверждён.',
  PRICE_ESTIMATED: 'Цена — ориентир, а не гарантированная стоимость.',
  BUDGET_ESTIMATED_NOT_GUARANTEED: 'Расходы оценены приблизительно. Соблюдение лимита не гарантируется.',
  TRANSPORT_COST_UNKNOWN: 'Стоимость транспорта неизвестна.',
  RETRIEVAL_PARTIAL: 'Получена только часть мест. Подходящие варианты могут остаться за пределами поиска.',
  ROUTE_MATRIX_INCOMPLETE: 'Не все переходы удалось проверить. Такие переходы исключены из плана.',
  ROUTING_PROVIDER_FAILURE: 'Часть запросов маршрутов завершилась ошибкой.',
  ROUTE_TIME_IS_ESTIMATE: 'Время дороги рассчитано с запасом, но не гарантирует прибытие.',
  CROWDING_NOT_USED_WITHOUT_TIME_SPECIFIC_FACT: 'Загруженность на выбранное время неизвестна и не учитывалась.',
  AVERAGE_CHECK_UNIT_UNVERIFIED: 'Средний чек не подтверждает стоимость вашего посещения.',
}[code] ?? (code.startsWith('PREFERENCE_NOT_VERIFIED:') ? `Пожелание не подтверждено: ${code.slice(24)}` : 'Часть сведений о месте требует уточнения.'));
const humanError = (code: string) => messages[code] ?? 'Не удалось выполнить действие. Проверьте параметры и попробуйте ещё раз.';
const modeLabels: Record<string, string> = { walking: 'Пешком', driving: 'На машине', cycling: 'На велосипеде' };
const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function request<T>(path: string, token?: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'omit', cache: 'no-store', headers: {
    ...(token ? { Authorization: `max ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(humanError(result.error));
  return result as T;
}
function changesFor(view: PlanningView, draft: Draft): Change[] {
  const original = view.draft, changes: Change[] = [];
  for (const day of draft.days) {
    const before = original.days.find(d => d.day_id === day.day_id)!;
    if (day.date !== before.date) changes.push({ op: 'date', day_id: day.day_id, date: day.date });
    if (day.window && !same(day.window, before.window)) changes.push({ op: 'window', day_ids: [day.day_id], ...day.window });
    if (!same(day.order, before.order)) changes.push({ op: 'order', day_id: day.day_id, activity_ids: day.activities.map(a => a.id) });
  }
  if (!same(draft.shared.mobility, original.shared.mobility)) changes.push({ op: 'mobility', mode: draft.shared.mobility?.[0] ?? '' });
  if (!same(draft.shared.budget, original.shared.budget) && draft.shared.budget) changes.push({ op: 'budget', value: draft.shared.budget });
  if (draft.shared.party?.total !== original.shared.party?.total) changes.push({ op: 'party', total: draft.shared.party?.total ?? null });
  for (const field of ['origin', 'destination'] as const) {
    const point = draft.points[field];
    if (!same(point, original.points[field])) {
      if (point) changes.push({ op: 'point', field, point: { lat: point.lat, lon: point.lon, label: point.label ?? 'Выбранная точка', source: point.source ?? 'place_choice' } });
      else if (field === 'destination') changes.push({ op: 'clear_destination' });
    }
  }
  return changes;
}

export function PlannerForm() {
  const [session, setSession] = useState<Bootstrap | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('Загружаем…');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [text, setText] = useState('');
  const [submittedText, setSubmittedText] = useState('');
  const [cityQuery, setCityQuery] = useState('');
  const [cities, setCities] = useState<LocalityChoice[]>([]);
  const [city, setCity] = useState<LocalityChoice | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [resultMode, setResultMode] = useState<'list' | 'map'>('list');
  const pendingStart = useRef<{ text: string; eventId: string } | null>(null);
  useEffect(() => {
    let active = true;
    void waitForMaxLaunchData(() => readMaxLaunchData(window.WebApp?.initData, window.location.hash)).then(token => {
      if (!active) return;
      if (!token) { setBusy(''); setError('MAX не передал данные для входа. Закройте мини-приложение и откройте его снова из чата с ботом.'); return; }
      bootstrap ??= request<{ view: PlanningView | null }>('/api/planning/bootstrap', token).then(value => ({ ...value, token }));
      bootstrap.then(value => { if (active) { setSession(value); setDraft(value.view ? structuredClone(value.view.draft) : null); setBusy(''); } })
        .catch(e => { bootstrap = undefined; if (active) { setBusy(''); setError(e instanceof Error ? e.message : 'Не удалось открыть планировщик.'); } });
    });
    return () => { active = false; };
  }, []);
  function accept(view: PlanningView) {
    setSession(current => current ? { ...current, view } : null); setDraft(structuredClone(view.draft));
  }
  async function act(label: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить действие.'); }
    finally { setBusy(''); }
  }
  const patch = (edit: (value: Draft) => void) => setDraft(current => {
    if (!current) return current; const next = structuredClone(current); edit(next); return next;
  });
  const view = session?.view, dirty = view && draft ? !same(view.draft, draft) : false;
  const base = view ? `/api/planning/drafts/${view.id}` : '';
  async function save() {
    if (!session?.view || !draft) return;
    const changes = changesFor(session.view, draft);
    if (!changes.length) return;
    accept(await request<PlanningView>(base, session.token, 'PATCH', {
      base_version: session.view.version, event_id: crypto.randomUUID(), changes,
    }));
    setNotice('Изменения сохранены. Проверьте параметры и подтвердите план.');
  }
  async function calculate() {
    if (!session?.view || dirty) return;
    let current = session.view;
    if (current.phase === 'DRAFT') {
      current = await request<PlanningView>(base + '/confirm', session.token, 'POST', { base_version: current.version, event_id: crypto.randomUUID() });
      accept(current);
    }
    accept(await request<PlanningView>(base + '/plan', session.token, 'POST', { base_version: current.version, event_id: crypto.randomUUID() }));
  }
  async function start() {
    if (!session || !city) return;
    const requestKey = text + '\n' + city.token;
    if (pendingStart.current?.text !== requestKey) pendingStart.current = { text: requestKey, eventId: crypto.randomUUID() };
    const result = await request<{ status: 'off_topic' | 'draft'; view?: PlanningView }>('/api/planning/requests', session.token, 'POST', {
      event_id: pendingStart.current.eventId, user_text: text, locality_token: city.token,
    });
    if (result.status === 'off_topic') { setNotice('Напишите, чем хочется заняться и когда. Например: «Завтра вечером хочу в музей».'); return; }
    if (result.view) { accept(result.view); setSubmittedText(text); }
  }
  async function locate() {
    if (!navigator.geolocation) throw new Error('Геолокация недоступна. Выберите точку на карте.');
    const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve,
      () => reject(new Error('Не удалось получить местоположение. Выберите точку на карте.')), { timeout: 10_000, maximumAge: 60_000 }));
    const { latitude: lat, longitude: lon } = position.coords;
    patch(d => { d.points.origin = { lat, lon, locality_id: d.locality.id, label: 'Моё местоположение', source: 'user_geolocation' }; });
    setNotice('Точка выбрана. Сохраните изменения, чтобы учесть её в плане.');
  }

  return <main className="planner-page">
    <header className="planner-header">
      <div><h1>{view?.result ? 'Ваш план' : view ? 'Уточнение условий' : 'План досуга'}</h1><p>{draft?.locality.name ?? 'Спланируйте свободное время'}</p></div>
    </header>
    {error && <div className="planner-message planner-message--error" role="alert">{error}</div>}
    {notice && <p className="planner-message" role="status">{notice}</p>}
    {error && session && !view && pendingStart.current && <button type="button" className="secondary-button" disabled={!!busy}
      onClick={() => { pendingStart.current = null; void act('Повторно разбираем пожелания…', start); }}>Повторить разбор новым запросом</button>}
    <p className="planner-progress" role="status" aria-live="polite">{busy}</p>
    {session && !view && <section className="planner-card request-composer">
      <h2>Как хотите провести время?</h2>
      <p className="muted">Сначала пожелания, затем проверка параметров и готовый план.</p>
      <form onSubmit={e => { e.preventDefault(); void act('Ищем город…', async () => {
        const result = await request<{ choices: LocalityChoice[] }>('/api/planning/localities?q=' + encodeURIComponent(cityQuery), session.token);
        setCities(result.choices); setCity(null);
        if (!result.choices.length) setNotice('Для этого населённого пункта не удалось получить необходимые данные 2ГИС. Можно поискать соседний город — только если вам подходит поездка туда.');
      }); }}>
        <label>Город или населённый пункт<input value={cityQuery} minLength={2} maxLength={100} required disabled={!!busy}
          onChange={e => { setCityQuery(e.target.value); setCity(null); setCities([]); }} placeholder="Где планируем досуг?" /></label>
        <button type="submit" className="secondary-button" disabled={!!busy || cityQuery.trim().length < 2}>Найти город</button>
      </form>
      <div className="city-choices">{cities.map(choice => <button type="button" className="secondary-button" key={choice.id}
        aria-pressed={city?.id === choice.id} onClick={() => setCity(choice)}>{choice.name}{city?.id === choice.id ? ' ✓' : ''}</button>)}</div>
      <form onSubmit={e => { e.preventDefault(); void act('Разбираем пожелания…', start); }}>
        <label htmlFor="initial-request">Ваши пожелания<textarea id="initial-request" value={text} maxLength={4000} rows={5} required disabled={!!busy}
          placeholder="Завтра вечером хочу в музей, а потом в кафе" onChange={e => setText(e.target.value)} /></label>
        <button className="primary-button" disabled={!!busy || !text.trim() || !city}>Продолжить</button>
      </form>
      <p className="field-hint">Пожелания обрабатывает Алиса в Yandex Cloud. Не указывайте в тексте телефон и другие личные сведения.</p>
    </section>}
    {view && draft && <>
      {submittedText && <div className="request-bubble"><small>Ваш запрос</small>{submittedText}</div>}
      <details className="parameters-panel" open={!view.result || !!dirty}>
      <summary>Изменить условия</summary>
      <section className="planner-card">
        <div className="section-heading"><h2>Я правильно понял?</h2><span>{draft.locality.name}</span></div>
        <p className="muted">Проверьте время, способ передвижения и точку старта.</p>
        <form onSubmit={e => { e.preventDefault(); void act('Сохраняем…', save); }}>
          <fieldset disabled={!!busy}>
            {draft.days.map((day, index) => <section className="day-fields" key={day.day_id} aria-label={`День ${index + 1}`}>
              {draft.days.length > 1 && <h3>День {index + 1}</h3>}
              <div className="field-row field-row--time">
                <label>Дата<input aria-label={`Дата дня ${index + 1}`} type="date" required value={day.date}
                  onChange={e => patch(d => { d.days[index]!.date = e.target.value; })} /></label>
                <label>С<input aria-label={`Начало дня ${index + 1}`} type="text" inputMode="numeric" pattern="[0-2][0-9]:[0-5][0-9]" placeholder="16:00" required value={day.window?.start ?? ''}
                  onChange={e => patch(d => { d.days[index]!.window = { start: e.target.value, end: day.window?.end ?? '' }; })} /></label>
                <label>До<input aria-label={`Окончание дня ${index + 1}`} type="text" inputMode="numeric" pattern="[0-2][0-9]:[0-5][0-9]" placeholder="19:00" required value={day.window?.end ?? ''}
                  onChange={e => patch(d => { d.days[index]!.window = { start: day.window?.start ?? '', end: e.target.value }; })} /></label>
              </div>
              {Object.entries(view.provenance).some(([path, source]) => path.startsWith(`days.${day.day_id}.`) && source.includes('suggested')) &&
                <p className="field-hint">Часть даты или времени предложена системой. Проверьте её и при необходимости измените.</p>}
              <div className="activity-order"><span className="muted">Порядок</span><ol>{day.activities.map(a => <li key={a.id}>{a.label}</li>)}</ol>
                {day.activities.length > 1 && <button type="button" className="text-button" onClick={() => patch(d => {
                  const target = d.days[index]!; target.activities.reverse(); target.order = target.activities.slice(1).map((a, i) => [target.activities[i]!.id, a.id]);
                })}>Поменять порядок</button>}
              </div>
              {day.activities.some(a => a.requirements.length || a.selection.category_policy === 'named_types_only') && <ul className="activity-constraints">
                {day.activities.map(a => <li key={a.id}><strong>{a.label}</strong>
                  {a.selection.category_policy === 'named_types_only' && <p>Только: {a.selection.named_types.join(', ')}.</p>}
                  {a.requirements.map((r, i) => <p key={i}>{r.strength === 'required' ? 'Обязательно' : 'Желательно'}: {r.text}</p>)}
                </li>)}
              </ul>}
            </section>)}
            <div className="field-row">
              <label>Передвижение<select value={draft.shared.mobility?.[0] ?? ''} onChange={e => patch(d => { d.shared.mobility = [e.target.value]; })}>
                <option value="" disabled>Выберите способ</option>{view.capabilities.modes.map(mode => <option key={mode} value={mode}>{modeLabels[mode] ?? mode}</option>)}
              </select></label>
              <label>Участников<input type="number" min="1" max="100" placeholder="Не указано" value={draft.shared.party?.total ?? ''}
                onChange={e => patch(d => { if (e.target.value) d.shared.party = { ...d.shared.party, total: Number(e.target.value) }; else if (d.shared.party) delete d.shared.party.total; })} /></label>
            </div>
            <p className="field-hint">Общественный транспорт пока не подключён.</p>
            <label>Бюджет<select value={draft.shared.budget?.kind ?? 'unspecified'} onChange={e => patch(d => {
              d.shared.budget = e.target.value === 'limit' ? { kind: 'limit', amount_rub: 3000, basis: 'whole_party', period: 'per_day' } : { kind: e.target.value as 'unspecified' | 'unlimited' };
            })}><option value="unspecified">Не указан</option><option value="unlimited">Без ограничения</option><option value="limit">Указать лимит</option></select></label>
            {draft.shared.budget?.kind === 'limit' && <div className="budget-fields">
              <label>Сумма, ₽<input type="number" min="0" max="100000000" step="0.01" required value={draft.shared.budget.amount_rub}
                onChange={e => patch(d => { if (d.shared.budget?.kind === 'limit') d.shared.budget.amount_rub = Number(e.target.value); })} /></label>
              <label>Для кого<select value={draft.shared.budget.basis} onChange={e => patch(d => { if (d.shared.budget?.kind === 'limit') d.shared.budget.basis = e.target.value as 'whole_party' | 'per_person'; })}>
                <option value="unknown" disabled>Уточните</option><option value="whole_party">На всех</option><option value="per_person">На человека</option></select></label>
              <label>Период<select value={draft.shared.budget.period} onChange={e => patch(d => { if (d.shared.budget?.kind === 'limit') d.shared.budget.period = e.target.value as 'per_day' | 'whole_trip'; })}>
                <option value="unknown" disabled>Уточните</option><option value="per_day">На день</option><option value="whole_trip">На весь план</option></select></label>
            </div>}
            <section className="point-fields"><h3>Откуда начинаем?</h3>
              <p className="selected-point">⌖ {draft.points.origin?.label ?? 'Точка не выбрана'}</p>
              <button className="secondary-button" type="button" onClick={() => void act('Определяем местоположение…', locate)}>Моё местоположение</button>
              <button className="secondary-button" type="button" onClick={() => setMapOpen(true)}>Выбрать на карте</button>
              {mapOpen && (view.capabilities.map_center || city?.center || draft.points.origin) && <PointPicker
                center={draft.points.origin ?? view.capabilities.map_center ?? city!.center} onClose={() => setMapOpen(false)}
                onSelect={point => { patch(d => { d.points.origin = { ...point, locality_id: d.locality.id, label: 'Выбранная точка на карте', source: 'user_map' }; }); setMapOpen(false); }} />}
              <label className="checkbox-label"><input type="checkbox" checked={!!draft.points.destination} disabled={!draft.points.origin}
                onChange={e => patch(d => { if (e.target.checked) d.points.destination = structuredClone(d.points.origin); else delete d.points.destination; })} />Вернуться к выбранной точке в конце</label>
              {draft.points.destination && <p className="field-hint">Финиш: {draft.points.destination.label}. Он не меняется автоматически при изменении старта.</p>}
            </section>
            <div className="form-actions"><button className="secondary-button" type="submit" disabled={!dirty}>Сохранить изменения</button>
              <button className="text-button" type="button" onClick={() => { setDraft(structuredClone(view.draft)); setError(''); setNotice(''); }} disabled={!dirty}>Отменить правки</button></div>
          </fieldset>
        </form>
        {!dirty && view.issues.length > 0 && <ul className="form-issues" aria-label="Что нужно уточнить">{view.issues.map((issue, i) => <li key={i}>{humanError(issue.code)}</li>)}</ul>}
        {dirty && <p className="field-hint">Сначала сохраните изменения — затем подтвердите обновлённые параметры.</p>}
        <button className="primary-button" disabled={!!busy || !!dirty || !!view.issues.length || view.phase === 'RESULT' || view.phase === 'PLANNING'}
          onClick={() => void act('Подбираем места и проверяем расписание…', calculate)}>{view.phase === 'RESULT' ? 'Расчёт завершён' : 'Всё верно — составить план'}</button>
        <button className="text-button refresh-button" disabled={!!busy} onClick={() => void act('Загружаем сохранённую версию…', async () => {
          if (session) accept(await request<PlanningView>(base, session.token));
        })}>Загрузить сохранённую версию</button>
        <button className="text-button refresh-button" disabled={!!busy} onClick={() => {
          setSession(current => current ? { ...current, view: null } : null); setDraft(null); pendingStart.current = null;
          setError(''); setNotice('');
        }}>Начать другой план</button>
      </section>
      </details>
      {view.result && !dirty && <section className="planner-card plan-result" aria-label="Результат расчёта">
        <h2>{view.result.status === 'AVAILABLE' ? 'Ваш план' : view.result.status === 'LIMITED' ? 'Получился неполный план' : 'План пока не получился'}</h2>
        <p className="muted">Места и дорога — по данным 2ГИС. Время посещения и расходы приблизительные.</p>
        {!!view.result.days.some(d => d.visits.length) && <>
          <nav className="view-switch" aria-label="Режим отображения">
            <button type="button" aria-pressed={resultMode === 'list'} onClick={() => setResultMode('list')}>План</button>
            <button type="button" aria-pressed={resultMode === 'map'} onClick={() => setResultMode('map')}>Карта</button>
          </nav>
          <dl className="plan-metrics">
            <div><dt>Мест</dt><dd>{view.result.days.reduce((n, d) => n + d.visits.length, 0)}</dd></div>
            <div><dt>Расходы ≈</dt><dd>{view.result.total_expected_cost_minor == null ? 'Неизвестны' : `${view.result.total_expected_cost_minor / 100} ₽`}</dd></div>
            <div><dt>В пути с запасом</dt><dd>{view.result.days.reduce((n, d) => n + (d.total_safe_travel_minutes ?? 0), 0)} мин</dd></div>
          </dl>
        </>}
        {!!view.result.issues?.length && <ul className="form-issues">{view.result.issues.map(issue => <li key={issue}>{humanError(issue)}</li>)}</ul>}
        {view.result.days.map(day => <div key={day.day_id}>
          <h3>{new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(day.date))}</h3>
          {resultMode === 'map' ? <PlanMap day={day} /> : <ol className="plan-timeline">{day.visits.map(visit => <li key={visit.activity_id}>
            <div className="timeline-travel">В пути {visit.travel_before_minutes} мин · запас перед посещением {visit.arrival_buffer_minutes} мин</div>
            <div className="timeline-visit"><time>{clock(visit.starts_at)}<span>{clock(visit.ends_at)}</span></time>
              <div><h4>{visit.name}</h4><p>{visit.ends_at - visit.starts_at} мин на посещение</p><p>{visit.price_expected_minor == null ? 'Стоимость неизвестна' : `${visit.price_expected_minor / 100} ₽ — оценка`}</p>
                <p>{visit.source?.data_mode === 'test' ? 'Источник: учебный набор' : visit.source ? `Источник: ${visit.source.provider}` : 'Источник не указан'}</p></div>
            </div>
          </li>)}</ol>}
          {day.visits.length > 0 && day.ends_at != null && <p className="field-hint">{draft.points.destination ? 'Прибытие к финишу' : 'Завершение плана'} в {clock(day.ends_at)}. Всего на дорогу с запасом: {day.total_safe_travel_minutes ?? '—'} мин.</p>}
          {!!day.missing_activity_ids.length && <p className="planner-message">Не удалось включить: {day.missing_activity_ids.map(id => draft.days.find(d => d.day_id === day.day_id)?.activities.find(a => a.id === id)?.label ?? 'занятие').join(', ')}.</p>}
        </div>)}
        {view.result.status === 'UNAVAILABLE' && <p>Подтверждённых подходящих мест для этих ограничений нет. Попробуйте изменить время или бюджет. Неизвестную стоимость мы не считаем нулевой.</p>}
        {!!view.result.warnings.length && <ul className="result-warnings">{[...new Set(view.result.warnings.map(warningText))].map(text => <li key={text}>{text}</li>)}</ul>}
        {view.result.shortlist?.groups.some(group => group.truncated) && <p className="field-hint">Для расчёта использована сокращённая подборка кандидатов. Это не сравнение всех мест в городе.</p>}
        <p className="field-hint">Для другого расчёта измените и заново подтвердите параметры.
          {view.result.days.some(day => day.visits.length) && <> Общая стоимость: {view.result.total_expected_cost_minor == null ? 'неизвестна' : `${view.result.total_expected_cost_minor / 100} ₽ (оценка)`}.</>}</p>
      </section>}
    </>}
  </main>;
}
