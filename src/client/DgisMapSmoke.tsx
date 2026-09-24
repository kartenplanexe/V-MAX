import { load } from '@2gis/mapgl';
import { useEffect, useRef, useState } from 'react';

import type { PublicConfig } from '../shared/public-config';

type SmokeState = 'loading' | 'ready' | 'unavailable' | 'failed';

export function DgisMapSmoke() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<SmokeState>('loading');

  useEffect(() => {
    const controller = new AbortController();
    let map: { destroy(): void } | undefined;
    let marker: { destroy(): void } | undefined;

    async function initialize() {
      try {
        const response = await fetch('/api/public-config', {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Public config is unavailable.');

        const publicConfig = (await response.json()) as PublicConfig;
        if (!publicConfig.maps.enabled || !publicConfig.maps.mapglKey || !containerRef.current) {
          setState('unavailable');
          return;
        }

        const mapgl = await load('https://mapgl.2gis.com/api/js/v1');
        if (controller.signal.aborted || !containerRef.current) return;

        const nextMap = new mapgl.Map(containerRef.current, {
          center: [44.005986, 56.326887],
          enableTrackResize: true,
          key: publicConfig.maps.mapglKey,
          zoom: 12,
        });
        map = nextMap;
        marker = new mapgl.Marker(nextMap, {
          coordinates: [44.005986, 56.326887],
        });
        setState('ready');
      } catch (error) {
        if (!controller.signal.aborted) setState('failed');
      }
    }

    void initialize();
    return () => {
      controller.abort();
      marker?.destroy();
      map?.destroy();
    };
  }, []);

  return (
    <main className="map-smoke">
      <div ref={containerRef} className="map-smoke__canvas" />
      {state !== 'ready' && (
        <div className="map-smoke__status" role="status">
          {state === 'loading' && 'Загружаем карту…'}
          {state === 'unavailable' && 'Карта пока не настроена.'}
          {state === 'failed' && 'Не удалось загрузить карту.'}
        </div>
      )}
    </main>
  );
}
