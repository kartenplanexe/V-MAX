import { useState } from 'react';
import { Action } from './PlannerUi';

export type AddressChoice = { id: string; label: string; point: { lat: number; lon: number } };

export function AddressPicker({ city, search, onSelect, onClose, disabled = false, embedded = false }: {
  city: string;
  search: (query: string) => Promise<AddressChoice[]>;
  onSelect: (choice: AddressChoice) => void;
  onClose: () => void;
  disabled?: boolean;
  embedded?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<AddressChoice[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    if (disabled || loading) return;
    const value = query.trim();
    if (value.length < 4 || value.length > 120) { setError('Укажите улицу и номер дома - от 4 до 120 символов.'); return; }
    setLoading(true); setError(''); setChoices([]); setSearched(false);
    try { setChoices(await search(value)); setSearched(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось найти адрес.'); }
    finally { setLoading(false); }
  }
  const Wrapper = embedded ? 'div' : 'form';
  return <section className="address-picker" aria-label="Выбор адреса">
    <Wrapper className="address-search" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>Адрес в городе {city}<input value={query} disabled={disabled || loading} autoComplete="street-address" maxLength={120}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void submit(); } }}
        placeholder="Улица и номер дома" onChange={event => { setQuery(event.target.value); setChoices([]); setSearched(false); setError(''); }} /></label>
      <Action variant="secondary" disabled={disabled || loading} loading={loading} onClick={() => void submit()}>Найти адрес</Action>
    </Wrapper>
    {error && <p className="address-picker-error" role="alert">{error}</p>}
    {searched && !choices.length && <p className="field-hint" role="status">Адрес не найден. Уточните улицу и номер дома.</p>}
    {!!choices.length && <div className="address-picker-results" aria-label="Найденные адреса">
      <p className="field-hint">Выберите точный адрес:</p>
      {choices.map(choice => <button key={choice.id} className="address-result" type="button" disabled={disabled || loading}
        onClick={() => onSelect(choice)}>{choice.label}</button>)}
    </div>}
    <Action variant="ghost" onClick={onClose}>Закрыть поиск</Action>
  </section>;
}
