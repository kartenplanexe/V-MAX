// 2GIS limits are per service. A key-specific denial can also be reported as
// HTTP 200 with meta.code=403. Never rotate for malformed requests, timeouts
// or arbitrary 5xx responses.
export type DgisService = 'categories' | 'places' | 'regions' | 'routing' | 'public_transport';

export function shouldTryDgisBackup(httpStatus: number, body: unknown): boolean {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const meta = value.meta && typeof value.meta === 'object' ? value.meta as Record<string, unknown> : {};
  const code = typeof meta.code === 'number' ? meta.code : httpStatus;
  // 402 = quota/payment and 403 = key-specific access denial. Trying the
  // independently configured backup once is safe even when 2GIS omits the
  // human-readable error detail; a repeated denial is returned as a failure.
  return [402, 403, 429].includes(code) || [402, 403, 429].includes(httpStatus);
}

export class DgisKeyFallback {
  private readonly unavailableUntil = new Map<DgisService, Map<string, number>>();
  private readonly keys: string[];
  constructor(primary: string, backups: readonly string[], private readonly now = Date.now) {
    this.keys = [...new Set([primary, ...backups].map(key => key.trim()).filter(Boolean))];
  }

  current(service: DgisService): string | null {
    const denied = this.unavailableUntil.get(service);
    return this.keys.find(key => (denied?.get(key) ?? 0) <= this.now()) ?? null;
  }

  role(key: string): 'primary' | 'backup_1' | 'backup_2' | 'unknown' {
    const index = this.keys.indexOf(key);
    return index === 0 ? 'primary' : index === 1 ? 'backup_1' : index === 2 ? 'backup_2' : 'unknown';
  }

  backupAfterDenial(service: DgisService, attemptedKey: string): string | null {
    if (!this.keys.includes(attemptedKey)) return null;
    const denied = this.unavailableUntil.get(service) ?? new Map<string, number>();
    // Recheck each key periodically: its service quota or access may be restored.
    denied.set(attemptedKey, this.now() + 10 * 60_000);
    this.unavailableUntil.set(service, denied);
    return this.current(service);
  }
}
