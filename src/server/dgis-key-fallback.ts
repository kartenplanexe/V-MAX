// 2GIS limits are per service. A key-specific denial can also be reported as
// HTTP 200 with meta.code=403. Never rotate for malformed requests, timeouts
// or arbitrary 5xx responses.
export type DgisService = 'categories' | 'places' | 'regions' | 'routing';

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
  private readonly unavailableUntil = new Map<DgisService, number>();
  constructor(private readonly primary: string, private readonly backup: string, private readonly now = Date.now) {}

  current(service: DgisService): string {
    return this.backup && this.backup !== this.primary && (this.unavailableUntil.get(service) ?? 0) > this.now()
      ? this.backup : this.primary;
  }

  backupAfterDenial(service: DgisService, attemptedKey: string): string | null {
    if (!this.backup || this.backup === this.primary || attemptedKey !== this.primary) return null;
    // Recheck the primary periodically: the provider may restore a quota or key.
    this.unavailableUntil.set(service, this.now() + 10 * 60_000);
    return this.backup;
  }
}
