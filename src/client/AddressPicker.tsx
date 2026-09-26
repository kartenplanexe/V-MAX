import { useState, type FormEvent } from 'react';

export type AddressChoice = { id: string; label: string; point: { lat: number; lon: number } };

export function AddressPicker({ city, search, onSelect, onClose, disabled = false }: {
  city: string;
  search: (query: string) => Promise<AddressChoice[]>;
  onSelect: (choice: AddressChoice) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<AddressChoice[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = query.trim();
    if (value.length < 4 || value.length > 120) { setError('Укажите улицу и номер дома — от 4 до 120 символов.'); return; }
    setLoading(true); setError(''); setChoices([]); setSearched(false);
    try { setChoices(await search(value)); setSearched(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось найти адрес.'); }
    finally { setLoading(false); }
  }
  return <section className="address-picker" aria-label="Выбор адреса начала маршрута">
    <form onSubmit={event => void submit(event)}>
      <label>Адрес в городе {city}<input value={query} autoComplete="street-address" maxLength={120}
        placeholder="Улица и номер дома" onChange={event => { setQuery(event.target.value); setChoices([]); setSearched(false); setError(''); }} /></label>
      <button className="secondary-button" type="submit" disabled={disabled || loading}>{loading ? 'Ищем адрес…' : 'Найти адрес'}</button>
    </form>
    {error && <p className="address-picker-error" role="alert">{error}</p>}
    {searched && !choices.length && <p className="field-hint" role="status">Адрес не найден. Уточните улицу и номер дома.</p>}
    {!!choices.length && <div className="address-picker-results" aria-label="Найденные адреса">
      <p className="field-hint">Выберите точный адрес:</p>
      {choices.map(choice => <button key={choice.id} className="address-result" type="button" disabled={disabled || loading}
        onClick={() => onSelect(choice)}>{choice.label}</button>)}
    </div>}
    <button className="text-button" type="button" onClick={onClose}>Закрыть поиск</button>
  </section>;
}
