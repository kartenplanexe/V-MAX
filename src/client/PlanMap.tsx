import { load } from '@2gis/mapgl';
import { useEffect, useRef, useState } from 'react';
import type { PublicConfig } from '../shared/public-config';
import type { PlanningView } from '../shared/planning-form';

type Day = NonNullable<PlanningView['result']>['days'][number];
type MapDay = Pick<Day, 'travel_segments'> & { visits: Pick<Day['visits'][number], 'activity_id' | 'place_id' | 'point' | 'name' | 'location_label'>[] };
type Point = PlanningView['draft']['points']['origin'];
type MapGL = InstanceType<Awaited<ReturnType<typeof load>>['Map']>;
type Marker = InstanceType<Awaited<ReturnType<typeof load>>['Marker']>;
function markerIcon(index: number, selected: boolean) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="48" viewBox="0 0 40 48"><path d="M20 46C14 37 2 30 2 20a18 18 0 0 1 36 0c0 10-12 17-18 26Z" fill="${selected ? '#9500FF' : '#471AFF'}" stroke="white" stroke-width="3"/><text x="20" y="26" fill="white" font-family="sans-serif" font-size="17" font-weight="700" text-anchor="middle">${index + 1}</text></svg>`;
  return { icon: `data:image/svg+xml,${encodeURIComponent(svg)}`, size: [40, 48], anchor: [20, 46] };
}

export function PlanMap({ day, origin, destination, activeVisitIndex, onSelectVisit, placesOnly = false }: {
  day: MapDay; origin?: Point; destination?: Point; activeVisitIndex?: number; onSelectVisit?: (index: number) => void; placesOnly?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null), mapRef = useRef<MapGL | null>(null);
  const markers = useRef(new Map<number, Marker>()), select = useRef(onSelectVisit);
  const [status, setStatus] = useState('Загружаем карту…'), [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0), [loaded, setLoaded] = useState(0);
  select.current = onSelectVisit;
  useEffect(() => {
    let cancelled = false, expired = false, mapError = false;
    const resources: { destroy(): void }[] = [], timers: ReturnType<typeof setTimeout>[] = [];
    const controller = new AbortController();
    setFailed(false); setStatus('Загружаем карту…');
    function fail(message: string) { if (!cancelled) { setFailed(true); setStatus(message); } }
    void (async () => {
      try {
        const points = [...(origin ? [origin] : []), ...day.visits.flatMap(v => v.point ? [v.point] : []), ...(destination ? [destination] : [])];
        if (!points.length) { fail('У мест нет координат для карты. План доступен списком.'); return; }
        timers.push(setTimeout(() => controller.abort(), 10000));
        const response = await fetch('/api/public-config', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error();
        const config: PublicConfig = await response.json();
        if (!config.maps.enabled || !config.maps.mapglKey) { fail('Карта пока недоступна. Адреса и порядок остановок — в списке ниже.'); return; }
        const sdk = await Promise.race([load('https://mapgl.2gis.com/api/js/v1'),
          new Promise<never>((_, reject) => timers.push(setTimeout(() => reject(new Error()), 12000)))]);
        if (cancelled || !element.current) return;
        if (!sdk.isSupported()) { fail('Этот браузер не поддерживает карту. Остановки можно просмотреть списком.'); return; }
        const center = points[0]!;
        const map = new sdk.Map(element.current, { center: [center.lon, center.lat], zoom: 13,
          key: config.maps.mapglKey, enableTrackResize: true, enableTwoFingerDragging: true,
          disableZoomOnScroll: true, controlsLayoutPadding: { top: 12, right: 12, bottom: 12, left: 12 },
          copyright: 'bottomRight' });
        resources.push(map); mapRef.current = map;
        const lines = (placesOnly ? [] : day.travel_segments ?? []).filter(segment => segment.coordinates.length && Date.parse(segment.source.valid_until) > Date.now());
        const geometry = lines.flatMap(segment => segment.coordinates.flat());
        const lon = [...points.map(p => p.lon), ...geometry.map(p => p[0])], lat = [...points.map(p => p.lat), ...geometry.map(p => p[1])];
        map.fitBounds({ southWest: [Math.min(...lon) - .001, Math.min(...lat) - .001],
          northEast: [Math.max(...lon) + .001, Math.max(...lat) + .001] },
        { padding: { top: 50, bottom: 65, left: 50, right: 50 } });
        const pathResources: { destroy(): void }[] = [];
        for (const segment of lines) for (const coordinates of segment.coordinates) {
          const path = new sdk.Polyline(map, { coordinates, color: '#471AFF', width: 5, zIndex: 1 });
          pathResources.push(path); resources.push(path);
        }
        const missing = lines.length < day.visits.length + (destination ? 1 : 0);
        const readyMessage = placesOnly ? 'Нажмите на точку, чтобы увидеть название места.' : lines.length
          ? `Линии показывают рассчитанный путь.${missing ? ' Часть переходов доступна только в списке.' : ''} Время в пути ориентировочное.`
          : 'Показаны остановки. Линия пути недоступна — время и порядок есть в списке.';
        const firstExpiry = Math.min(...lines.map(segment => Date.parse(segment.source.valid_until)));
        if (Number.isFinite(firstExpiry)) timers.push(setTimeout(() => {
          if (cancelled) return;
          expired = true;
          for (const path of pathResources) { path.destroy(); resources.splice(resources.indexOf(path), 1); }
          setStatus('Расчёт пути устарел. Пересчитайте маршрут, чтобы обновить линии и время.');
        }, Math.max(0, firstExpiry - Date.now())));
        const loadingTimer = setTimeout(() => fail('Карта загружается дольше обычного. Можно повторить попытку или использовать список.'), 15000);
        timers.push(loadingTimer);
        map.on('idle', () => { clearTimeout(loadingTimer); if (!cancelled && !expired && !mapError) { setFailed(false); setStatus(readyMessage); } });
        map.on('error', () => { mapError = true; clearTimeout(loadingTimer); fail('Не удалось загрузить карту. План доступен списком.'); });
        if (origin) resources.push(new sdk.Marker(map, { coordinates: [origin.lon, origin.lat], label: { text: 'Старт' } }));
        if (destination) resources.push(new sdk.Marker(map, { coordinates: [destination.lon, destination.lat], label: { text: 'Финиш' } }));
        day.visits.forEach((visit, index) => {
          if (!visit.point) return;
          const marker = new sdk.Marker(map, { coordinates: [visit.point.lon, visit.point.lat], ...markerIcon(index, false) });
          marker.on('click', () => select.current?.(index)); markers.current.set(index, marker); resources.push(marker);
        });
        setLoaded(value => value + 1);
      } catch { fail('Не удалось загрузить карту. Проверьте соединение или откройте план списком.'); }
    })();
    return () => {
      cancelled = true; controller.abort(); timers.forEach(clearTimeout); mapRef.current = null; markers.current.clear();
      resources.reverse().forEach(resource => resource.destroy());
    };
  }, [day, origin, destination, retry, placesOnly]);
  useEffect(() => {
    for (const [index, marker] of markers.current) marker.setIcon(markerIcon(index, index === activeVisitIndex));
    const point = activeVisitIndex === undefined ? undefined : day.visits[activeVisitIndex]?.point;
    if (point) mapRef.current?.setCenter([point.lon, point.lat], { duration: 0 });
  }, [activeVisitIndex, day, loaded]);
  return <section className="plan-map" aria-label={placesOnly ? 'Места на карте 2ГИС' : 'Маршрут на карте 2ГИС'}>
    <div className="plan-map-canvas" ref={element} aria-label="Карта с номерами остановок" />
    <div className="map-status"><p className="field-hint" role="status">{status}</p>
      {failed && <button type="button" className="button-secondary" onClick={() => setRetry(value => value + 1)}>Повторить загрузку карты</button>}</div>
    {!placesOnly && <ol className="map-places">{origin && <li key="origin">Старт: {origin.label ?? 'выбранная точка'}</li>}
      {day.visits.map((visit, index) => <li key={`${visit.activity_id}:${visit.place_id}`}>
        <button type="button" aria-pressed={index === activeVisitIndex} onClick={() => onSelectVisit?.(index)}>
          <span className="map-stop-number">{index + 1}</span><span>{visit.name}{visit.location_label && <small>{visit.location_label}</small>}</span>
        </button></li>)}
      {destination && <li key="destination">Финиш: {destination.label ?? 'выбранная точка'}</li>}</ol>}
  </section>;
}
