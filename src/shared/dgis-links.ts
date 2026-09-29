import type { PlanningView } from './planning-form.js';

type Point = { lat: number; lon: number };
const modes: Record<string, string> = { walking: 'pedestrian', driving: 'car', cycling: 'bicycle', public_transport: 'bus' };
const valid = (point: Point) => Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;
export function dgisDirectionsLink(to: Point | undefined, mode = 'walking', from?: Point): string | null {
  if (!to || !valid(to) || !Object.hasOwn(modes, mode) || (from && !valid(from))) return null;
  const coordinates = (point: Point) => `${point.lon},${point.lat}`;
  return `https://2gis.ru/directions/tab/${modes[mode]}/points/${from ? coordinates(from) : ''}|${coordinates(to)}`;
}

export function dgisMultiStopLink(stops: readonly (Point | undefined)[], mode = 'walking', from?: Point, finish?: Point): string | null {
  if (!stops.length || stops.length + (finish ? 1 : 0) > 11 || !Object.hasOwn(modes, mode)
    || stops.some(point => !point || !valid(point)) || (from && !valid(from)) || (finish && !valid(finish))) return null;
  const coordinates = (point: Point) => `${point.lon},${point.lat}`;
  return `https://2gis.ru/directions/tab/${modes[mode]}/points/${[
    from ? coordinates(from) : '', ...stops.map(point => coordinates(point!)), ...(finish ? [coordinates(finish)] : []),
  ].join('|')}`;
}

export function dgisDayDirectionsLink(view: PlanningView, dayId: string | undefined): string | null {
  const result = view.result;
  if (!result?.selection_policy || !result.candidate_preview || !view.draft.days.some(day => day.day_id === dayId)) return null;
  const places = [...new Map(result.candidate_preview.groups.filter(group => group.day_id === dayId)
    .flatMap(group => group.places.map(place => [place.place_id, place] as const))).values()];
  return dgisMultiStopLink(places.map(place => place.point), view.draft.shared.mobility?.[0],
    view.draft.points.origin, view.draft.points.destination);
}
