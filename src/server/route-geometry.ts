import type { Coordinates } from './dgis.js';

export type RouteLine = [number, number][];
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const POSITION = new RegExp(`^(${NUMBER})\\s+(${NUMBER})(?:\\s+(${NUMBER}))?$`, 'u');
const MAX_POINTS = 10_000;

/** Strictly parse documented WKT, preserving separate paths instead of bridging gaps. */
export function parseRouteLine(input: string): RouteLine | null {
  if (input.length > 512_000) return null;
  const match = /^LINESTRING(?:\s+Z)?\s*\(([^()]+)\)$/iu.exec(input.trim());
  if (!match) return null;
  const positions = match[1]!.split(',');
  if (positions.length < 2 || positions.length > MAX_POINTS) return null;
  const line: RouteLine = [];
  let dimensions: number | undefined;
  for (const position of positions) {
    const value = POSITION.exec(position.trim());
    if (!value) return null;
    const lon = Number(value[1]), lat = Number(value[2]), dims = value[3] === undefined ? 2 : 3;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90 ||
        (value[3] !== undefined && !Number.isFinite(Number(value[3]))) ||
        (dimensions !== undefined && dimensions !== dims)) return null;
    dimensions = dims; line.push([lon, lat]);
  }
  if (/^LINESTRING\s+Z/iu.test(input.trim()) && dimensions !== 3) return null;
  return line;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function distance(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180, dlat = (b[1] - a[1]) * rad, dlon = (b[0] - a[0]) * rad;
  const term = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dlon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, term)));
}

export function normalizeRouteGeometry(value: unknown, input: {
  from: Coordinates; to: Coordinates; distanceMeters: number;
}): RouteLine[] | null {
  const route = record(value);
  if (!route || !Number.isFinite(input.distanceMeters) || input.distanceMeters < 0) return null;
  const paths: unknown[] = [];
  if (route.begin_pedestrian_path != null) paths.push(record(route.begin_pedestrian_path)?.geometry);
  if (!Array.isArray(route.maneuvers) || route.maneuvers.length > 2000) return null;
  for (const maneuver of route.maneuvers) {
    const path = record(record(maneuver)?.outcoming_path);
    if (!path) continue; // Terminal maneuver can have no outgoing path.
    if (!Array.isArray(path.geometry) || path.geometry.length > 2000) return null;
    paths.push(...path.geometry);
  }
  if (route.end_pedestrian_path != null) paths.push(record(route.end_pedestrian_path)?.geometry);
  if (!paths.length || paths.length > 2000) return null;
  const lines: RouteLine[] = [];
  let count = 0, length = 0;
  for (const path of paths) {
    const selection = record(path)?.selection;
    const line = typeof selection === 'string' ? parseRouteLine(selection) : null;
    if (!line || (count += line.length) > MAX_POINTS) return null;
    const previous = lines.at(-1)?.at(-1);
    if (previous && distance(previous, line[0]!) > 100) return null;
    for (let index = 1; index < line.length; index++) length += distance(line[index - 1]!, line[index]!);
    lines.push(line);
  }
  // Allow provider snapping/rounding while rejecting an unrelated or incomplete path.
  if (distance([input.from.lon, input.from.lat], lines[0]![0]!) > 150 ||
      distance([input.to.lon, input.to.lat], lines.at(-1)!.at(-1)!) > 150 ||
      length < input.distanceMeters * 0.65 - 200 || length > input.distanceMeters * 1.35 + 200) return null;
  return lines;
}
