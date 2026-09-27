import type { PlanningView } from './planning-form.js';

type Segment = NonNullable<NonNullable<PlanningView['result']>['days'][number]['travel_segments']>[number];
type Stage = NonNullable<Segment['transit']>['stages'][number];
const transportNames: Record<string, string> = {
  metro: 'Метро', light_metro: 'Лёгкое метро', suburban_train: 'Электричка', aeroexpress: 'Аэроэкспресс',
  tram: 'Трамвай', bus: 'Автобус', trolleybus: 'Троллейбус', shuttle_bus: 'Маршрутное такси',
  monorail: 'Монорельс', funicular_railway: 'Фуникулёр', river_transport: 'Речной транспорт',
  cable_car: 'Канатная дорога', light_rail: 'Лёгкий рельсовый транспорт', premetro: 'Скоростной трамвай', mcc: 'МЦК', mcd: 'МЦД',
};
export function mobilityText(mode: unknown): string {
  return mode === 'walking' ? 'Пешком' : mode === 'driving' ? 'На машине' : mode === 'cycling' ? 'На велосипеде'
    : mode === 'public_transport' ? 'Общественный транспорт с пешими участками' : 'Передвижение не указано';
}
const label = (text: string) => text.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
export function transitStageText(stage: Stage): string {
  if (stage.kind === 'walkway') return `Пешком${stage.stop ? ` · ${label(stage.stop)}` : ''}`;
  const variants = stage.routes?.length ? stage.routes : [{ transport: stage.transport, names: stage.names }];
  const text = variants.map(route => `${route.transport ? transportNames[route.transport] ?? 'ОТ' : 'ОТ'}${route.names.length ? ` ${route.names.map(label).join(', ')}` : ''}`).join(' / ');
  return `${variants.length > 1 ? 'Варианты: ' : ''}${text}${stage.stop ? ` · остановка ${label(stage.stop)}` : ''}`;
}
