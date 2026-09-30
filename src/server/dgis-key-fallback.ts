export type DgisService = 'categories' | 'places' | 'regions' | 'routing' | 'public_transport';

export function shouldTryDgisBackup(httpStatus: number, body: unknown): boolean {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const meta = value.meta && typeof value.meta === 'object' ? value.meta as Record<string, unknown> : {};
  const code = typeof meta.code === 'number' ? meta.code : httpStatus;

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

    denied.set(attemptedKey, this.now() + 10 * 60_000);
    this.unavailableUntil.set(service, denied);
    return this.current(service);
  }
}
