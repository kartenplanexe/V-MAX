import type { PlanningView } from '../shared/planning-form';
import { candidatePreviewNotice, compactPlacesNotice, candidateSourceLink, selectionGapNotice } from '../shared/candidate-preview';
import { useMemo, useState } from 'react';
import { PlanMap } from './PlanMap';
import { dgisDayDirectionsLink, dgisDirectionsLink } from '../shared/dgis-links';
import { DgisLink } from './DgisLink';

export function CandidatePlaces({ view, mapsAvailable = false }: { view: PlanningView; mapsAvailable?: boolean }) {
  const preview = view.result?.candidate_preview;
  const [selectedDay, setSelectedDay] = useState(preview?.groups[0]?.day_id ?? ''), [selected, setSelected] = useState<number>();
  const [mode, setMode] = useState<'plan' | 'map'>('plan');
  const dayId = view.draft.days.some(day => day.day_id === selectedDay) ? selectedDay : preview?.groups[0]?.day_id;
  const mapDay = useMemo(() => ({ visits: [...new Map((preview?.groups ?? []).filter(group => group.day_id === dayId)
    .flatMap(group => group.places.filter(place => place.point).map(place => [place.place_id,
      { ...place, activity_id: group.activity_id }] as const))).values()] }), [preview, dayId]);
  if (!preview) return null;
  const dayDirections = dgisDayDirectionsLink(view, dayId);
  const missing = view.draft.days.flatMap(day => day.activities.filter(activity =>
    !preview.groups.some(group => group.day_id === day.day_id && group.activity_id === activity.id))
    .map(activity => ({ label: `${view.draft.days.length > 1 ? `${day.date} · ` : ''}${activity.label}`,
      reason: view.result?.selection_gaps?.find(gap => gap.day_id === day.day_id && gap.activity_id === activity.id)?.reason })));
  const dayGroups = preview.groups.filter(group => group.day_id === dayId);
  const stopCount = dayGroups.reduce((total, group) => total + group.places.length, 0);
  return <section className="candidate-places" aria-label="Найденные места">
    {!view.result?.selection_policy && <><h3>Варианты мест</h3><p className="field-hint">{candidatePreviewNotice}</p></>}
    {missing.map(item => <p className="notice" key={item.label}>{item.label}: {selectionGapNotice(item.reason)}</p>)}
    {view.draft.days.length > 1 && <nav className="day-tabs" aria-label="День подбора">{view.draft.days.map(day =>
      <button key={day.day_id} type="button" aria-pressed={dayId === day.day_id} onClick={() => { setSelectedDay(day.day_id); setSelected(undefined); }}>{day.date}</button>)}</nav>}
    {view.result?.selection_policy && <div className="candidate-overview"><span>План дня</span><strong>{stopCount ? `${stopCount} ${stopCount === 1 ? 'место' : stopCount < 5 ? 'места' : 'мест'}` : 'Пока без мест'}</strong><p>Остановки показаны в порядке посещения.</p></div>}
    {mapsAvailable && mapDay.visits.length > 0 && <nav className="view-switch candidate-view-switch" aria-label="Вид подборки">
      <button type="button" aria-pressed={mode === 'plan'} onClick={() => setMode('plan')}>План</button>
      <button type="button" aria-pressed={mode === 'map'} onClick={() => setMode('map')}>Карта</button>
    </nav>}
    {mode === 'map' && mapsAvailable && mapDay.visits.length > 0 ? <div className="candidate-mode-panel" key={`map:${dayId}`}>
      <PlanMap day={mapDay} origin={view.draft.points.origin} destination={view.draft.points.destination}
        placesOnly activeVisitIndex={selected} onSelectVisit={setSelected} />
      {dayDirections && <DgisLink href={dayDirections} className="all-stops-link">Открыть весь маршрут в 2ГИС ↗</DgisLink>}
    </div> : <div className="candidate-mode-panel" key={`plan:${dayId}`}>
    {dayGroups.map(group => {
      const day = view.draft.days.find(value => value.day_id === group.day_id);
      const activity = day?.activities.find(value => value.id === group.activity_id);
      if (!day || !activity) return null;
      return <section key={`${group.day_id}:${group.activity_id}`} className="candidate-group">
        <h4>{view.draft.days.length > 1 && <>{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(day.date + 'T12:00:00Z'))} · </>}{activity.label} <span>· {group.places.length}</span></h4>
        <ol className="candidate-dayline">{group.places.map(place => {
          const link = candidateSourceLink(place.source);
          const directions = dgisDirectionsLink(place.point, view.draft.shared.mobility?.[0], view.draft.points.origin);
          const mapIndex = mapDay.visits.findIndex(item => item.place_id === place.place_id);
          const stamp = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: view.draft.locality.timezone }).format(new Date(place.source.fetched_at));
          return <li key={place.place_id}>
            <span className="candidate-step-number" aria-hidden="true">{mapIndex >= 0 ? mapIndex + 1 : '•'}</span>
            <article className="stop-card candidate-card">
            <div className="stop-content"><h5>{place.name}</h5>{place.location_label && <p className="stop-address">{place.location_label}</p>}
              {place.estimated_visit_minutes !== undefined && <p className="field-hint">На посещение — примерно {place.estimated_visit_minutes} мин.</p>}</div>
            {mapsAvailable && mapIndex >= 0 && <button type="button" className="button-secondary" onClick={() => { setSelected(mapIndex); setMode('map'); }}>Показать на карте</button>}
            <footer className="stop-footer"><div className="stop-source"><span>{place.source.data_mode === 'test' ? 'Учебные данные' : place.source.data_mode === 'prepared' ? 'Подготовленные данные' : place.source.provider === '2gis' ? '2ГИС' : 'KudaGo'}</span><small>Получено {stamp}</small></div>
              {directions && <DgisLink href={directions}>Перейти в 2ГИС ↗</DgisLink>}
              {link && <DgisLink href={link}>{place.source.provider === '2gis' ? 'Карточка места' : 'О событии'} ↗</DgisLink>}</footer>
          </article></li>;
        })}</ol>
      </section>;
    })}
    {dayDirections && <DgisLink href={dayDirections} className="all-stops-link">Посмотреть на карте ↗</DgisLink>}
    {view.result?.selection_policy && !dayDirections && <p className="notice">Для этого дня нет общего маршрута в 2ГИС. Откройте места по отдельности.</p>}
    </div>}
    {view.result?.selection_policy && <p className="field-hint candidate-footnote">{compactPlacesNotice}</p>}
  </section>;
}
