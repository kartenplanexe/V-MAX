import { useEffect, useRef, useState } from 'react';
import type { SavedRouteList } from '../shared/saved-route-list';
import { Action, Icon } from './PlannerUi';

export function SavedRoutesPanel({ busy, load, open, remove }: {
  busy: boolean; load: (cursor?: string) => Promise<SavedRouteList>; open: (id: string) => void;
  remove: (item: SavedRouteList['items'][number]) => Promise<void>;
}) {
  const [page, setPage] = useState<SavedRouteList | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [deleting, setDeleting] = useState<SavedRouteList['items'][number] | null>(null);
  const loader = useRef(load); loader.current = load;
  useEffect(() => { let active = true; setLoading(true);
    void loader.current().then(value => { if (active) setPage(value); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Не удалось открыть маршруты.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; }; }, []);
  async function more() {
    if (loading) return; setLoading(true); setError('');
    try { const next = await load(page?.next_cursor ?? undefined); setPage(value => value ? { ...next, items: [...value.items, ...next.items].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index) } : next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось загрузить маршруты.'); }
    finally { setLoading(false); }
  }
  return <section className="saved-routes">
    <p className="field-hint">Ваши условия сохраняются автоматически. Открытие маршрута не запускает новый расчёт.</p>
    {page?.items.length === 0 && <div className="empty-state"><Icon name="route" /><h3>Здесь будут ваши маршруты</h3><p>Составьте первый план — к его условиям можно будет вернуться.</p></div>}
    {deleting ? <section className="delete-confirmation" aria-label="Подтверждение удаления"><h3>Удалить «{deleting.title}»?</h3><p>Условия маршрута и созданные для него ссылки станут недоступны. Копии, которые другие пользователи уже сохранили себе, останутся у них.</p>
      <div className="share-actions"><Action variant="destructive" disabled={busy || loading} onClick={() => { setLoading(true); setError(''); void remove(deleting).then(() => { setPage(value => value ? { ...value, items: value.items.filter(item => item.id !== deleting.id) } : value); setDeleting(null); })
        .catch(cause => setError(cause instanceof Error ? cause.message : 'Не удалось удалить маршрут.')) .finally(() => setLoading(false)); }}>Удалить маршрут</Action>
      <Action variant="secondary" disabled={busy || loading} onClick={() => { setDeleting(null); setError(''); }}>Оставить</Action></div></section> : <ul className="saved-route-list">{page?.items.map(item => <li key={item.id}><button type="button" disabled={busy || loading} onClick={() => open(item.id)}>
      <span className="saved-route-icon"><Icon name="route" /></span><span><strong>{item.title}</strong><small>{item.has_fresh_result ? 'Проверенный маршрут' : item.can_open ? 'Черновик' : 'Сохранённые условия'}{item.active ? ' · текущий' : ''}</small>
        <small>Обновлён {new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(item.updated_at))}</small></span><Icon name="chevron" /></button>
      <Action variant="ghost" className="saved-delete" disabled={busy || loading} aria-label={`Удалить маршрут «${item.title}»`} onClick={() => { setDeleting(item); setError(''); }}>Удалить</Action></li>)}</ul>}
    {loading && <p className="field-hint" role="status">Загружаем маршруты…</p>}
    {error && <p className="notice notice--error" role="alert">{error}</p>}
    {!deleting && (page?.next_cursor || error) && <Action variant="secondary" stretched disabled={busy || loading} onClick={() => void more()}>{error ? 'Повторить загрузку' : 'Показать ещё'}</Action>}
  </section>;
}
