import { useState } from 'react';
import type { ManualChoices, ManualRequest } from '../shared/manual-planning';
import { Action, Icon } from './PlannerUi';

type Day = ManualRequest['days'][number];
const blankDay = (): Day => ({ date: '', start: '', end: '', ordered: false, activities: [] });
export function ManualRequestForm({ options, busy, submit }: {
  options: ManualChoices; busy: boolean; submit: (value: Pick<ManualRequest, 'catalog_version' | 'mobility' | 'days'>) => void;
}) {
  const [days, setDays] = useState<Day[]>([blankDay()]), [mode, setMode] = useState<ManualRequest['mobility']>('walking');
  const [query, setQuery] = useState(''), [selected, setSelected] = useState('');
  const categories = options.categories.filter(value => value.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
  function edit(index: number, change: (day: Day) => void) { setDays(values => { const next = structuredClone(values); change(next[index]!); return next; }); }
  function activityName(activity: Day['activities'][number]) { return activity.kind === 'walk' ? 'Прогулка' : options.categories.filter(value => activity.category_ids.includes(value.id)).map(value => value.name).join(' / '); }
  function move(index: number, from: number, to: number) { edit(index, day => { const [value] = day.activities.splice(from, 1); day.activities.splice(to, 0, value!); day.ordered = true; }); }
  return <form className="manual-request" onSubmit={event => { event.preventDefault(); submit({ catalog_version: options.catalog_version, mobility: mode, days }); }}>
    <div className="manual-heading"><h3>Соберите пожелания вручную</h3><p className="field-hint">Выберите занятия из каталога {options.locality_name}. Места подберём после подтверждения условий.</p></div>
    <fieldset disabled={busy}>
      <label>Как передвигаемся<select required value={mode} onChange={event => setMode(event.target.value as ManualRequest['mobility'])}>{options.modes.map(value => <option key={value} value={value}>{({ walking: 'Пешком', driving: 'На машине', cycling: 'На велосипеде', public_transport: 'Общественным транспортом' })[value]}</option>)}</select></label>
      <div className="category-picker"><label>Найти вид занятия<input type="search" value={query} onChange={event => { setQuery(event.target.value); setSelected(''); }} placeholder="Музеи, кафе…" /></label>
        <label>Категория<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">Выберите категорию</option>{categories.map(value => <option key={value.id} value={value.id}>{value.name} · около {value.estimated_visit_minutes} мин</option>)}</select></label>
        {!categories.length && <p className="field-hint">Такой категории нет в доступном каталоге. Попробуйте другое название.</p>}</div>
      {days.map((day, index) => <section className="manual-day" key={index}><div className="day-heading"><h3>День {index + 1}</h3>{days.length > 1 && <Action variant="ghost" onClick={() => setDays(values => values.filter((_, i) => i !== index))} aria-label={`Удалить день ${index + 1}`}><Icon name="close" /></Action>}</div>
        <div className="field-row field-row--time"><label>Дата<input type="date" required value={day.date} onChange={event => edit(index, value => { value.date = event.target.value; })} /></label>
          <label>Начало<input type="time" required value={day.start} onChange={event => edit(index, value => { value.start = event.target.value; })} /></label>
          <label>Окончание<input type="time" required value={day.end} onChange={event => edit(index, value => { value.end = event.target.value; })} /></label></div>
        <ol className="activity-editor">{day.activities.map((activity, activityIndex) => <li key={activityIndex}><strong>{activityName(activity)}</strong><div className="order-actions">
          <Action variant="ghost" className="icon-action" disabled={activityIndex === 0} aria-label={`Раньше: ${activityName(activity)}`} onClick={() => move(index, activityIndex, activityIndex - 1)}>↑</Action>
          <Action variant="ghost" className="icon-action" disabled={activityIndex === day.activities.length - 1} aria-label={`Позже: ${activityName(activity)}`} onClick={() => move(index, activityIndex, activityIndex + 1)}>↓</Action>
          <Action variant="ghost" className="icon-action" aria-label={`Удалить: ${activityName(activity)}`} onClick={() => edit(index, value => { value.activities.splice(activityIndex, 1); })}><Icon name="close" /></Action></div></li>)}</ol>
        <div className="point-actions">{options.walking_available && <Action variant="secondary" onClick={() => edit(index, value => { value.activities.push({ kind: 'walk' }); })}><Icon name="walk" />Прогулка</Action>}
          <Action variant="secondary" disabled={!selected} onClick={() => edit(index, value => { value.activities.push({ kind: 'place', category_ids: [selected] }); })}><Icon name="plus" />Добавить категорию</Action></div>
        <label className="checkbox-label"><input type="checkbox" checked={day.ordered} onChange={event => edit(index, value => { value.ordered = event.target.checked; })} />Посетить в этом порядке</label>
      </section>)}
      <Action variant="ghost" disabled={days.length >= 31} onClick={() => setDays(values => [...values, blankDay()])}><Icon name="plus" />Ещё день</Action>
      <p className="field-hint">Можно оставить занятия пустыми и выбрать событие из афиши на следующем шаге.</p>
      {days.some(day => day.start && day.end && day.start >= day.end) && <p className="notice notice--error" role="alert">Окончание должно быть позже начала. Для ночного плана добавьте отдельный день.</p>}
      {new Set(days.filter(day => day.date).map(day => day.date)).size < days.filter(day => day.date).length && <p className="notice notice--error" role="alert">Для каждого дня выберите свою дату.</p>}
      <Action type="submit" stretched disabled={days.some(day => !day.date || !day.start || !day.end || day.start >= day.end) || new Set(days.map(day => day.date)).size !== days.length}>{days.every(day => !day.activities.length) ? 'Продолжить к выбору событий' : 'Продолжить с этими условиями'}</Action>
    </fieldset>
  </form>;
}
