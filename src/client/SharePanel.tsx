import { useState } from 'react';
import type { ShareCreated, SharePreview } from '../shared/route-sharing';
import { savedConditionsText } from '../shared/saved-conditions-text';
import { unavailablePlanNotice } from '../shared/plan-evidence-text';
import { Action, Icon, useExpired } from './PlannerUi';

export function SharePanel({ created, busy, party, create, revoke }: {
  created: ShareCreated | null; busy: boolean; party?: { total?: number; child_ages?: number[] };
  create: (points: boolean) => void; revoke: () => void;
}) {
  const [points, setPoints] = useState(false), [feedback, setFeedback] = useState('');
  const expired = useExpired(created?.expires_at);
  function share() {
    if (!created) return;
    setFeedback('');
    try {
      if (!window.WebApp?.shareMaxContent) { setFeedback('В этой версии MAX нет экрана отправки. Скопируйте ссылку ниже.'); return; }

      const result = window.WebApp.shareMaxContent({ text: 'План досуга - откройте, чтобы посмотреть условия и маршрут.', link: created.deep_link });
      void Promise.resolve(result).catch(() => setFeedback('Не удалось открыть отправку. Можно скопировать ссылку.'));
    } catch { setFeedback('Не удалось открыть отправку. Можно скопировать ссылку.'); }
  }
  return <section className="share-panel"><p>Получатель сможет посмотреть пожелания и сохранить собственную копию условий. Места для своей поездки он подберёт заново. Ваш маршрут останется у вас.</p>
    {!created ? <><p className="field-hint">По ссылке будут доступны даты, время, занятия, их порядок, бюджет, состав группы и ваши требования к местам. Любой, кому передадут ссылку, сможет открыть эти условия в MAX.</p>
      {party && (party.total !== undefined || party.child_ages !== undefined) && <p className="field-hint">Состав группы в ссылке: {party.total !== undefined ? `${party.total} чел.` : 'число участников не указано'}{party.child_ages !== undefined ? party.child_ages.length ? `; возраст детей: ${party.child_ages.join(', ')} лет` : '; без детей' : ''}. Перед созданием ссылки можно изменить эти данные в условиях плана.</p>}
      <label className="checkbox-label"><input type="checkbox" checked={points} onChange={event => setPoints(event.target.checked)} disabled={busy} />Включить выбранные мной точки старта и финиша</label>
      <p className="field-hint">{points ? 'Ссылка откроет эти координаты любому, кому её передадут.' : 'Личные точки и введённые адреса не попадут в ссылку. Получатель выберет свой старт.'}</p>
      <Action stretched disabled={busy} onClick={() => create(points)}>Создать ссылку</Action></> : <>
      <p className="field-hint">Ссылка действует до {new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(created.expires_at))}. Места доступны только пока актуальны исходные данные.</p>
      <p className="field-hint">Это снимок условий на момент создания ссылки. Последующие изменения в неё не попадут.</p>
      <div className="share-actions"><Action stretched disabled={busy || expired} onClick={share}>Отправить в MAX</Action>
        <Action variant="secondary" stretched onClick={() => { if (!navigator.clipboard) { setFeedback('Скопируйте ссылку из поля ниже.'); return; } void navigator.clipboard.writeText(created.deep_link).then(() => setFeedback('Ссылка скопирована.')).catch(() => setFeedback('Скопируйте ссылку из поля ниже.')); }}>Скопировать ссылку</Action></div>
      <label>Ссылка для получателя<input readOnly value={created.deep_link} onFocus={event => event.target.select()} /></label>
      <Action variant="ghost" disabled={busy} onClick={revoke}>Отозвать эту ссылку</Action></>}
    {feedback && <p className="field-hint" role="status">{feedback}</p>}
  </section>;
}

export function SharedRoutePreview({ preview, busy, search, importRoute, close }: {
  preview: SharePreview; busy: boolean; search: (query: string) => Promise<{ name: string; token: string }[]>;
  importRoute: (token: string) => void; close: () => void;
}) {
  const [query, setQuery] = useState(''), [choices, setChoices] = useState<{ name: string; token: string }[]>([]);
  const [searching, setSearching] = useState(false), [error, setError] = useState('');
  const expired = useExpired(preview.result_expires_at);
  const planExpired = useExpired(preview.result?.valid_until);
  const result = !expired && !planExpired && preview.result_expires_at ? preview.result : null;
  async function find() {
    if (busy || searching || query.trim().length < 2) return;
    setSearching(true); setError(''); setChoices([]);
    try { const values = await search(query.trim()); setChoices(values); if (!values.length) setError('Уточните название города.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось найти город.'); }
    finally { setSearching(false); }
  }
  return <section className="shared-preview"><div className="result-notice"><Icon name="route" /><div><h2>С вами поделились планом</h2><p>Просмотр не меняет ваш текущий маршрут.</p></div></div>
    {!!preview.omissions.length && <p className="field-hint">Автор не передал {preview.omissions.map(value => value === 'origin' ? 'точку старта' : 'точку финиша').join(' и ')}. Выберите свои точки после сохранения копии.</p>}
    <details className="plan-evidence" open><summary>Пожелания и условия</summary><p className="saved-text">{savedConditionsText({ id: 'shared', revision: preview.conditions.conditions_revision, expires_at: preview.expires_at, conditions: preview.conditions }).split('\n').slice(2).join('\n')}</p></details>
    {result ? <><h3>{result.status === 'LIMITED' ? 'Частичный маршрут автора' : result.status === 'AVAILABLE' ? 'Маршрут автора' : 'Результат автора'}</h3>
      {result.status === 'UNAVAILABLE' && <p className="field-hint">{unavailablePlanNotice(result)}</p>}
      {result.days.map(day => <div key={day.day_id} className="shared-day"><h4>{day.date} · {day.status === 'AVAILABLE' ? 'Все занятия' : day.status === 'LIMITED' ? 'Частично' : 'Не составлен'}</h4>
        <ol className="compact-route">{day.visits.map(visit => <li key={`${visit.activity_id}:${visit.place_id}`}><strong>{visit.name}</strong>{visit.location_label && <span>{visit.location_label}</span>}</li>)}</ol></div>)}
      <p className="field-hint">При продолжении в своей копии места и дорогу проверим заново.</p></> : <p className="field-hint">В ссылке доступны сохранённые условия. Места и маршрут нужно проверить заново.</p>}
    <form className="city-search" onSubmit={event => { event.preventDefault(); void find(); }}><label htmlFor="shared-city">Город для вашей копии</label>
      <div className="search-input-row"><input id="shared-city" value={query} maxLength={100} disabled={busy || searching} onChange={event => { setQuery(event.target.value); setChoices([]); }} placeholder="Введите город" />
        <Action type="submit" variant="secondary" disabled={busy || searching || query.trim().length < 2} loading={searching}>Найти</Action></div>
      {!!choices.length && <div className="city-choices" aria-label="Сохранить копию в выбранном городе">{choices.map((choice, i) => <Action key={i} disabled={busy} onClick={() => importRoute(choice.token)}>Сохранить копию · {choice.name}</Action>)}</div>}
    </form>{error && <p className="notice notice--error" role="alert">{error}</p>}
    <Action variant="ghost" stretched onClick={close}>К моему маршруту</Action>
  </section>;
}
