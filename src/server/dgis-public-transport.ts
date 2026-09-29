import { z } from 'zod';
import type { Coordinates } from './dgis.js';
import { normalizeRouteGeometry } from './route-geometry.js';

const Seconds = z.number().int().nonnegative().max(604_800);
const Movement = z.object({ type: z.enum(['walkway', 'passage']),
  moving_duration: Seconds.nullable().optional(), waiting_duration: Seconds.nullable().optional(),
  routes: z.array(z.object({ names: z.array(z.string().max(500)).max(30), subtype: z.string().max(80) })).max(30).nullable().optional(),
  waypoint: z.object({ name: z.string().max(500).optional(), subtype: z.string().max(80).optional() }).optional(),
  alternatives: z.array(z.object({ geometry: z.array(z.object({ selection: z.string().max(512_000) })).max(2000).optional() })).max(30).optional(),
});
const Route = z.object({ total_duration: Seconds, total_distance: z.number().int().nonnegative().max(1_000_000),
  pedestrian: z.boolean(), transfer_count: z.number().int().nonnegative().max(100),
  crossing_count: z.number().int().nonnegative().max(100), movements: z.array(Movement).min(1).max(100),
  schedules: z.array(z.object({ origin_from: z.string().optional(), type: z.string().optional() })).max(100).nullable().optional(),
});
export type TransitEvidence = { pedestrian: boolean; waitingSeconds: number | null; transferCount: number;
  crossingCount: number; scheduleEvidence: 'predicted' | 'provided' | 'unknown'; stages: {
    kind: 'walkway' | 'passage'; transport: string | null; names: string[]; stop: string | null;
    routes?: { transport: string | null; names: string[] }[];
    movingSeconds: number | null; waitingSeconds: number | null;
  }[] };

/** Explicitly dated, scheduled public transport. Walking approaches are included. */
export function publicTransportRequest(from: Coordinates, to: Coordinates, departureUtc: number) {
  return { source: { point: from }, target: { point: to }, start_time: departureUtc, enable_schedule: true,
    transport: ['pedestrian', 'metro', 'light_metro', 'suburban_train', 'aeroexpress', 'tram', 'bus', 'trolleybus',
      'shuttle_bus', 'monorail', 'funicular_railway', 'river_transport', 'cable_car', 'light_rail', 'premetro', 'mcc', 'mcd'],
    max_result_count: 3, locale: 'ru' };
}
export function normalizePublicTransport(value: unknown, input: { from: Coordinates; to: Coordinates }) {
  if (value === null) return null; // Documented HTTP 204, represented by the transport layer.
  const routes = z.array(Route).max(30).parse(value);
  if (!routes.length) return null;
  const route = routes.toSorted((a, b) => a.total_duration - b.total_duration ||
    a.transfer_count + a.crossing_count - b.transfer_count - b.crossing_count || a.total_distance - b.total_distance)[0]!;
  const waiting = route.movements.map(item => item.waiting_duration ?? null);
  const waitingSeconds = waiting.every(value => value !== null) ? waiting.reduce<number>((sum, value) => sum + value!, 0) : null;
  const knownDuration = route.movements.reduce((sum, movement) =>
    sum + (movement.moving_duration ?? 0) + (movement.waiting_duration ?? 0), 0);
  if (knownDuration > route.total_duration ||
      route.pedestrian && route.movements.some(movement => movement.type === 'passage'))
    throw Error('Invalid public transport duration or mode.');
  const transit: TransitEvidence = { pedestrian: route.pedestrian, waitingSeconds,
    transferCount: route.transfer_count, crossingCount: route.crossing_count,
    scheduleEvidence: route.schedules?.some(schedule => schedule.origin_from === 'eta') ? 'predicted'
      : route.schedules?.length ? 'provided' : 'unknown',
    stages: route.movements.map(movement => {
      const routes = (movement.routes ?? []).map(row => ({ transport: row.subtype,
        names: [...new Set(row.names.map(name => name.slice(0, 200)))].slice(0, 30) }));
      const types = [...new Set(routes.map(row => row.transport))];
      return { kind: movement.type, transport: types.length ? types.length === 1 ? types[0]! : null : movement.waypoint?.subtype ?? null,
        names: [...new Set(routes.flatMap(row => row.names))].slice(0, 30), routes,
        stop: movement.waypoint?.name?.slice(0, 300) ?? null,
        movingSeconds: movement.moving_duration ?? null, waitingSeconds: movement.waiting_duration ?? null };
    }) };
  // Use one coherent geometry alternative per movement; never join route variants.
  const geometry = normalizeRouteGeometry({ maneuvers: route.movements.filter(movement =>
    movement.alternatives?.length || (movement.moving_duration ?? 0) > 0).map(movement => ({
      outcoming_path: { geometry: movement.alternatives?.[0]?.geometry } })) },
  { ...input, distanceMeters: route.total_distance });
  return { durationSeconds: route.total_duration, distanceMeters: route.total_distance, geometry, transit };
}
