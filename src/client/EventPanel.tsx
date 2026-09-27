import { useState } from 'react';
import type { EventCard } from '../shared/event-catalog';
import type { EventSearchPreview, EventAvailabilityPreview, SelectEventInput } from '../shared/event-selection';
import type { PlanningView } from '../shared/planning-form';
import { Action, Icon, useExpired } from './PlannerUi';
import { eventFactDeadline, EventChoiceFacts, EventPriceAge, EventSource } from './EventFacts';

export type EventPanelTarget = { day_id: string; replace_activity_id?: string };
export type EventSelection = Omit<SelectEventInput, 'base_version' | 'event_id'>;
function Card({ card, timezone, disabled, open }: { card: EventCard; timezone: string; disabled: boolean; open: () => void }) {
  const expired = useExpired(eventFactDeadline(card));
  if (expired) return <li className="event-card"><p>Срок данных одного события истёк. Обновите афишу.</p></li>;
  return <li className="event-card"><h3>{card.title}</h3>{card.venue?.name && <p>{card.venue.name}</p>}{card.venue?.address && <p className="event-address">{card.venue.address}</p>}
    <EventPriceAge price={card.price} age={card.age} /><EventSource source={card.source} timezone={timezone} />
    <p className="field-hint">Сеансы, доступность и возможность включить событие в маршрут проверим отдельно.</p>
    <Action variant="secondary" stretched disabled={disabled} onClick={open}>Проверить сеансы</Action></li>;
}
export function EventPanel({ view, target, search, availability, select, refresh, pending }: {
  view: PlanningView; target?: EventPanelTarget;
  search: (dayId: string) => Promise<EventSearchPreview>;
  availability: (value: { search_id: string; choice_id: string }) => Promise<EventAvailabilityPreview>;
  select: (value: EventSelection) => Promise<void>; refresh: () => Promise<void>;
  pending: (value: boolean) => void;
}) {
  const [dayId, setDayId] = useState(target?.day_id ?? view.draft.days[0]!.day_id);
  const [replace, setReplace] = useState(target?.replace_activity_id ?? '');
  const [results, setResults] = useState<EventSearchPreview | null>(null), [details, setDetails] = useState<EventAvailabilityPreview | null>(null);
  const [selected, setSelected] = useState(''), [duration, setDuration] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [stale, setStale] = useState(false);
  const resultsExpired = useExpired(results?.expires_at), detailsExpired = useExpired(details?.expires_at);
  const day = view.draft.days.find(value => value.day_id === dayId)!;
  const option = details?.choices.find(value => value.occurrence_choice_id === selected);
  const choiceExpired = useExpired(option ? eventFactDeadline(option.choice) : undefined);
  const timezone = view.draft.locality.timezone;
  async function run(label: string, work: () => Promise<void>) {
    if (busy) return; setBusy(label); pending(true); setError(''); setStale(false);
    try { await work(); } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось проверить событие. Попробуйте ещё раз.');
      setStale(cause instanceof Error && 'code' in cause && ['EVENT_PREVIEW_STALE', 'STALE_VERSION', 'DRAFT_EXPIRED'].includes(String(cause.code)));
    } finally { setBusy(''); pending(false); }
  }
  function clear() { setResults(null); setDetails(null); setSelected(''); setDuration(''); setError(''); setStale(false); }
  const date = (value: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
  const invalidDuration = option?.choice.duration_required && (!/^\d+$/u.test(duration) || Number(duration) < 5 || Number(duration) > 720);
  return <section className="event-panel" aria-label="Выбор события"><p className="field-hint">Афиша KudaGo для {view.draft.locality.name}. Выбор события ещё не подтверждает, что весь маршрут выполним.</p>
    <label>День маршрута<select value={dayId} disabled={!!busy} onChange={event => { setDayId(event.target.value); setReplace(''); clear(); }}>
      {view.draft.days.map(value => <option key={value.day_id} value={value.day_id}>{date(value.date)}{value.window ? ` · ${value.window.start}–${value.window.end}` : ''}</option>)}</select></label>
    <Action stretched variant={results ? 'secondary' : 'primary'} disabled={!!busy} onClick={() => void run('Получаем афишу…', async () => { clear(); setResults(await search(dayId)); })} iconBefore={<Icon name="calendar" />}>{results ? 'Обновить афишу' : 'Посмотреть события'}</Action>
    {busy && <p role="status" className="field-hint">{busy}</p>}{error && <p className="notice notice--error" role="alert">{error}</p>}
    {stale && <Action variant="secondary" disabled={!!busy} onClick={() => void run('Обновляем условия…', refresh)}>Открыть актуальные условия</Action>}
    {resultsExpired || detailsExpired ? <div className="notice"><p>Срок проверки афиши истёк. Обновите её перед выбором.</p></div> : results && <>
      <p className="event-coverage">{results.coverage === 'UNSUPPORTED_LOCALITY' ? 'Для этого города пока нет подключённой афиши. Другие занятия в плане остаются доступны.' : results.coverage === 'PARTIAL' ? 'Показана часть доступной афиши. Поиск ограничен; отсутствие события в списке не означает, что его нет.' : 'Это ограниченная подборка одного источника для выбранного дня, не вся афиша города.'}</p>
      {!details ? <>{!results.cards.length && results.coverage !== 'UNSUPPORTED_LOCALITY' && <p>В этой подборке событий нет. Можно повторить поиск или выбрать другой день.</p>}
        <ul className="event-cards">{results.cards.map(value => <Card key={value.choice_id} card={value.card} timezone={timezone} disabled={!!busy} open={() => void run('Проверяем событие и площадку…', async () => {
          setSelected(''); setDuration(''); setDetails(await availability({ search_id: results.search_id, choice_id: value.choice_id }));
        })} />)}</ul></> : <><Action variant="ghost" disabled={!!busy} onClick={() => { setDetails(null); setSelected(''); setDuration(''); }}>К списку событий</Action>
        {details.status !== 'READY' && <p className="notice">{details.choices.length ? 'Часть сеансов или расписаний не удалось подтвердить. Можно выбрать только проверенный вариант ниже.' : 'На этот день нет подтверждённого варианта посещения. Событие не добавлено.'}</p>}
        {details.unresolved.length > 0 && <p className="field-hint">Для {details.unresolved.length} вариантов не хватает подтверждённых данных о времени, месте или доступности.</p>}
        <form onSubmit={event => { event.preventDefault(); if (!option || invalidDuration || choiceExpired) return; void run('Сохраняем выбранное событие…', () => select({ search_id: details.search_id, occurrence_choice_id: selected, day_id: dayId,
          ...(replace ? { replace_activity_id: replace } : {}), ...(option.choice.duration_required ? { visit_duration_minutes: Number(duration) } : {}) })); }}>
          <fieldset disabled={!!busy}><legend>Выберите вариант посещения</legend>
            {details.choices.map(value => <EventOption key={value.occurrence_choice_id} value={value} timezone={timezone} selected={selected === value.occurrence_choice_id} choose={() => { setSelected(value.occurrence_choice_id); setDuration(''); }} />)}
          </fieldset>
          {option && !choiceExpired && <><label>Как включить в план<select disabled={!!busy} value={replace} onChange={event => setReplace(event.target.value)}><option value="">Добавить отдельным занятием</option>
            {day.activities.map(activity => <option key={activity.id} value={activity.id}>Вместо: {activity.label}</option>)}</select></label>
            <p className="field-hint">{replace ? 'Заменится только выбранное занятие. Его обязательные требования и связи порядка сохраняются; остальные пожелания останутся.' : 'Остальные пожелания сохранятся. После добавления проверьте порядок в условиях плана.'}</p>
            {option.choice.duration_required && <label>Сколько минут отвести на посещение<input type="number" required min="5" max="720" step="1" value={duration} disabled={!!busy} onChange={event => setDuration(event.target.value)} placeholder="Введите свою оценку" /><span className="field-hint">От 5 до 720 минут. Это ваша оценка, а не официальная длительность.</span></label>}
            <p className="field-hint">Возможность успеть, дорогу, бюджет и остальные ограничения проверим при расчёте. Покупка билетов и регистрация здесь недоступны.</p>
            <Action type="submit" stretched disabled={!!busy || !!invalidDuration}>{replace ? 'Заменить выбранное занятие' : 'Добавить событие в план'}</Action></>}
          {choiceExpired && <p className="notice">Срок этого варианта истёк. Обновите афишу.</p>}
        </form></>}
    </>}
  </section>;
}
function EventOption({ value, timezone, selected, choose }: { value: EventAvailabilityPreview['choices'][number]; timezone: string; selected: boolean; choose: () => void }) {
  const expired = useExpired(eventFactDeadline(value.choice));
  if (expired) return <p className="field-hint">Срок одного варианта истёк. Обновите афишу.</p>;
  return <div className={`event-option ${selected ? 'event-option--selected' : ''}`}><label className="checkbox-label"><input type="radio" name="event-occurrence" checked={selected} onChange={choose} />
    {value.choice.schedule.kind === 'fixed' ? 'Выбрать этот сеанс' : 'Выбрать эти часы посещения'}</label><EventChoiceFacts choice={value.choice} timezone={timezone} /></div>;
}
