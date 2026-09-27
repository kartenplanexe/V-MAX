import { useState } from 'react';
import type { ManualChoices } from '../shared/manual-planning';
import type { ActivityChoice } from '../shared/activity-choice';
import { Action, Icon } from './PlannerUi';

export function ActivityPicker({ load, walking, add, disabled }: { load: () => Promise<ManualChoices>; walking: boolean;
  add: (choice: ActivityChoice, options: ManualChoices) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false), [options, setOptions] = useState<ManualChoices | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [selected, setSelected] = useState('');
  async function show() {
    setOpen(true); if (options) return;
    setPending(true); setError('');
    try { setOptions(await load()); }
    catch (error) { setError(error instanceof Error ? error.message : 'Не удалось загрузить занятия.'); }
    finally { setPending(false); }
  }
  function select(choice: ActivityChoice) { add(choice, options!); setOpen(false); setSelected(''); setQuery(''); }
  if (!open) return <Action variant="secondary" disabled={disabled} onClick={() => void show()}><Icon name="plus" />Добавить занятие</Action>;
  const categories = options?.categories.filter(c => c.name.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))) ?? [];
  return <div className="category-picker activity-picker">
    {pending && <p role="status">Загружаем занятия…</p>}
    {error && <div role="alert"><p>{error}</p><Action variant="secondary" disabled={pending} onClick={() => void show()}>Повторить загрузку занятий</Action></div>}
    {options && <>
      <label>Найти занятие<input type="search" value={query} placeholder="Кафе, музеи…" onChange={event => { setQuery(event.target.value); setSelected(''); }} /></label>
      <label>Вид занятия<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">Выберите категорию</option>
        {categories.map(c => <option key={c.id} value={c.id}>{c.name} · около {c.estimated_visit_minutes} мин</option>)}</select></label>
      {!categories.length && <p className="field-hint">В доступном каталоге нет такой категории. Попробуйте другое название.</p>}
      <p className="field-hint">Время посещения приблизительное. Конкретные места подберём при расчёте.</p>
      <div className="point-actions"><Action variant="primary" disabled={disabled || !selected} onClick={() => select({ kind: 'place', category_ids: [selected] })}>Добавить выбранное занятие</Action>
        {options.walking_available && <Action variant="secondary" disabled={disabled || !walking} onClick={() => select({ kind: 'walk' })}><Icon name="walk" />Добавить прогулку</Action>}</div>
      {options.walking_available && !walking && <p className="field-hint">Для прогулки выберите передвижение пешком.</p>}
    </>}
    <Action variant="ghost" onClick={() => setOpen(false)}>Закрыть выбор занятия</Action>
  </div>;
}
