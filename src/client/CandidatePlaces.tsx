import type { PlanningView } from '../shared/planning-form';
import { candidatePreviewNotice, candidateSourceLink } from '../shared/candidate-preview';

export function CandidatePlaces({ view }: { view: PlanningView }) {
  const preview = view.result?.candidate_preview;
  if (!preview) return null;
  return <section className="candidate-places" aria-label="Найденные места">
    <h3>Найденные места</h3><p className="field-hint">{candidatePreviewNotice}</p>
    {preview.groups.map(group => {
      const day = view.draft.days.find(value => value.day_id === group.day_id);
      const activity = day?.activities.find(value => value.id === group.activity_id);
      if (!day || !activity) return null;
      return <section key={`${group.day_id}:${group.activity_id}`} className="candidate-group">
        <h4>{view.draft.days.length > 1 && <>{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(day.date + 'T12:00:00Z'))} · </>}{activity.label} <span>· {group.places.length}</span></h4>
        <ul>{group.places.map(place => {
          const link = candidateSourceLink(place.source);
          const stamp = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: view.draft.locality.timezone }).format(new Date(place.source.fetched_at));
          return <li key={place.place_id}><article className="stop-card candidate-card">
            <div className="stop-content"><h5>{place.name}</h5>{place.location_label && <p className="stop-address">{place.location_label}</p>}</div>
            <footer className="stop-footer"><div className="stop-source"><span>{place.source.data_mode === 'test' ? 'Учебные данные' : place.source.data_mode === 'prepared' ? 'Подготовленные данные' : place.source.provider === '2gis' ? '2ГИС' : 'KudaGo'}</span><small>Получено {stamp}</small></div>
              {link && <a href={link} target="_blank" rel="noopener noreferrer">{place.source.provider === '2gis' ? 'В 2ГИС' : 'О событии'} ↗</a>}</footer>
          </article></li>;
        })}</ul>
      </section>;
    })}
  </section>;
}
