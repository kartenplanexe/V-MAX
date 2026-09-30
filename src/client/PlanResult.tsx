import { useState } from 'react';
import type { PlanningView } from '../shared/planning-form';
import { unavailablePlanNotice } from '../shared/plan-evidence-text';
import { PlanMap } from './PlanMap';
import { Action, Icon, useExpired } from './PlannerUi';
import { transitStageText } from '../shared/route-travel-text';
import { resultValidUntil, placesStaleAt } from './result-freshness';
import type { AlternativeTarget } from '../shared/route-alternatives';
import type { EventPanelTarget } from './EventPanel';
import { eventSourceUrl, eventWindowText } from './EventFacts';
import { eventGapText } from '../shared/event-plan-text';
import { CandidatePlaces } from './CandidatePlaces';

const time = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const number = new Intl.NumberFormat('ru-RU');
const date = (value: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const money = (value: number | null | undefined) => value == null ? 'Неизвестно' : `${number.format(value / 100)} ₽`;
const modes: Record<string, string> = { walking: 'Пешком', driving: 'На машине', cycling: 'На велосипеде', public_transport: 'Общественным транспортом' };
type Transit = NonNullable<NonNullable<PlanningView['result']>['days'][number]['travel_segments']>[number]['transit'];
function TransitDetails({ transit }: { transit: Transit }) {
  if (!transit) return null;
  return <details className="transit-details"><summary>{transit.pedestrian ? 'Этот участок — пешком' : `Как проехать${transit.transferCount ? ` · пересадок ${transit.transferCount}` : ''}`}</summary>
    <ol>{transit.stages.map((stage, index) => <li key={index}><strong>{transitStageText(stage)}</strong>
      {stage.movingSeconds != null && <span>В пути около {Math.ceil(stage.movingSeconds / 60)} мин</span>}
      {stage.waitingSeconds != null && stage.waitingSeconds > 0 && <span>Ожидание около {Math.ceil(stage.waitingSeconds / 60)} мин</span>}</li>)}</ol>
    <p>{transit.waitingSeconds != null && transit.waitingSeconds > 0 ? 'Ожидание уже включено в общее время дороги. ' : ''}{transit.scheduleEvidence === 'unknown' ? 'Расписание не подтверждено.' : transit.scheduleEvidence === 'predicted' ? 'Время отправления прогнозируется.' : 'Расписание передано провайдером.'} Проверьте отправление перед поездкой. Стоимость проезда неизвестна.</p>
  </details>;
}
export function PlanResult({ view, mapsAvailable, busy, edit, retry, replace, share, chooseEvent, warningText, humanError }: {
  view: PlanningView; mapsAvailable: boolean; busy: boolean; edit: () => void; retry: () => void;
  replace: (target: AlternativeTarget) => void; share: () => void;
  chooseEvent: (target: EventPanelTarget) => void;
  warningText: (code: string) => string; humanError: (code: string) => string;
}) {
  const plan = view.result!, draft = view.draft;
  const expired = useExpired(resultValidUntil(view));
  const stalePlaces = useExpired(placesStaleAt(plan));
  const [selectedDay, setSelectedDay] = useState(plan.days[0]?.day_id ?? ''), [mode, setMode] = useState<'plan' | 'map'>('plan');
  const [selectedVisit, setSelectedVisit] = useState(0);
  const day = plan.days.find(value => value.day_id === selectedDay) ?? plan.days[0];
  const requestedDay = draft.days.find(value => value.day_id === day?.day_id);
  const visits = day?.visits ?? [];
  const stopCount = plan.days.reduce((sum, value) => sum + value.visits.length, 0);
  const travel = plan.days.every(value => value.total_safe_travel_minutes != null)
    ? plan.days.reduce((sum, value) => sum + value.total_safe_travel_minutes!, 0) : null;
  const missing = day?.missing_activity_ids.map(id => requestedDay?.activities.find(activity => activity.id === id)?.label ?? 'Занятие') ?? [];
  const remaining = requestedDay?.window && day?.ends_at != null ? Math.max(0, minutes(requestedDay.window.end) - day.ends_at) : null;
  const hasVisits = plan.days.some(value => value.visits.length);
  const routingUnavailable = plan.status === 'ERROR' && plan.issues?.includes('ROUTING_PROVIDER_UNAVAILABLE');
  const missingWishes = plan.days.some(value => value.missing_activity_ids.length > 0);
  const title = plan.status === 'AVAILABLE' ? 'План помещается в ваше время' : plan.status === 'LIMITED' ? missingWishes ? 'Получился частичный план' : 'План с оговорками' : plan.status === 'ERROR' ? 'Расчёт не завершён' : plan.status === 'NEEDS_INPUT' ? 'Нужно уточнить условия' : 'Подходящий план пока не найден';
  const status = day?.status === 'AVAILABLE' ? 'Готово' : day?.status === 'LIMITED' ? 'Частично' : 'Нет плана';
  const stamp = (value: string) => { const at = new Date(value); return Number.isFinite(at.getTime()) ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: draft.locality.timezone }).format(at) : 'не указано'; };
  if (expired && plan.status !== 'PLACES_FOUND') return <section className="result-section"><div className="result-notice"><Icon name="refresh" /><div><h2>Пора обновить маршрут</h2><p>Срок проверки мест и дороги истёк. Ваши условия сохранены.</p></div></div>
    <div className="result-actions"><Action stretched disabled={busy} onClick={retry}>Проверить заново</Action><Action variant="secondary" stretched disabled={busy} onClick={edit}>Изменить условия</Action></div></section>;
  if (plan.status === 'PLACES_FOUND') return <section className="result-section" aria-label="Результат подбора мест">
    {stalePlaces && <div className="notice" role="status"><p>Места найдены больше 30 минут назад. Перед выходом обновите подборку.</p></div>}
    <div className="route-receipt"><div className="result-notice" role="status"><Icon name="pin" /><div>
      <h2>Ваш план на день</h2><p>Места по порядку посещения. Переключитесь на карту, когда захотите увидеть их расположение.</p>
    </div></div></div>
    {view.capabilities.data_mode === 'test' && <p className="data-label">Учебный пример · синтетические места</p>}
    <CandidatePlaces view={view} mapsAvailable={mapsAvailable} />
    {!!plan.event_gaps?.length && <ul className="form-issues">{plan.event_gaps.map(gap =>
      <li key={`${gap.day_id}:${gap.activity_id}:${gap.code}`}>{eventGapText(gap.code)}</li>)}</ul>}
    <div className="result-actions"><Action stretched disabled={busy} onClick={share}>Поделиться условиями</Action>
      <Action variant="secondary" stretched disabled={busy} onClick={edit}>Изменить условия</Action>
      <Action variant="secondary" stretched disabled={busy} onClick={retry}>Обновить места</Action></div>
  </section>;
  return <section className={`result-section${hasVisits ? '' : ' result-section--empty'}`} aria-label="Результат расчёта">
    <div className={`route-receipt route-receipt--${plan.status.toLowerCase()}`}>
      <div className={`result-notice result-notice--${plan.status.toLowerCase()}`} role="status"><Icon name={plan.status === 'AVAILABLE' ? 'check' : 'alert'} />
        <div><h2>{title}</h2><p>{plan.status === 'AVAILABLE' ? 'Дорога и запас времени учтены.' : plan.status === 'LIMITED' ? missingWishes ? 'Часть пожеланий не вошла. Условия не менялись.' : 'Маршрут рассчитан. Ниже указано, какие сведения нужно проверить перед выходом.' : plan.status === 'UNAVAILABLE' ? unavailablePlanNotice(plan) : plan.issues?.map(humanError).join(' ') || 'Проверьте условия или повторите расчёт.'}</p></div></div>
      {stopCount > 0 && <dl className="route-metrics"><div><dt>{plan.days.length > 1 ? 'Всего остановок' : 'Остановок'}</dt><dd>{stopCount}</dd></div><div><dt>{plan.days.length > 1 ? 'Всего в пути с запасом' : 'В пути с запасом'}</dt><dd>{travel == null ? '—' : `${travel} мин`}</dd></div>
        <div><dt>{plan.days.length > 1 ? 'Расходы за все дни' : 'Расходы, ориентир'}</dt><dd>{money(plan.total_expected_cost_minor)}</dd></div></dl>}
    </div>
    {view.capabilities.data_mode === 'test' && <p className="data-label">Учебный пример · места и время в пути синтетические</p>}
    <CandidatePlaces view={view} mapsAvailable={mapsAvailable} />
    {plan.days.length > 1 && <nav className="day-tabs" aria-label="Дни маршрута">{plan.days.map(value => <button key={value.day_id} type="button" aria-pressed={day?.day_id === value.day_id}
      onClick={() => { setSelectedDay(value.day_id); setSelectedVisit(0); }}><strong>{date(value.date)}</strong><span>{value.status === 'AVAILABLE' ? 'Готово' : value.status === 'LIMITED' ? 'Частично' : 'Нет плана'}</span></button>)}</nav>}
    {day && <>{plan.days.length > 1 && <div className="day-heading"><h3>{date(day.date)}</h3><span>{requestedDay?.window ? `${requestedDay.window.start}–${requestedDay.window.end}` : status}</span></div>}
      {mapsAvailable && visits.length > 0 && <nav className="view-switch" aria-label="Отображение маршрута"><Action variant="ghost" aria-pressed={mode === 'plan'} onClick={() => setMode('plan')}><Icon name="list" />План</Action>
        <Action variant="ghost" aria-pressed={mode === 'map'} onClick={() => setMode('map')}><Icon name="map" />Карта</Action></nav>}
      {mode === 'map' && mapsAvailable ? <PlanMap day={day} origin={plan.origin ?? draft.points.origin} destination={draft.points.destination} activeVisitIndex={selectedVisit} onSelectVisit={setSelectedVisit} /> : <ol className="dayline">
        {visits.length > 0 && <li className="dayline-endpoint"><span className="dayline-dot" aria-hidden="true" /><time>{requestedDay?.window?.start ?? 'Старт'}</time><div><strong>Начало маршрута</strong><p>{(plan.origin ?? draft.points.origin)?.label ?? 'Выбранная точка'}</p></div></li>}
        {visits.map((visit, index) => {
          const previousEnd = index ? visits[index - 1]!.ends_at : requestedDay?.window ? minutes(requestedDay.window.start) : null;
          const wait = previousEnd == null ? 0 : Math.max(0, visit.starts_at - previousEnd - visit.travel_before_minutes - visit.arrival_buffer_minutes);
          const visitWarnings = visit.warnings.filter(code => code !== 'PRICE_UNKNOWN' && !(visit.event && ['EVENT_BOOKING_NOT_VERIFIED', 'EVENT_AGE_UNKNOWN', 'EVENT_VISIT_DURATION_ESTIMATED'].includes(code)));
          return <li className="dayline-stop" key={`${visit.activity_id}:${visit.place_id}`}>
            <div className="dayline-travel"><Icon name="walk" /><span>{modes[draft.shared.mobility?.[0] ?? 'walking'] ?? 'В пути'} · {visit.travel_before_minutes} мин{visit.distance_before_meters == null ? '' : ` · ${number.format(Math.round(visit.distance_before_meters / 100) / 10)} км`}</span></div>
            <div className="dayline-buffer">Запас перед посещением · {visit.arrival_buffer_minutes} мин{wait > 0 && <> · ожидание {wait} мин</>}</div>
            <TransitDetails transit={day.travel_segments?.find(segment => segment.to_id === visit.place_id)?.transit} />
            <article className="stop-card"><span className="stop-number" aria-label={`Остановка ${index + 1}`}>{index + 1}</span>
              <div className="stop-time"><time>{time(visit.starts_at)}–{time(visit.ends_at)}</time><span>{visit.ends_at - visit.starts_at} мин · {visit.event?.duration_basis === 'provider_session' ? 'официальный сеанс' : visit.event?.duration_basis === 'user_estimate' ? 'ваша оценка длительности' : 'расчётный визит'}</span></div>
              <div className="stop-content"><h4>{visit.name}</h4>{visit.location_label && <p className="stop-address">{visit.location_label}</p>}
                <p className="stop-price">{visit.event && visit.price_expected_minor === 0 ? 'Вход бесплатный по данным источника' : visit.price_expected_minor == null ? 'Стоимость не указана' : `${money(visit.price_expected_minor)} · ориентир`}</p>
                {visit.event && <div className="event-result-details"><p>{visit.event.minimum_age == null ? 'Возрастное ограничение неизвестно' : `Возрастное ограничение: ${visit.event.minimum_age}+`}</p>
                  {visit.event.official_start_utc != null && visit.event.official_end_utc != null && <p>По источнику: {eventWindowText({ start_utc: visit.event.official_start_utc, end_utc: visit.event.official_end_utc }, draft.locality.timezone)}</p>}
                  <p>Наличие билетов и регистрация не проверены. Уточните условия на странице события.</p></div>}
                {visitWarnings.length > 0 && <ul className="stop-warnings">{[...new Set(visitWarnings.map(warningText))].map(text => <li key={text}>{text}</li>)}</ul>}
              </div>
              <footer className="stop-footer"><div className="stop-source">{visit.source ? <><span>{visit.source.data_mode === 'test' ? 'Учебный набор' : visit.source.data_mode === 'prepared' ? 'Подготовленные данные' : visit.source.provider === '2gis' ? '2ГИС' : visit.source.provider === 'kudago' ? 'KudaGo' : visit.source.provider}</span>
                {visit.source.provider === '2gis' && visit.source.url?.startsWith('https://2gis.ru/') && <a href={visit.source.url} target="_blank" rel="noopener noreferrer">О месте ↗</a>}
                {visit.source.provider === 'kudago' && eventSourceUrl(visit.source.url) && <a href={eventSourceUrl(visit.source.url)} target="_blank" rel="noopener noreferrer">О событии ↗</a>}
                <small>Получено {stamp(visit.source.fetched_at)}{visit.source.data_mode === 'live' && new Date(visit.source.valid_until).getTime() <= Date.now() ? ' · срок проверки истёк' : ''}</small></> : <span>Источник не указан</span>}</div>
              <div className="stop-actions"><Action variant="ghost" disabled={busy} onClick={() => visit.event ? chooseEvent({ day_id: day.day_id, replace_activity_id: visit.activity_id }) : replace({ day_id: day.day_id, activity_id: visit.activity_id, place_id: visit.place_id })} iconBefore={<Icon name="refresh" />}>{visit.event ? 'Другое событие' : 'Заменить'}</Action></div></footer>
            </article>
          </li>;
        })}
        {visits.length > 0 && day.ends_at != null && <li className="dayline-endpoint dayline-endpoint--finish"><span className="dayline-dot" aria-hidden="true" /><time>{time(day.ends_at)}</time><div>
          <strong>{draft.points.destination ? 'Прибытие к финишу' : 'Завершение плана'}</strong><p>{draft.points.destination?.label ?? 'У последней остановки'}{day.ends_at > visits.at(-1)!.ends_at && <> · дорога {day.ends_at - visits.at(-1)!.ends_at} мин</>}</p><TransitDetails transit={day.travel_segments?.find(segment => segment.to_id === '@destination')?.transit} /></div></li>}
        {hasVisits && missing.length > 0 && <li className="dayline-gap"><span className="dayline-dot" aria-hidden="true" /><div><h4>Не удалось включить</h4><p>{missing.join(' · ')}</p>
          {remaining != null && remaining > 0 && <small>До конца вашего окна остаётся {remaining} мин. Подходящие занятия на это время не подтверждены.</small>}</div></li>}
      </ol>}
    </>}
    {!!plan.event_gaps?.length && <ul className="form-issues" aria-label="Почему не вошли события">{plan.event_gaps.filter(gap => !day || gap.day_id === day.day_id).map(gap => {
      const eventDay = draft.days.find(value => value.day_id === gap.day_id);
      const activity = eventDay?.activities.find(value => value.id === gap.activity_id);
      return activity ? <li key={`${gap.day_id}:${gap.activity_id}:${gap.code}`}><strong>{!day && eventDay ? `${date(eventDay.date)} · ` : ''}{activity.label}.</strong> {eventGapText(gap.code)}</li> : null;
    })}</ul>}
    {!!plan.issues?.length && hasVisits && <ul className="form-issues">{plan.issues.map(issue => <li key={issue}>{humanError(issue)}</li>)}</ul>}
    <div className="result-actions">{hasVisits && <Action stretched disabled={busy} onClick={share}>Поделиться</Action>}
      {routingUnavailable && <Action stretched disabled={busy} onClick={retry} iconBefore={<Icon name="refresh" />}>Повторить расчёт</Action>}
      <Action variant={hasVisits || routingUnavailable ? 'secondary' : 'primary'} stretched disabled={busy} onClick={edit} iconBefore={<Icon name="filters" />}>Изменить условия</Action></div>
    {!routingUnavailable && <div className="result-secondary"><Action variant="ghost" stretched disabled={busy} onClick={retry} iconBefore={<Icon name="refresh" />}>Проверить заново</Action></div>}
  </section>;
}
