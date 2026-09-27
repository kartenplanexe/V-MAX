import type { EventAvailabilityChoice, SelectedEventDisplay } from '../shared/event-selection';
import type { EventCard } from '../shared/event-catalog';
import type { PlanningView } from '../shared/planning-form';
import { Action, useExpired } from './PlannerUi';

type Source = EventCard['source'];
export function eventFactDeadline(value: { source: Source; venue_source?: Source }): string {
  const times = [value.source, ...(value.venue_source ? [value.venue_source] : [])]
    .flatMap(source => [Date.parse(source.valid_until), Date.parse(source.fetched_at) + 300_000]);
  return new Date(times.every(Number.isFinite) ? Math.min(...times) : 0).toISOString();
}
export function eventSourceUrl(value: string | null | undefined): string | undefined {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && url.hostname === 'kudago.com' && !url.username && !url.password && !url.port ? url.href : undefined; }
  catch { return undefined; }
}
export function eventWindowText(window: { start_utc: number; end_utc: number }, timezone: string) {
  const format = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone });
  return `${format.format(new Date(window.start_utc * 1000))} — ${format.format(new Date(window.end_utc * 1000))}`;
}
export function selectedEventDisplay(view: PlanningView, dayId: string, activityId: string): SelectedEventDisplay | undefined {
  const day = view.draft.days.find(value => value.day_id === dayId), activity = day?.activities.find(value => value.id === activityId);
  const display = view.event_previews?.[JSON.stringify([dayId, activityId])];
  return activity?.intent_kind === 'event_visit' && display && display.date === day?.date &&
    activity.target.event_id === display.event_ref.event_id && activity.target.occurrence_key === display.event_ref.occurrence_key &&
    Date.parse(eventFactDeadline(display)) > Date.now() ? display : undefined;
}
export function EventPriceAge({ price, age }: Pick<EventCard, 'price' | 'age'>) {
  return <div className="event-price-age"><p>{price.kind === 'free' && price.strict_eligible ? 'Вход бесплатный по данным источника' : price.kind === 'conflict' ? 'Сведения о цене противоречивы' : price.display || 'Цена не указана'}</p>
    {price.kind !== 'free' && <p className="field-hint">Подтверждённая верхняя стоимость неизвестна. Наличие билетов и запись не проверены.</p>}
    <p>{age.state === 'known' && age.minimum != null ? `Возрастное ограничение: ${age.minimum}+` : 'Возрастное ограничение неизвестно'}</p></div>;
}
export function EventSource({ source, timezone }: { source: Source; timezone: string }) {
  const link = eventSourceUrl(source.url), fetched = new Date(source.fetched_at);
  return <div className="event-source">{source.data_mode === 'test' && <span>Учебное событие</span>}{link && <a href={link} target="_blank" rel="noopener noreferrer">Источник: KudaGo ↗</a>}
    <small>Проверено {new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(fetched)}</small></div>;
}
export function EventChoiceFacts({ choice, timezone }: { choice: EventAvailabilityChoice | SelectedEventDisplay; timezone: string }) {
  return <div className="event-choice-facts"><h4>{choice.title}</h4>{choice.venue_name && <p>{choice.venue_name}</p>}{choice.location_label && <p className="event-address">{choice.location_label}</p>}
    <p className="event-schedule-label">{choice.schedule.kind === 'fixed' ? 'Официальный сеанс — целиком' : 'Доступные часы посещения'}</p>
    <ul className="event-windows">{choice.schedule.windows_utc.map((window, index) => <li key={index}>{eventWindowText(window, timezone)}</li>)}</ul>
    <EventPriceAge price={choice.price} age={choice.age} /><EventSource source={choice.source} timezone={timezone} /></div>;
}
export function SelectedEventItem({ view, dayId, activityId, busy, recheck, chooseOther, remove }: {
  view: PlanningView; dayId: string; activityId: string; busy: boolean;
  recheck: () => void; chooseOther: () => void; remove: () => void;
}) {
  const raw = view.event_previews?.[JSON.stringify([dayId, activityId])];
  const expired = useExpired(raw ? eventFactDeadline(raw) : undefined);
  const display = !expired ? selectedEventDisplay(view, dayId, activityId) : undefined;
  return <article className="selected-event"><span className="summary-label">Событие в вашем плане</span>
    {display ? <><EventChoiceFacts choice={display} timezone={view.draft.locality.timezone} />
      <p className="field-hint">{display.duration.basis === 'provider_session' ? `Весь сеанс · ${display.duration.minutes} мин` : `На посещение вы отвели ${display.duration.minutes} мин. Это ваша оценка длительности.`}</p></> :
      <><h4>Сохранённый выбор события</h4><p>Данные сеанса нужно проверить заново. Ваш выбор сохранён; название, адрес и расписание пока не показываем.</p></>}
    <div className="event-actions">{!display && <Action variant="secondary" disabled={busy} onClick={recheck}>Перепроверить событие</Action>}
      <Action variant="ghost" disabled={busy} onClick={chooseOther}>Выбрать другое</Action><Action variant="ghost" disabled={busy} onClick={remove}>Убрать из плана</Action></div>
  </article>;
}
