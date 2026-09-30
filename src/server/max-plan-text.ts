import type { PlanningView } from '../shared/planning-form.js';
import { mobilityText, transitStageText } from '../shared/route-travel-text.js';
import { kudagoEventUrl } from '../shared/kudago-url.js';
export { eventGapText } from '../shared/event-plan-text.js';

type Plan = NonNullable<PlanningView['result']>;
type Segment = NonNullable<Plan['days'][number]['travel_segments']>[number];
type Visit = Plan['days'][number]['visits'][number];

export function eventVisitText(visit: Visit, timezone: string): string[] {
  if (!visit.event) return [];
  const event = visit.event, lines: string[] = [];
  if (event.schedule_kind === 'fixed') {
    if (event.official_start_utc !== undefined && event.official_end_utc !== undefined) {
      const format = (at: number) => {
        try { return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: timezone }).format(new Date(at * 1000)); }
        catch { return `${new Date(at * 1000).toISOString()} (UTC)`; }
      };
      lines.push(`Сеанс по данным KudaGo: ${format(event.official_start_utc)}–${format(event.official_end_utc)}.`);
    } else lines.push('Выбран фиксированный сеанс; официальное время в данных не указано.');
  } else lines.push(`Посещение ≈${visit.ends_at - visit.starts_at} мин — длительность, выбранная вами.`);
  lines.push(event.minimum_age === null ? 'Возрастное ограничение неизвестно.' : `Возраст: ${event.minimum_age}+.`);
  lines.push(visit.price_expected_minor === 0 ? 'Вход бесплатный по данным источника.' : visit.price_expected_minor != null
    ? `На билеты для вашей группы: до ${visit.price_expected_minor / 100} ₽ по данным афиши.` : 'Стоимость входа неизвестна.');
  if (visit.source?.provider === 'kudago' && visit.source.url) {
    try {
      const url = new URL(visit.source.url);
      if (kudagoEventUrl(url.href)) lines.push(`Событие на KudaGo: ${url.href}`);
    } catch {                                                 }
  }
  return lines;
}

export function evidenceTime(instant: string | number, timezone: string): string | null {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try { return `${new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: timezone }).format(date)} (${timezone})`; }
  catch { return `${new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: 'UTC' }).format(date)} (UTC; часовой пояс города неизвестен)`; }
}
export function placeSourceLink(source: Plan['days'][number]['visits'][number]['source']): string | null {
  if (source?.provider !== '2gis' || !source.url) return null;
  try {
    const url = new URL(source.url);
    return url.protocol === 'https:' && url.hostname === '2gis.ru' && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^\/[a-z0-9_-]{1,80}\/(?:firm|geo)\/[0-9]{1,30}$/u.test(url.pathname) ? url.href : null;
  } catch { return null; }
}
export function planDataEvidence(plan: Plan, timezone: string): string[] {
  const lines = new Set<string>();
  const add = (kind: string, source: Segment['source']) => {
    const provider = source.provider === '2gis' ? '2ГИС' : source.provider === 'kudago' ? 'KudaGo' : 'Внешний источник';
    const at = evidenceTime(source.fetched_at, timezone);
    lines.add(`${kind}: ${provider} · ${at ? `получены ${at}` : 'время получения неизвестно'}.`);
  };
  for (const day of plan.days) {
    for (const visit of day.visits) if (visit.source) add(visit.event ? 'Данные событий' : 'Данные мест', visit.source);
    for (const segment of day.travel_segments ?? []) add('Данные переходов', segment.source);
  }
  const until = plan.valid_until && evidenceTime(plan.valid_until, timezone);
  if (plan.candidate_preview) lines.add('Подборка сохранена. Перед выходом обновите места, если данные могли измениться.');
  else if (until) lines.add(`Срок результата в приложении: до ${until}; затем нужен новый расчёт.`);
  return [...lines];
}
export function travelSegmentText(segment: Segment | undefined, timezone: string): string[] {
  if (!segment) return [];
  const departure = evidenceTime(segment.departure_utc * 1000, timezone);
  const transit = segment.transit;
  const lines = [`${transit?.pedestrian ? 'Пешком (вариант для режима ОТ)' : mobilityText(segment.mode)}${departure ? ` · расчётное отправление ${departure}` : ''}.`];
  if (!transit) return lines;
  for (const stage of transit.stages) lines.push(`• ${transitStageText(stage)}`);
  if (!transit.pedestrian) {
    lines.push(transit.waitingSeconds === null ? 'Отдельная оценка ожидания неизвестна.'
      : `Ожидание ≈${Math.ceil(transit.waitingSeconds / 60)} мин уже входит во время в пути.`);
    if (transit.transferCount || transit.crossingCount)
      lines.push(`Пересадки: внутри платформы ${transit.transferCount}, со сменой платформы ${transit.crossingCount}.`);
  }
  return lines;
}

export function splitMaxText(text: string): string[] {
  const output: string[] = []; let chunk = '';
  for (let line of text.split('\n')) {
    if (chunk && chunk.length + 1 + line.length > 3800) { output.push(chunk); chunk = ''; }
    while (line.length > 3800) {
      const size = /[\uD800-\uDBFF]/u.test(line[3799]!) ? 3799 : 3800;
      output.push(line.slice(0, size)); line = line.slice(size);
    }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) output.push(chunk);
  return output;
}
