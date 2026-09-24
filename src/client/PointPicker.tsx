import { load } from '@2gis/mapgl';
import { useEffect, useRef, useState } from 'react';
import type { PublicConfig } from '../shared/public-config';

export function PointPicker({ center, onSelect, onClose }: {
  center: { lat: number; lon: number }; onSelect: (point: { lat: number; lon: number }) => void; onClose: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [status, setStatus] = useState('Загружаем карту…');
  useEffect(() => {
    let cancelled = false, map: { destroy(): void } | undefined, marker: { destroy(): void } | undefined;
    void (async () => {
      try {
        const response = await fetch('/api/public-config', { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const config: PublicConfig = await response.json();
        if (!config.maps.enabled || !config.maps.mapglKey) { setStatus('Карта сейчас недоступна. Можно выбрать текущее местоположение.'); return; }
        const sdk = await load('https://mapgl.2gis.com/api/js/v1');
        if (cancelled || !element.current) return;
        const next = new sdk.Map(element.current, { center: [center.lon, center.lat], zoom: 13, key: config.maps.mapglKey, enableTrackResize: true });
        map = next;
        next.on('click', event => {
          const [lon, lat] = event.lngLat; if (lon == null || lat == null) return;
          marker?.destroy(); marker = new sdk.Marker(next, { coordinates: [lon, lat] }); setPoint({ lat, lon });
        });
        setStatus('Нажмите на место, откуда хотите начать.');
      } catch { if (!cancelled) setStatus('Не удалось загрузить карту. Проверьте подключение или выберите местоположение.'); }
    })();
    return () => { cancelled = true; marker?.destroy(); map?.destroy(); };
  }, [center.lat, center.lon]);
  return <section className="point-picker" aria-label="Выбор точки на карте">
    <p role="status">{status}</p><div ref={element} className="point-picker-canvas" />
    <button type="button" className="primary-button" disabled={!point} onClick={() => { if (point) onSelect(point); }}>Начать отсюда</button>
    <button type="button" className="text-button" onClick={onClose}>Закрыть карту</button>
  </section>;
}
