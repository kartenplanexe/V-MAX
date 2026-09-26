import { useEffect, useState } from 'react';
import type { Change, PlanningView } from '../shared/planning-form';
import type { PublicConfig } from '../shared/public-config';
import './planner-form.css';
import { PointPicker } from './PointPicker';
import { AddressPicker, type AddressChoice } from './AddressPicker';
import { PlanMap } from './PlanMap';
import { readMaxLaunchData, waitForMaxLaunchData } from './max-launch-data';

type Draft = PlanningView['draft'];
type Bootstrap = { token: string; view: PlanningView | null; expiredRoute?: string };
const messages: Record<string, string> = {
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
  OPENING_HOURS_UNVERIFIED: 'Часы работы прогулочного места не указаны. Проверьте доступность перед выходом.',
  WALK_WAYPOINTS_INCOMPLETE: 'Для прогулки найден только один подходящий ориентир. Это неполный маршрут, попробуйте увеличить радиус поиска или время.',
  CROWDING_NOT_USED_WITHOUT_TIME_SPECIFIC_FACT: 'Загруженность на выбранное время неизвестна и не учитывалась.',
  AVERAGE_CHECK_UNIT_UNVERIFIED: 'Средний чек не подтверждает стоимость вашего посещения.',
}[code] ?? (code.startsWith('PREFERENCE_NOT_VERIFIED:') ? `Пожелание не подтверждено: ${code.slice(24)}` : 'Часть сведений о месте требует уточнения.'));
const humanError = (code: string) => messages[code] ?? 'Не удалось выполнить действие. Проверьте параметры и попробуйте ещё раз.';
const modeLabels: Record<string, string> = { walking: 'Пешком', driving: 'На машине', cycling: 'На велосипеде' };
const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const displayDate = (value: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  .format(new Date(`${value}T12:00:00Z`));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function request<T>(path: string, token?: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'omit', cache: 'no-store', headers: {
    ...(token ? { 'X-Max-Init-Data': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
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
  const [mapOpen, setMapOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [resultMode, setResultMode] = useState<'list' | 'map'>('list');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mapsAvailable, setMapsAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch('/api/public-config', { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
      .then((value: PublicConfig | null) => { if (active) setMapsAvailable(Boolean(value?.maps.enabled)); })
      .catch(() => {});
    void waitForMaxLaunchData(() => readMaxLaunchData(window.WebApp?.initData, window.location.hash)).then(token => {
      if (!active) return;
      if (!token) { setBusy(''); setError('MAX не передал данные для входа. Закройте мини-приложение и откройте его снова из чата с ботом.'); return; }
      request<{ view: PlanningView | null; expiredRoute?: string }>('/api/planning/bootstrap', token)
        .then(value => { if (active) { setSession({ ...value, token }); setDraft(value.view ? structuredClone(value.view.draft) : null); setBusy(''); } })
        .catch(e => { if (active) { setBusy(''); setError(e instanceof Error ? e.message : 'Не удалось открыть планировщик.'); } });
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
  async function locate() {
    if (!navigator.geolocation) throw new Error('Геолокация недоступна. Выберите точку на карте.');
    const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve,
      () => reject(new Error('Не удалось получить местоположение. Выберите точку на карте.')), { timeout: 10_000, maximumAge: 60_000 }));
    const { latitude: lat, longitude: lon } = position.coords;
    patch(d => { d.points.origin = { lat, lon, locality_id: d.locality.id, label: 'Моё местоположение', source: 'user_geolocation' }; });
    setNotice('Точка выбрана. Сохраните изменения, чтобы учесть её в плане.');
  }
  async function quickSave(change: Change) {
    if (!session?.view) return;
    accept(await request<PlanningView>(base, session.token, 'PATCH', {
      base_version: session.view.version, event_id: crypto.randomUUID(), changes: [change],
    }));
  }
  async function quickLocate() {
    if (!navigator.geolocation) throw new Error('Геолокация недоступна. Выберите точку на карте.');
    const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve,
      () => reject(new Error('Не удалось получить местоположение. Выберите точку на карте.')), { timeout: 10_000, maximumAge: 60_000 }));
    await quickSave({ op: 'point', field: 'origin', point: { lat: position.coords.latitude,
      lon: position.coords.longitude, label: 'Моё местоположение', source: 'user_geolocation' } });
  }
  async function searchAddress(query: string): Promise<AddressChoice[]> {
    if (!session?.view) return [];
    const result = await request<{ choices: AddressChoice[] }>('/api/planning/addresses', session.token,
      'POST', { draft_id: session.view.id, q: query });
    return result.choices;
  }

  return <main className="planner-page">
    <header className="planner-header">
      <span className="planner-header-mark" aria-hidden="true">✦</span>
      <div><h1>{view?.result ? (view.draft.days.length > 1 ? 'План на несколько дней' : 'План на день') : view ? 'Уточнение условий' : 'План досуга'}</h1><p>{draft?.locality.name ?? 'Ваш маршрут в MAX'}</p></div>
    </header>
    {error && <div className="planner-message planner-message--error" role="alert">{error}</div>}
    {notice && <p className="planner-message" role="status">{notice}</p>}
    <p className="planner-progress" role="status" aria-live="polite">{busy}</p>
    {session && !view && <section className="planner-card planner-empty">
      <div className="planner-empty-icon" aria-hidden="true">✦</div>
      <h2>{session.expiredRoute ? 'Маршрут нужно обновить' : 'Сначала выберите маршрут в чате'}</h2>
      {session.expiredRoute ? <p>Черновик «{session.expiredRoute}» устарел. Вернитесь в чат и нажмите «Обновить маршрут» — места будут проверены заново.</p>
        : <p>Нажмите «Новый маршрут» или «Мои маршруты» в чате с ботом. Здесь появятся детали выбранного плана.</p>}
    </section>}
    {view && draft && <>
      <section className="planner-card planner-overview" aria-label="Сводка маршрута">
        <span className="planner-eyebrow">Маршрут</span>
        <h2>{draft.locality.name} · {draft.days.length === 1 ? displayDate(draft.days[0]!.date) : `${draft.days.length} дня`}</h2>
        <p>{draft.days.map(day => day.activities.map(activity => activity.label).join(' → ')).filter(Boolean).join(' · ') || 'Условия сохранены'}</p>
      </section>
      {!view.result && !dirty && <section className="planner-card planner-clarification" aria-label="Следующий шаг">
        <span className="planner-eyebrow">Я правильно понял?</span>
        <p className="planner-clarification-summary">{draft.days.map(day => `${displayDate(day.date)}${day.window ? ` · ${day.window.start}–${day.window.end}` : ''}`).join(' · ')}
          {draft.shared.mobility?.[0] ? ` · ${modeLabels[draft.shared.mobility[0]] ?? draft.shared.mobility[0]}` : ''}</p>
        {view.issues[0]?.code === 'ORIGIN_REQUIRED' ? <>
          <h2>Откуда удобнее начать?</h2>
          <p className="muted">Выберите удобный способ указать точку старта.</p>
          <div className="planner-quick-actions">
            <button className="primary-button" disabled={!!busy} onClick={() => void act('Определяем местоположение…', quickLocate)}>Моё местоположение</button>
            {mapsAvailable && <button className="secondary-button" disabled={!!busy} onClick={() => setMapOpen(true)}>Выбрать на карте</button>}
            <button className="secondary-button" disabled={!!busy} onClick={() => setAddressOpen(true)}>Ввести адрес</button>
          </div>
          {addressOpen && !detailsOpen && <AddressPicker city={draft.locality.name} search={searchAddress} disabled={!!busy}
            onClose={() => setAddressOpen(false)} onSelect={choice => void act('Сохраняем адрес…', async () => {
              await quickSave({ op: 'point', field: 'origin', point: { ...choice.point, label: choice.label, source: 'place_choice' } });
              setAddressOpen(false);
            })} />}
          {mapOpen && (view.capabilities.map_center || draft.points.origin) && <PointPicker
            center={draft.points.origin ?? view.capabilities.map_center!} onClose={() => setMapOpen(false)}
            onSelect={point => { setMapOpen(false); void act('Сохраняем точку…', () => quickSave({ op: 'point', field: 'origin',
              point: { ...point, label: 'Выбранная точка на карте', source: 'user_map' } })); }} />}
        </> : view.issues[0]?.code === 'TRANSPORT_REQUIRED' ? <>
          <h2>Как будем передвигаться?</h2>
          <div className="planner-quick-actions">{view.capabilities.modes.map(mode => <button key={mode} className="secondary-button"
            disabled={!!busy} onClick={() => void act('Сохраняем…', () => quickSave({ op: 'mobility', mode }))}>{modeLabels[mode] ?? mode}</button>)}</div>
        </> : view.issues[0]?.code === 'WINDOW_REQUIRED' ? <>
          <h2>Когда вы свободны?</h2>
          <p className="muted">Это примерные окна — их можно изменить.</p>
          <div className="planner-quick-actions">{[['09:00', '11:00'], ['13:00', '15:00'], ['18:00', '20:00']].map(([start, end]) => <button
            key={start} className="secondary-button" disabled={!!busy} onClick={() => void act('Сохраняем…', () => quickSave({ op: 'window',
              day_ids: draft.days.map(day => day.day_id), start: start!, end: end! }))}>{start}–{end}</button>)}</div>
        </> : view.issues.length ? <><h2>{humanError(view.issues[0]!.code)}</h2><p className="muted">Измените только этот пункт в условиях ниже.</p></>
          : <><h2>Всё верно?</h2><p className="muted">Составлю план с учётом времени в пути и расписания мест.</p>
            <button className="primary-button" disabled={!!busy} onClick={() => void act('Подбираем места и проверяем расписание…', calculate)}>Составить план</button></>}
      </section>}
      <details className="parameters-panel" open={detailsOpen || !!dirty} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
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
              {mapsAvailable && <button className="secondary-button" type="button" onClick={() => setMapOpen(true)}>Выбрать на карте</button>}
              <button className="secondary-button" type="button" onClick={() => setAddressOpen(true)}>Ввести адрес</button>
              {addressOpen && detailsOpen && <AddressPicker city={draft.locality.name} search={searchAddress} disabled={!!busy}
                onClose={() => setAddressOpen(false)} onSelect={choice => {
                  patch(d => { d.points.origin = { ...choice.point, locality_id: d.locality.id, label: choice.label, source: 'place_choice' }; });
                  setAddressOpen(false); setNotice('Адрес выбран. Сохраните изменения, чтобы учесть его в плане.');
                }} />}
              {mapOpen && (view.capabilities.map_center || draft.points.origin) && <PointPicker
                center={draft.points.origin ?? view.capabilities.map_center!} onClose={() => setMapOpen(false)}
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
          setError(''); setNotice('В чате с ботом напишите новый запрос — текущий план останется доступен здесь до замены.');
        }}>Начать другой план в чате</button>
      </section>
      </details>
      {view.result && !dirty && <section className="planner-card plan-result" aria-label="Результат расчёта">
        <h2>{view.result.status === 'AVAILABLE' ? 'Ваш план' : view.result.status === 'LIMITED' ? 'Получился неполный план' : 'План пока не получился'}</h2>
        <p className="muted">Места и дорога — по данным 2ГИС. Время посещения и расходы приблизительные.</p>
        {!!view.result.days.some(d => d.visits.length) && <>
          {mapsAvailable && <nav className="view-switch" aria-label="Режим отображения">
            <button type="button" aria-pressed={resultMode === 'list'} onClick={() => setResultMode('list')}>План</button>
            <button type="button" aria-pressed={resultMode === 'map'} onClick={() => setResultMode('map')}>Карта</button>
          </nav>}
          <dl className="plan-metrics">
            <div><dt>Мест</dt><dd>{view.result.days.reduce((n, d) => n + d.visits.length, 0)}</dd></div>
            <div><dt>Расходы ≈</dt><dd>{view.result.total_expected_cost_minor == null ? 'Неизвестны' : `${view.result.total_expected_cost_minor / 100} ₽`}</dd></div>
            <div><dt>В пути с запасом</dt><dd>{view.result.days.reduce((n, d) => n + (d.total_safe_travel_minutes ?? 0), 0)} мин</dd></div>
          </dl>
        </>}
        {!!view.result.issues?.length && <ul className="form-issues">{view.result.issues.map(issue => <li key={issue}>{humanError(issue)}</li>)}</ul>}
        {view.result.days.map(day => <div key={day.day_id}>
          <h3>{displayDate(day.date)}</h3>
          {resultMode === 'map' ? <PlanMap day={day} origin={view.result?.origin ?? draft.points.origin} /> : <ol className="plan-timeline">
            {day.visits.length > 0 && (view.result?.origin ?? draft.points.origin) && <li className="timeline-origin" key="origin">
              <div className="timeline-visit"><time>{draft.days.find(d => d.day_id === day.day_id)?.window?.start ?? 'Старт'}</time>
                <div><h4>Начало маршрута</h4><p>{(view.result?.origin ?? draft.points.origin)?.label ?? 'Выбранная точка'}</p></div></div>
            </li>}
            {day.visits.map(visit => <li key={`${visit.activity_id}:${visit.place_id}`}>
            <div className="timeline-travel">В пути {visit.travel_before_minutes} мин{visit.distance_before_meters == null ? '' : ` · ≈${Math.round(visit.distance_before_meters / 100) / 10} км`} · запас перед посещением {visit.arrival_buffer_minutes} мин</div>
            <div className="timeline-visit"><time>{clock(visit.starts_at)}<span>{clock(visit.ends_at)}</span></time>
              <div><h4>{visit.name}</h4>{visit.location_label && <p>{visit.location_label}</p>}
                <p>{visit.ends_at - visit.starts_at} мин на посещение</p><p>{visit.price_expected_minor == null ? 'Стоимость неизвестна' : `${visit.price_expected_minor / 100} ₽ — оценка`}</p>
                <p>{visit.source?.data_mode === 'test' ? 'Источник: учебный набор' : visit.source ? `Источник: ${visit.source.provider === '2gis' ? '2ГИС' : visit.source.provider}` : 'Источник не указан'}</p>
                {visit.source?.provider === '2gis' && visit.source.url?.startsWith('https://2gis.ru/') &&
                  <a href={visit.source.url} target="_blank" rel="noopener noreferrer">Проверить точное место в 2ГИС ↗</a>}</div>
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
