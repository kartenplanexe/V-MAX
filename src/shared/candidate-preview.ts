import type { z } from 'zod';
import type { CandidatePlace } from './candidate-preview-schema.js';
export const candidatePreviewNotice = 'Это варианты для ваших пожеланий. Порядок посещения, время в пути и выполнимость общего плана по времени и бюджету ещё не проверены.';

export function candidateSourceLink(source: z.infer<typeof CandidatePlace>['source']): string | null {
  if (!source.url) return null;
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    if (source.provider === '2gis' && url.hostname === '2gis.ru' && /^\/[a-z0-9_-]{1,80}\/(?:firm|geo)\/[0-9]{1,30}$/u.test(url.pathname)) return url.href;
    if (source.provider === 'kudago' && url.hostname === 'kudago.com' && /^\/[a-z0-9-]+\/event\/[a-z0-9_-]+\/$/u.test(url.pathname)) return url.href;
  } catch { /* Provider links are untrusted. */ }
  return null;
}
