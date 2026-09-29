import { useEffect, useState } from 'react';
import { Sheet } from './PlannerUi';

export function PlanningLoading() {
  const [takingLonger, setTakingLonger] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setTakingLonger(true), 15_000);
    return () => clearTimeout(timer);
  }, []);
  return <Sheet title="Собираем ваш день" className="planning-loading-sheet" canClose={false} onClose={() => {}}>
    <div className="planning-loading" role="status" aria-live="polite" aria-atomic="true">
      <div className="planning-loading-art" aria-hidden="true">
        <svg viewBox="0 0 280 180" fill="none">
          <path className="loading-road" d="M48 126V82a24 24 0 0 1 24-24h116a24 24 0 0 1 24 24v20a24 24 0 0 1-24 24H120" />
          <path className="loading-trail" pathLength="100" d="M48 126V82a24 24 0 0 1 24-24h116a24 24 0 0 1 24 24v20a24 24 0 0 1-24 24H120" />
          <g className="loading-stop loading-stop--one"><circle cx="48" cy="126" r="18" /><circle cx="48" cy="126" r="6" /></g>
          <g className="loading-stop loading-stop--two"><circle cx="137" cy="58" r="18" /><path d="m130 58 5 5 9-10" /></g>
          <g className="loading-stop loading-stop--three"><circle cx="212" cy="101" r="18" /><path d="M207 97h10v8h-10zM212 93v4" /></g>
          <circle className="loading-destination" cx="120" cy="126" r="6" />
        </svg>
      </div>
      <p className="loading-caption">Ищем места, ради которых стоит выйти из дома</p>
      <p className="loading-detail">{takingLonger ? 'Поиск занимает чуть больше времени. Мы ещё работаем — повторять запрос не нужно.' : 'Учитываем ваши пожелания и время на прогулку.'}</p>
      <span className="loading-dots" aria-hidden="true"><i /><i /><i /></span>
    </div>
  </Sheet>;
}
