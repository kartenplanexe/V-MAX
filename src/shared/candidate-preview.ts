import type { z } from 'zod';
import type { CandidatePlace } from './candidate-preview-schema.js';
export const candidatePreviewNotice = 'Это варианты мест, а не готовый маршрут. Время дороги уточните в 2ГИС.';
export const compactPlacesNotice = 'Перед выходом проверьте время в пути, часы работы и цены в 2ГИС.';
export function selectionGapNotice(reason?: 'NO_ELIGIBLE_PLACES' | 'COMBINATION_NOT_FOUND') {
  return reason === 'NO_ELIGIBLE_PLACES' ? 'В текущем поиске нет подходящих мест. Попробуйте изменить условия или область поиска.'
    : reason === 'COMBINATION_NOT_FOUND' ? 'Не удалось совместить с другими занятиями при этих условиях. Попробуйте увеличить время или изменить ограничения.'
      : 'Не вошло в подборку при текущих условиях.';
}

export function candidateSourceLink(source: z.infer<typeof CandidatePlace>['source']): string | null {
  if (!source.url) return null;
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    if (source.provider === '2gis' && url.hostname === '2gis.ru' && /^\/[a-z0-9_-]{1,80}\/(?:firm|geo)\/[0-9]{1,30}$/u.test(url.pathname)) return url.href;
    if (source.provider === 'kudago' && url.hostname === 'kudago.com' && /^\/[a-z0-9-]+\/event\/[a-z0-9_-]+\/$/u.test(url.pathname)) return url.href;
  } catch { /* Ignore malformed provider URLs. */ }
  return null;
}
