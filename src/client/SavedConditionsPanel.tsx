import { useState } from 'react';
import type { SavedConditionsView } from '../shared/saved-conditions';
import { savedConditionsText } from '../shared/saved-conditions-text';
import { Action, Icon } from './PlannerUi';

type City = { name: string; token: string };
export function SavedConditionsPanel({ saved, disabled, search, restore }: {
  saved: SavedConditionsView; disabled: boolean;
  search: (query: string) => Promise<City[]>; restore: (token: string) => Promise<void>;
}) {
  const [query, setQuery] = useState(saved.conditions.queries.locality ?? '');
  const [choices, setChoices] = useState<City[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  async function find() {
    if (searching || disabled || query.trim().length < 2) return;
    setSearching(true); setError(''); setChoices([]);
    try {
      const found = await search(query.trim()); setChoices(found);
      if (!found.length) setError('Город не найден. Уточните название и регион.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось найти город.'); }
    finally { setSearching(false); }
  }
  return <section className="saved-conditions" aria-label="Сохранённые условия">
    <div className="result-notice"><Icon name="refresh" /><div><h2>Вернёмся к вашему плану</h2><p>Условия сохранились. Места, расписания и дорогу нужно проверить заново.</p></div></div>
    <div className="saved-summary">{saved.conditions.days.map(day => <div key={day.day_id} className="saved-day">
      <p className="summary-label">{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`))}{day.window && ` · ${day.window.start}–${day.window.end}`}</p>
      <h3>{day.activities.map(activity => activity.label).join(' → ')}</h3></div>)}</div>
    <details className="plan-evidence"><summary>Все сохранённые условия</summary><p className="saved-text">{savedConditionsText(saved).split('\n').slice(2).join('\n')}</p></details>
    <p className="field-hint">Даты сами не сдвигаются. Перед новым расчётом проверьте время и старт.</p>
    {!refreshing ? <Action stretched disabled={disabled} onClick={() => setRefreshing(true)}>Продолжить с этими условиями</Action> : <form className="city-search" onSubmit={event => { event.preventDefault(); void find(); }}>
      <label htmlFor="saved-city">Подтвердите город</label><div className="search-input-row"><input id="saved-city" value={query} maxLength={100} disabled={disabled || searching}
        onChange={event => { setQuery(event.target.value); setChoices([]); }} />
      <Action type="submit" variant="secondary" disabled={disabled || searching || query.trim().length < 2} loading={searching}>Найти</Action></div>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {choices.length > 0 && <div className="city-choices" aria-label="Выберите город">
        {choices.map((choice, index) => <Action key={index} variant="secondary" disabled={disabled || searching}
          onClick={() => void restore(choice.token)}>{choice.name}<Icon name="arrow" /></Action>)}
      </div>}
    </form>}
  </section>;
}
