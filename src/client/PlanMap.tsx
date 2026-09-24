import { load } from '@2gis/mapgl';
import { useEffect, useRef, useState } from 'react';
import type { PublicConfig } from '../shared/public-config';
import type { PlanningView } from '../shared/planning-form';

type Day = NonNullable<PlanningView['result']>['days'][number];
/** Only provider coordinates. Routing durations are not a polyline: never draw guessed connections. */
export function PlanMap({ day }: { day: Day }) {
  const element = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Загружаем карту…');
  useEffect(() => {
    let cancelled = false;
    const resources: { destroy(): void }[] = [];
    void (async () => {
      try {
        const points = day.visits.flatMap(v => v.point ? [v.point] : []);
        if (!points.length) { setStatus('Нет координат для отображения. Откройте план списком.'); return; }
        const response = await fetch('/api/public-config', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error();
        const config: PublicConfig = await response.json();
        if (!config.maps.enabled || !config.maps.mapglKey) throw new Error();
        const sdk = await load('https://mapgl.2gis.com/api/js/v1');
        if (cancelled || !element.current) return;
        const center = points[0]!;
        const map = new sdk.Map(element.current, { center: [center.lon, center.lat], zoom: 13,
          key: config.maps.mapglKey, enableTrackResize: true });
        resources.push(map);
        const lon = points.map(p => p.lon), lat = points.map(p => p.lat);
        map.fitBounds({ southWest: [Math.min(...lon) - .002, Math.min(...lat) - .002], northEast: [Math.max(...lon) + .002, Math.max(...lat) + .002] }, { padding: { top: 40, bottom: 40, left: 40, right: 40 } });
        day.visits.forEach((visit, index) => {
          if (!visit.point) return;
          const marker = new sdk.Marker(map, { coordinates: [visit.point.lon, visit.point.lat],
            label: { text: String(index + 1) } });
          resources.push(marker);
        });
        setStatus('Номера на карте соответствуют порядку посещений. Линия пути пока не отображается.');
      } catch { if (!cancelled) setStatus('Карта недоступна. Места и время остаются в плане списком.'); }
    })();
    return () => { cancelled = true; resources.reverse().forEach(r => r.destroy()); };
  }, [day]);
  return <section aria-label="Места на карте 2ГИС"><div className="plan-map-canvas" ref={element} />
    <p className="field-hint" role="status">{status}</p>
    <ol className="map-places">{day.visits.map(v => <li key={v.activity_id}>{v.name}</li>)}</ol>
  </section>;
}
