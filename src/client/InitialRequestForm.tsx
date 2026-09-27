import { Input, Textarea } from '@maxhub/max-ui';
import { useState } from 'react';
import { Action, Icon } from './PlannerUi';
import type { ManualChoices, ManualRequest } from '../shared/manual-planning';
import { ManualRequestForm } from './ManualRequestForm';

export type LocalityChoice = { name: string; token: string };
export function InitialRequestForm({ disabled, search, submit, manualOptions, manualSubmit, initialText = '' }: {
  disabled: boolean; search: (query: string) => Promise<LocalityChoice[]>;
  submit: (value: { user_text: string; locality_token: string; locality_query: string }) => Promise<void>;
  initialText?: string;
  manualOptions: (token: string) => Promise<ManualChoices>;
  manualSubmit: (value: Omit<ManualRequest, 'event_id'>) => void;
}) {
  const [query, setQuery] = useState(''), [choices, setChoices] = useState<LocalityChoice[]>([]);
  const [selected, setSelected] = useState<LocalityChoice | null>(null), [text, setText] = useState(initialText);
  const [searching, setSearching] = useState(false), [error, setError] = useState('');
  const [manual, setManual] = useState<ManualChoices | null>(null), [manualLoading, setManualLoading] = useState(false);
  async function find() {
    if (disabled || searching || manualLoading || query.trim().length < 2) return;
    setSearching(true); setError(''); setChoices([]); setSelected(null);
    try { const found = await search(query.trim()); setChoices(found); if (!found.length) setError('Уточните название города или добавьте регион.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось найти город. Повторите поиск.'); }
    finally { setSearching(false); }
  }
  return <section className="initial-request" aria-labelledby="initial-heading">
    <div className="intro-heading"><span className="intro-route" aria-hidden="true"><Icon name="route" /></span>
      <h2 id="initial-heading">Куда хотите сходить?</h2><p>Расскажите, что вам интересно и когда вы свободны. Вместе проверим, что получится успеть.</p></div>
    <form className="city-search" onSubmit={event => { event.preventDefault(); void find(); }}>
      <label htmlFor="initial-city">Город или населённый пункт</label>
      <div className="search-input-row"><Input id="initial-city" value={query} maxLength={100} placeholder="Например, Казань" disabled={disabled || searching || manualLoading}
        onChange={event => { setQuery(event.target.value); setSelected(null); setChoices([]); setManual(null); }} iconBefore={<Icon name="pin" />} />
        <Action type="submit" variant="secondary" disabled={disabled || searching || manualLoading || query.trim().length < 2} loading={searching}>Найти</Action></div>
      {choices.length > 0 && <div className="city-choices" aria-label="Найденные города">{choices.map((choice, index) =>
        <Action key={index} variant="secondary" disabled={disabled || manualLoading} aria-pressed={selected?.token === choice.token}
          onClick={() => { setSelected(choice); setError(''); setManual(null); }}>{choice.name}{selected?.token === choice.token && <Icon name="check" />}</Action>)}</div>}
    </form>
    {manual && selected ? <><ManualRequestForm options={manual} busy={disabled} submit={value => manualSubmit({ ...value, locality_token: selected.token })} /><Action variant="ghost" onClick={() => setManual(null)}>Описать словами</Action></> : <form className="wish-composer" onSubmit={event => { event.preventDefault(); if (selected && text.trim()) void submit({ user_text: text.trim(), locality_token: selected.token, locality_query: query.trim() }); }}>
      <label htmlFor="initial-wishes">Ваши пожелания</label>
      <Textarea id="initial-wishes" value={text} maxLength={4000} rows={4} disabled={disabled} required
        placeholder="Завтра с 14 до 18 хочу погулять, а потом поесть. Пешком, вдвоём." onChange={event => setText(event.target.value)} />
      <div className="request-examples" aria-label="Примеры пожеланий">{['Хочу погулять', 'Хочу погулять, а потом поесть'].map(example =>
        <Action key={example} variant="ghost" size="small" disabled={disabled} onClick={() => setText(example)}>{example}</Action>)}</div>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <Action type="submit" stretched disabled={disabled || !selected || !text.trim()} iconAfter={<Icon name="arrow" />}>Разобрать пожелания</Action>
      <Action variant="secondary" stretched disabled={disabled || !selected || manualLoading} loading={manualLoading} onClick={() => {
        if (!selected) return; setManualLoading(true); setError('');
        void manualOptions(selected.token).then(setManual).catch(cause => setError(cause instanceof Error ? cause.message : 'Не удалось открыть категории.')).finally(() => setManualLoading(false));
      }}>Выбрать вручную</Action>
      {!selected && <p className="field-hint">Сначала найдите и выберите город.</p>}
    </form>}
  </section>;
}
