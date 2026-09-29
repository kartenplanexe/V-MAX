import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import type { PlanningView } from '../shared/planning-form';
import { DEFAULT_SEARCH_RADIUS_METERS, MIN_SEARCH_RADIUS_METERS, MAX_SEARCH_RADIUS_METERS } from '../shared/search-radius';
import { AddressPicker, type AddressChoice } from './AddressPicker';
import { PointPicker } from './PointPicker';
import { Action, Icon } from './PlannerUi';
import { SelectedEventItem } from './EventFacts';
import type { EventPanelTarget } from './EventPanel';
import type { ManualChoices } from '../shared/manual-planning';
import type { ActivityChoice } from '../shared/activity-choice';
import { orderWithoutActivity } from '../shared/activity-order';
import { ActivityPicker } from './ActivityPicker';

type Draft = PlanningView['draft'];
const modes: Record<string, string> = { walking: 'Пешком', driving: 'На машине', cycling: 'На велосипеде', public_transport: 'Общественным транспортом' };
const dateLabel = (value: string) => Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : 'Выберите дату';
export type ConditionSectionId = 'time' | 'people' | 'budget' | 'points' | 'activities' | 'events';
function ConditionSection({ title, summary, icon, open, toggle, children, sectionId }: { title: string; summary: string; sectionId: ConditionSectionId;
  icon: ComponentProps<typeof Icon>['name']; open: boolean; toggle: () => void; children: ReactNode }) {
  return <details className="conditions-section" data-section={sectionId} open={open}>
    <summary onClick={event => { event.preventDefault(); toggle(); }}><span className="condition-symbol"><Icon name={icon} /></span>
      <span className="condition-description"><h3>{title}</h3><span>{summary}</span></span><Icon name="chevron" /></summary>
    <div className="conditions-content">{children}</div>
  </details>;
}
export function ConditionsPanel({ draft, view, busy, dirty, mapsAvailable, patch, searchAddress, locate, save, cancel, browseEvents, recheckEvent, loadActivities, initialSection }: {
  draft: Draft; view: PlanningView; busy: boolean; dirty: boolean; mapsAvailable: boolean;
  patch: (edit: (draft: Draft) => void) => void; searchAddress: (query: string) => Promise<AddressChoice[]>;
  locate: () => void; save: () => void; cancel: () => void;
  browseEvents: (target?: EventPanelTarget) => void; recheckEvent: (dayId: string, activityId: string) => void;
  loadActivities: () => Promise<ManualChoices>;
  initialSection?: ConditionSectionId | null;
}) {
  const [pointEditor, setPointEditor] = useState<{ field: 'origin' | 'destination'; mode: 'address' | 'map' } | null>(null);
  const [expanded, setExpanded] = useState<ConditionSectionId | null>(() => {
    if (initialSection) return initialSection;
    const issue = view.issues[0];
    return issue?.code === 'ACTIVITIES_REQUIRED' ? 'activities' : issue?.code === 'EVENT_RECHECK_REQUIRED' ? 'events'
      : issue?.field.startsWith('points.') ? 'points' : issue?.field.includes('budget') ? 'budget'
      : issue?.field.includes('mobility') || issue?.field.includes('party') ? 'people'
      : issue?.field.includes('window') || issue?.field.includes('date') ? 'time' : null;
  });
  const section = (id: ConditionSectionId) => ({ sectionId: id, open: expanded === id, toggle: () => setExpanded(value => value === id ? null : id) });
  const validationPending = useRef(false), showingValidity = useRef(false);
  const count = draft.days.reduce((sum, day) => sum + day.activities.length, 0);
  const eventCount = draft.days.reduce((sum, day) => sum + day.activities.filter(a => a.intent_kind === 'event_visit').length, 0);
  const budget = draft.shared.budget;
  const radius = draft.shared.search_radius_meters ?? DEFAULT_SEARCH_RADIUS_METERS;
  function move(dayIndex: number, index: number, direction: number) {
    patch(value => { const day = value.days[dayIndex]!, target = index + direction;
      if (target < 0 || target >= day.activities.length) return;
      const [activity] = day.activities.splice(index, 1); day.activities.splice(target, 0, activity!);
      day.order = day.activities.slice(1).map((activity, i) => [day.activities[i]!.id, activity.id]); });
  }
  function remove(dayIndex: number, id: string) { patch(value => {
    const day = value.days[dayIndex]!; day.activities = day.activities.filter(a => a.id !== id); day.order = orderWithoutActivity(day.order, id);
  }); }
  function add(dayIndex: number, choice: ActivityChoice, options: ManualChoices) {
    const id = crypto.randomUUID(), selected = choice.kind === 'place' ? options.categories.filter(c => choice.category_ids.includes(c.id)) : [];
    patch(value => {
      const day = value.days[dayIndex]!;
      if (day.order.length) {
        const terminal = day.activities.filter(a => !day.order.some(edge => edge[0] === a.id));
        day.order.push(...terminal.map(a => [a.id, id] as [string, string]));
      }
      day.activities.push({ id, label: choice.kind === 'walk' ? 'Прогулка по городу' : selected.map(c => c.name).join(' / '),
        intent_kind: choice.kind === 'walk' ? 'route_walk' : 'place_visit', requirements: [],
        selection: { category_policy: choice.kind === 'walk' ? 'related_allowed' : 'named_types_only', named_types: selected.map(c => c.name) },
        categories: { state: 'matched', include_any: selected.map(c => c.id), exclude: [], region_id: value.locality.region_id, catalog_version: options.catalog_version } });
    });
  }
  return <form className="conditions-form" onSubmit={event => { event.preventDefault(); save(); }} onInvalidCapture={event => {
    if (showingValidity.current) return;
    event.preventDefault();
    if (validationPending.current) return;
    const field = event.currentTarget.querySelector<HTMLInputElement | HTMLSelectElement>('input:invalid, select:invalid, textarea:invalid');
    const target = field?.closest<HTMLElement>('[data-section]');
    if (!field || !target) return;
    setExpanded(target.dataset.section as ConditionSectionId); validationPending.current = true;
    // Native form validation cannot focus a field in a collapsed details element.
    // Reveal its section first, then retain the browser's real validity feedback.
    requestAnimationFrame(() => { validationPending.current = false; if (!field.isConnected) return;
      field.focus(); showingValidity.current = true;
      try { field.reportValidity(); } finally { showingValidity.current = false; }
    });
  }}>
    <fieldset disabled={busy} className="conditions-scroll">
      <h3 className="conditions-group-title">Время, место и ограничения</h3><div className="conditions-group">
      <ConditionSection title="Дата и время" icon="calendar" {...section('time')} summary={draft.days.length > 1 ? `${draft.days.length} дня · отдельные окна` : `${dateLabel(draft.days[0]!.date)} · ${draft.days[0]!.window ? `${draft.days[0]!.window!.start}–${draft.days[0]!.window!.end}` : 'Время не задано'}`}>
        {draft.days.map((day, index) => <div className="day-fields" key={day.day_id}>
          {draft.days.length > 1 && <h4>День {index + 1}</h4>}
          <div className="field-row field-row--time">
            <label>Дата<input aria-label={`Дата дня ${index + 1}`} type="date" required value={day.date} onChange={event => patch(value => { value.days[index]!.date = event.target.value; })} /></label>
            <label>Начало<input aria-label={`Начало дня ${index + 1}`} inputMode="numeric" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" placeholder="14:00" required value={day.window?.start ?? ''}
              onChange={event => patch(value => { value.days[index]!.window = { start: event.target.value, end: day.window?.end ?? '' }; })} /></label>
            <label>Окончание<input aria-label={`Окончание дня ${index + 1}`} inputMode="numeric" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00" placeholder="18:00" required value={day.window?.end ?? ''}
              onChange={event => patch(value => { value.days[index]!.window = { start: day.window?.start ?? '', end: event.target.value }; })} /></label>
          </div>
          {Object.entries(view.provenance).some(([path, source]) => path.startsWith(`days.${day.day_id}.`) && source.includes('suggested')) &&
            <p className="field-hint">Дата или время предложены по вашему запросу. Проверьте их перед расчётом.</p>}
        </div>)}
      </ConditionSection>
      <ConditionSection title="Передвижение и участники" icon="walk" {...section('people')} summary={`${modes[draft.shared.mobility?.[0] ?? ''] ?? 'Выберите способ'}${draft.shared.party?.total ? ` · участников: ${draft.shared.party.total}` : ''}`}>
        <div className="field-row"><label>Передвижение<select value={draft.shared.mobility?.[0] ?? ''} onChange={event => patch(value => { value.shared.mobility = [event.target.value]; })}>
          <option value="" disabled>Выберите способ</option>{view.capabilities.modes.map(mode => <option key={mode} value={mode}>{modes[mode] ?? mode}</option>)}</select></label>
          <label>Участников<input type="number" min={Math.max(1, draft.shared.party?.child_ages?.length ?? 0)} max="100" required={!!draft.shared.party?.child_ages?.length} placeholder="Не указано" value={draft.shared.party?.total ?? ''} onChange={event => patch(value => {
            if (event.target.value) value.shared.party = { ...value.shared.party, total: Number(event.target.value) }; else if (value.shared.party) delete value.shared.party.total;
          })} /></label></div>
        <label>Дети в группе<select value={draft.shared.party?.child_ages === undefined ? 'unknown' : draft.shared.party.child_ages.length ? 'children' : 'none'} onChange={event => patch(value => {
          value.shared.party ??= {};
          if (event.target.value === 'unknown') delete value.shared.party.child_ages;
          else value.shared.party.child_ages = event.target.value === 'none' ? [] : [Number.NaN];
        })}><option value="unknown">Не указано</option><option value="none">Без детей</option><option value="children">С детьми</option></select></label>
        {!!draft.shared.party?.child_ages?.length && <div className="child-age-fields">
          <p className="field-hint">Укажите возраст каждого ребёнка на день прогулки. Он нужен для проверки возрастных ограничений событий.</p>
          {draft.shared.party.child_ages.map((age, index) => <div className="child-age-row" key={index}>
            <label>Ребёнок {index + 1}, лет<input type="number" min="0" max="17" step="1" required value={Number.isFinite(age) ? age : ''}
              onChange={event => patch(value => { value.shared.party!.child_ages![index] = event.target.value === '' ? Number.NaN : Number(event.target.value); })} /></label>
            <Action variant="ghost" onClick={() => patch(value => { value.shared.party!.child_ages!.splice(index, 1); })}>Убрать</Action>
          </div>)}
          <Action variant="secondary" disabled={draft.shared.party.child_ages.length >= 99} onClick={() => patch(value => { value.shared.party!.child_ages!.push(Number.NaN); })}>Добавить ребёнка</Action>
        </div>}
      </ConditionSection>
      <ConditionSection title="Бюджет" icon="wallet" {...section('budget')} summary={budget?.kind === 'limit' ? `${budget.enforcement === 'estimated' ? 'Ориентир' : 'Лимит'}: ${new Intl.NumberFormat('ru-RU').format(budget.amount_rub)} ₽` : budget?.kind === 'unlimited' ? 'Без ограничения' : 'Не указан'}>
        <label>Ограничение расходов<select value={draft.shared.budget?.kind ?? 'unspecified'} onChange={event => patch(value => {
          value.shared.budget = event.target.value === 'limit' ? { kind: 'limit', amount_rub: 3000, basis: 'whole_party', period: 'per_day' } : { kind: event.target.value as 'unspecified' | 'unlimited' };
        })}><option value="unspecified">Не указан</option><option value="unlimited">Без ограничения</option><option value="limit">Указать лимит</option></select></label>
        {draft.shared.budget?.kind === 'limit' && <div className="budget-fields">
          <label className="full-field">Как считать<select value={draft.shared.budget.enforcement ?? 'strict'} onChange={event => patch(value => {
            if (value.shared.budget?.kind !== 'limit') return;
            value.shared.budget.enforcement = event.target.value as 'strict' | 'estimated';
            if (event.target.value === 'estimated') value.shared.budget.price_basis_assumption = 'per_person'; else delete value.shared.budget.price_basis_assumption;
          })}><option value="strict">Строгий лимит по подтверждённым ценам</option><option value="estimated">Ориентир по среднему чеку на человека</option></select></label>
          <label>Сумма, ₽<input type="number" min="0" max="100000000" step="100" required value={Number.isFinite(draft.shared.budget.amount_rub) ? draft.shared.budget.amount_rub : ''} onChange={event => patch(value => { if (value.shared.budget?.kind === 'limit') value.shared.budget.amount_rub = event.target.value === '' ? Number.NaN : Number(event.target.value); })} /></label>
          <label>Для кого<select value={draft.shared.budget.basis} onChange={event => patch(value => { if (value.shared.budget?.kind === 'limit') value.shared.budget.basis = event.target.value as 'whole_party' | 'per_person'; })}>
            <option value="unknown" disabled>Уточните</option><option value="whole_party">На всех</option><option value="per_person">На человека</option></select></label>
          <label>Период<select value={draft.shared.budget.period} onChange={event => patch(value => { if (value.shared.budget?.kind === 'limit') value.shared.budget.period = event.target.value as 'per_day' | 'whole_trip'; })}>
            <option value="unknown" disabled>Уточните</option><option value="per_day">На день</option><option value="whole_trip">На весь план</option></select></label>
          <p className="field-hint full-field">{draft.shared.budget.enforcement === 'estimated' ? 'Средний чек считаем на каждого участника. Фактические расходы могут превысить ориентир.' : 'Включим только места, для которых можно проверить верхнюю границу расходов.'}</p>
        </div>}
      </ConditionSection>
      <ConditionSection title="Старт и финиш" icon="pin" {...section('points')} summary={draft.points.origin?.label ?? 'Выберите точку старта'}>
        <label>Радиус от старта, км<input type="number" min={MIN_SEARCH_RADIUS_METERS / 1000} max={MAX_SEARCH_RADIUS_METERS / 1000} step="0.001" required value={Number.isFinite(radius) ? radius / 1000 : ''}
          onChange={event => patch(value => { value.shared.search_radius_meters = event.target.value === '' ? Number.NaN : Math.round(Number(event.target.value) * 1000); })} /></label>
        <p className="field-hint">Подбираем места и включаем события в этой области. Это не длина прогулки. Время в пути и все остальные условия проверим отдельно.</p>
        <p className="selected-point"><span>Начало маршрута</span><strong>{draft.points.origin?.label ?? 'Точка не выбрана'}</strong></p>
        <div className="point-actions"><Action variant="secondary" onClick={locate}>Моё местоположение</Action>
          <Action variant="secondary" onClick={() => setPointEditor({ field: 'origin', mode: 'address' })}>Указать адрес</Action>
          {mapsAvailable && <Action variant="ghost" onClick={() => setPointEditor({ field: 'origin', mode: 'map' })}>На карте</Action>}</div>
        <p className="selected-point"><span>Финиш</span><strong>{draft.points.destination?.label ?? (draft.shared.destination_text ? 'Нужно выбрать точку' : 'Последняя остановка маршрута')}</strong></p>
        <div className="point-actions"><Action variant="secondary" disabled={!draft.points.origin} onClick={() => patch(value => { value.points.destination = structuredClone(value.points.origin); })}>Вернуться к старту</Action>
          <Action variant="secondary" onClick={() => setPointEditor({ field: 'destination', mode: 'address' })}>Другой адрес</Action>
          {Boolean(draft.points.destination || draft.shared.destination_text) && <Action variant="ghost" onClick={() => patch(value => { delete value.points.destination; delete value.shared.destination_text; })}>Без заданного финиша</Action>}</div>
        {pointEditor?.mode === 'address' && <AddressPicker embedded city={draft.locality.name} search={searchAddress} disabled={busy} onClose={() => setPointEditor(null)} onSelect={choice => {
          patch(value => { value.points[pointEditor.field] = { ...choice.point, locality_id: value.locality.id, label: choice.label, source: 'place_choice' }; }); setPointEditor(null);
        }} />}
        {pointEditor?.mode === 'map' && (draft.points.origin || view.capabilities.map_center) && <PointPicker center={draft.points.origin ?? view.capabilities.map_center!} onClose={() => setPointEditor(null)} onSelect={point => {
          patch(value => { value.points[pointEditor.field] = { ...point, locality_id: value.locality.id, label: 'Выбранная точка', source: 'user_map' }; }); setPointEditor(null);
        }} />}
      </ConditionSection></div>
      <h3 className="conditions-group-title">Занятия и пожелания</h3><div className="conditions-group">
      <ConditionSection title="Занятия и порядок" icon="route" {...section('activities')} summary={count ? `В плане: ${count}${draft.days.some(day => day.order.length) ? ' · задан порядок' : ' · порядок свободный'}` : 'Выберите, чем заняться'}>
        {draft.days.map((day, dayIndex) => <div key={day.day_id}>{draft.days.length > 1 && <h4>День {dayIndex + 1}</h4>}
          <ol className="activity-editor">{day.activities.map((activity, index) => <li key={activity.id}>
            <span><strong>{activity.label}</strong>{activity.intent_kind !== 'event_visit' && activity.selection.category_policy === 'named_types_only' && <small>Только: {activity.selection.named_types.join(', ')}</small>}
              {activity.intent_kind !== 'event_visit' && <label>Минут на одно место<input type="number" min="1" max="1440" step="1" placeholder="Оценка приложения" value={activity.duration_minutes ?? ''}
                onChange={event => patch(value => { const target = value.days[dayIndex]!.activities[index]!;
                  if (target.intent_kind !== 'event_visit') { if (!event.target.value) delete target.duration_minutes; else target.duration_minutes = Number(event.target.value); } })} /></label>}
              {activity.requirements.map((requirement, i) => <label key={i}>{requirement.text}
                {activity.intent_kind === 'event_visit' ? <small>{requirement.strength === 'required' ? 'Обязательно' : 'Желательно'}</small> : <select value={requirement.strength}
                  onChange={event => patch(value => { const requirements = value.days[dayIndex]!.activities[index]!.requirements;
                    if (event.target.value === 'remove') requirements.splice(i, 1); else requirements[i]!.strength = event.target.value as 'required' | 'preferred'; })}>
                  <option value="required">Обязательно</option><option value="preferred">Желательно</option><option value="remove">Не учитывать</option></select>}</label>)}</span>
            <div className="order-actions">{day.activities.length > 1 && <><Action variant="ghost" className="icon-action" disabled={index === 0} aria-label={`Передвинуть «${activity.label}» раньше`} onClick={() => move(dayIndex, index, -1)}>↑</Action>
              <Action variant="ghost" className="icon-action" disabled={index === day.activities.length - 1} aria-label={`Передвинуть «${activity.label}» позже`} onClick={() => move(dayIndex, index, 1)}>↓</Action></>}
              <Action variant="ghost" className="icon-action" aria-label={`Убрать занятие «${activity.label}»`} onClick={() => remove(dayIndex, activity.id)}><Icon name="close" /></Action></div>
          </li>)}</ol>
          {!day.activities.length && <p className="field-hint">Добавьте занятие или событие, чтобы построить маршрут на этот день.</p>}
          {day.activities.some(activity => activity.intent_kind !== 'event_visit') && <p className="field-hint">Длительность посещения — оценка. Задайте своё время, если хотите провести в месте больше или меньше минут.</p>}
          {day.activities.length > 1 && <label className="checkbox-label"><input type="checkbox" checked={day.order.length > 0} onChange={event => patch(value => {
            const target = value.days[dayIndex]!; target.order = event.target.checked ? target.activities.slice(1).map((a, i) => [target.activities[i]!.id, a.id]) : [];
          })} />Посетить в этом порядке</label>}
          <ActivityPicker load={loadActivities} walking={draft.shared.mobility?.[0] === 'walking'} disabled={busy || draft.days.reduce((sum, day) => sum + day.activities.length, 0) >= 120}
            add={(choice, options) => add(dayIndex, choice, options)} />
        </div>)}
      </ConditionSection>
      <ConditionSection title="События" icon="calendar" {...section('events')} summary={eventCount ? `Выбрано: ${eventCount}` : 'Выбрать из афиши'}>
        {draft.days.flatMap(day => day.activities.filter(activity => activity.intent_kind === 'event_visit').map(activity => <SelectedEventItem key={JSON.stringify([day.day_id, activity.id])}
          view={{ ...view, draft }} dayId={day.day_id} activityId={activity.id} busy={busy || dirty}
          recheck={() => recheckEvent(day.day_id, activity.id)} chooseOther={() => browseEvents({ day_id: day.day_id, replace_activity_id: activity.id })}
          remove={() => remove(draft.days.findIndex(item => item.day_id === day.day_id), activity.id)} />))}
        <Action variant="secondary" disabled={busy || dirty} onClick={() => browseEvents()}>Открыть афишу</Action>
        {dirty && <p className="field-hint">Примените текущие правки перед выбором или перепроверкой события.</p>}
      </ConditionSection></div>
    </fieldset><div className="sheet-actions"><Action type="submit" stretched disabled={busy || !dirty}>{view.result ? 'Применить и пересчитать' : 'Применить условия'}</Action>
      <Action variant="ghost" stretched disabled={busy || !dirty} onClick={cancel}>Отменить правки</Action></div>
  </form>;
}
