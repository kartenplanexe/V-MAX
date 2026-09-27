import { load } from '@2gis/mapgl';
import { useEffect, useRef, useState } from 'react';
import type { PublicConfig } from '../shared/public-config';
import { Action } from './PlannerUi';

export function PointPicker({ center, onSelect, onClose }: {
  center: { lat: number; lon: number }; onSelect: (point: { lat: number; lon: number }) => void; onClose: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [status, setStatus] = useState('Загружаем карту…');
  const [retry, setRetry] = useState(0), [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false, mapError = false, map: { destroy(): void } | undefined, marker: { destroy(): void } | undefined;
    const controller = new AbortController(), timers: ReturnType<typeof setTimeout>[] = [];
    setPoint(null); setFailed(false); setStatus('Загружаем карту…');
    const fail = (message: string) => { if (!cancelled) { setStatus(message); setFailed(true); setPoint(null); } };
    void (async () => {
      try {
        timers.push(setTimeout(() => controller.abort(), 10000));
        const response = await fetch('/api/public-config', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error();
        const config: PublicConfig = await response.json();
        if (!config.maps.enabled || !config.maps.mapglKey) { fail('Карта сейчас недоступна. Закройте её и выберите адрес или местоположение.'); return; }
        const sdk = await Promise.race([load('https://mapgl.2gis.com/api/js/v1'),
          new Promise<never>((_, reject) => timers.push(setTimeout(() => reject(new Error()), 12000)))]);
        if (cancelled || !element.current) return;
        if (!sdk.isSupported()) { fail('Браузер не поддерживает карту. Можно указать адрес в форме.'); return; }
        const next = new sdk.Map(element.current, { center: [center.lon, center.lat], zoom: 13, key: config.maps.mapglKey,
          enableTrackResize: true, enableTwoFingerDragging: true, disableZoomOnScroll: true, copyright: 'bottomRight' });
        map = next;
        const loadingTimer = setTimeout(() => fail('Карта загружается дольше обычного. Повторите попытку или выберите адрес.'), 15000);
        timers.push(loadingTimer);
        next.on('idle', () => { clearTimeout(loadingTimer); if (!cancelled && !mapError) { setFailed(false); setStatus('Нажмите на нужную точку и подтвердите выбор.'); } });
        next.on('error', () => { mapError = true; clearTimeout(loadingTimer); fail('Не удалось загрузить карту. Можно выбрать адрес в форме.'); });
        next.on('click', event => {
          if (mapError || cancelled) return;
          const [lon, lat] = event.lngLat; if (lon == null || lat == null) return;
          marker?.destroy(); marker = new sdk.Marker(next, { coordinates: [lon, lat] }); setPoint({ lat, lon }); setFailed(false);
        });
      } catch { fail('Не удалось загрузить карту. Проверьте подключение или выберите адрес в форме.'); }
    })();
    return () => { cancelled = true; controller.abort(); timers.forEach(clearTimeout); marker?.destroy(); map?.destroy(); };
  }, [center.lat, center.lon, retry]);
  return <section className="point-picker" aria-label="Выбор точки на карте">
    <p role="status">{status}</p><div ref={element} className="point-picker-canvas" />
    {failed && <Action variant="secondary" onClick={() => setRetry(value => value + 1)}>Повторить загрузку</Action>}
    <Action stretched disabled={!point || failed} onClick={() => { if (point) onSelect(point); }}>Выбрать точку</Action>
    <Action variant="ghost" stretched onClick={onClose}>Закрыть карту</Action>
  </section>;
}
