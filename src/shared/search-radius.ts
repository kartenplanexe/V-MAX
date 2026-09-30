export const MIN_SEARCH_RADIUS_METERS = 1;
export const MAX_SEARCH_RADIUS_METERS = 50_000;
export const DEFAULT_SEARCH_RADIUS_METERS = 5000;

export function defaultSearchRadiusMeters(mobility?: readonly string[]): number {
  if (mobility?.includes('cycling')) return 10_000;
  if (mobility?.includes('public_transport') || mobility?.includes('taxi')) return 30_000;
  if (mobility?.includes('driving')) return 50_000;
  return DEFAULT_SEARCH_RADIUS_METERS;
}
