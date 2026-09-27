import type { AlternativePreview } from '../shared/route-alternatives';
import type { PlanningView } from '../shared/planning-form';
import { Action, Icon, useExpired } from './PlannerUi';

const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
function delta(value: number | null, unit: string) { return value == null ? 'Нет данных' : value === 0 ? 'Без изменения' : `${value > 0 ? '+' : '−'}${Math.abs(value)} ${unit}`; }
export function AlternativePanel({ preview, current, busy, apply, close }: {
  preview: AlternativePreview; current: PlanningView; busy: boolean; apply: (id: string) => void; close: () => void;
}) {
  const alternative = preview.alternatives[0];
  const expired = useExpired(preview.expires_at);
  const before = current.result?.days.find(day => day.day_id === preview.target.day_id)?.visits.find(visit => visit.place_id === preview.target.place_id && visit.activity_id === preview.target.activity_id);
  const day = alternative?.result.days.find(value => value.day_id === preview.target.day_id);
  const after = day?.visits.find(visit => visit.activity_id === preview.target.activity_id && visit.place_id !== preview.target.place_id);
  return <section className="alternative-panel">
    <p className="field-hint">Меняем одну остановку. Остальные места и ваш порядок сохраняются; время проверено заново.</p>
    {expired ? <div className="notice"><p>Срок проверки замены истёк. Вернитесь к маршруту и подберите её заново.</p><Action variant="secondary" onClick={close}>К маршруту</Action></div> : alternative && after ? <>
      <div className="replacement-before"><span className="summary-label">Сейчас</span><h3>{before?.name ?? 'Выбранная остановка'}</h3></div>
      <div className="replacement-after"><span className="summary-label">Подходящая замена</span><h3>{after.name}</h3><p>{after.location_label}</p>
        <div className="replacement-time"><Icon name="clock" />{clock(after.starts_at)}–{clock(after.ends_at)}</div>
        <p>{after.price_expected_minor == null ? 'Стоимость не указана' : `${new Intl.NumberFormat('ru-RU').format(after.price_expected_minor / 100)} ₽ · ориентир`}</p></div>
      <dl className="replacement-deltas"><div><dt>Финиш дня</dt><dd>{delta(alternative.delta.ends_at_minutes, 'мин')}</dd></div>
        <div><dt>Время в пути</dt><dd>{delta(alternative.delta.travel_minutes, 'мин')}</dd></div>
        <div><dt>Расходы</dt><dd>{delta(alternative.delta.expected_cost_minor == null ? null : alternative.delta.expected_cost_minor / 100, '₽')}</dd></div></dl>
      <details className="plan-evidence"><summary>Расписание после замены</summary><ol className="compact-route">{day?.visits.map(visit => <li key={`${visit.activity_id}:${visit.place_id}`}><time>{clock(visit.starts_at)}–{clock(visit.ends_at)}</time><span>{visit.name}</span></li>)}</ol></details>
      <div className="sheet-actions"><Action stretched disabled={busy || Date.parse(preview.expires_at) <= Date.now()} onClick={() => apply(alternative.id)}>Заменить остановку</Action><Action variant="ghost" stretched disabled={busy} onClick={close}>Оставить текущую</Action></div>
    </> : <div className="empty-state"><Icon name="route" /><h3>Подходящей замены пока нет</h3><p>В проверенной выборке не нашлось другого места, с которым сохраняются условия вашего плана.</p><Action variant="secondary" stretched onClick={close}>Вернуться к маршруту</Action></div>}
  </section>;
}
