import type { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { DgisRequestBudgetError } from './dgis.js';

export type RoutingLimits = { minute: number; day: number; month: number;
  initialDay: string; initialDayUsed: number; initialMonth: string; initialMonthUsed: number };

// Shared subscription limits: Moscow midnight, monthly reset on the 20th.
export function quotaPeriods(at: Date) {
  const local = new Date(at.getTime() + 3 * 3600_000), day = local.toISOString().slice(0, 10);
  if (local.getUTCDate() < 20) local.setUTCMonth(local.getUTCMonth() - 1);
  return { day, month: `${local.toISOString().slice(0, 7)}-20` };
}

export class RoutingQuota {
  constructor(readonly pool: Pool, readonly limits: RoutingLimits,
    readonly options: { now?: () => Date; sleep?: (ms: number) => Promise<unknown>; scope?: string } = {}) {
    if (![limits.minute, limits.day, limits.month].every(n => Number.isSafeInteger(n) && n > 0) ||
        ![limits.initialDayUsed, limits.initialMonthUsed].every(n => Number.isSafeInteger(n) && n >= 0))
      throw new Error('Invalid routing quota configuration');
  }
  async reserve(objects: number): Promise<{ allowed: boolean; retryMs: number }> {
    if (!Number.isSafeInteger(objects) || objects < 1 || objects > this.limits.minute)
      return { allowed: false, retryMs: 0 };
    const client = await this.pool.connect(), scope = this.options.scope ?? '2gis-routing';
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 782010))', [scope]);
      // Read the database clock after acquiring the lock to align concurrent containers.
      const at = this.options.now?.() ?? new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now);
      const periods = quotaPeriods(at);
      for (const [kind, period, used] of [
        ['day', periods.day, !this.limits.initialDay || periods.day === this.limits.initialDay ? this.limits.initialDayUsed : 0],
        ['month', periods.month, !this.limits.initialMonth || periods.month === this.limits.initialMonth ? this.limits.initialMonthUsed : 0],
      ] as const) await client.query(`INSERT INTO routing_quota_counters(scope,kind,period,objects)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [scope, kind, period, used]);
      const counters = await client.query(`SELECT kind,objects FROM routing_quota_counters WHERE scope=$1
        AND ((kind='day' AND period=$2) OR (kind='month' AND period=$3))`, [scope, periods.day, periods.month]);
      const exhausted = counters.rows.some(row => Number(row.objects) + objects > this.limits[row.kind as 'day' | 'month']);
      await client.query('DELETE FROM routing_quota_attempts WHERE scope=$1 AND sent_at <= $2', [scope, new Date(at.getTime() - 60_000)]);
      const recent = await client.query('SELECT objects,sent_at FROM routing_quota_attempts WHERE scope=$1 ORDER BY sent_at', [scope]);
      let used = recent.rows.reduce((sum, row) => sum + Number(row.objects), 0), retryMs = 0;
      if (!exhausted && used + objects > this.limits.minute) {
        for (const row of recent.rows) {
          used -= Number(row.objects);
          if (used + objects <= this.limits.minute) { retryMs = Math.max(1, new Date(row.sent_at).getTime() + 60_001 - at.getTime()); break; }
        }
      }
      if (exhausted || retryMs) { await client.query('COMMIT'); return { allowed: false, retryMs }; }
      await client.query(`UPDATE routing_quota_counters SET objects=objects+$4 WHERE scope=$1
        AND ((kind='day' AND period=$2) OR (kind='month' AND period=$3))`, [scope, periods.day, periods.month, objects]);
      await client.query('INSERT INTO routing_quota_attempts(scope,sent_at,objects) VALUES($1,$2,$3)', [scope, at, objects]);
      await client.query('COMMIT');
      return { allowed: true, retryMs: 0 };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async consume(objects: number, remainingMs: number) {
    const deadline = performance.now() + remainingMs;
    while (true) {
      const permit = await this.reserve(objects);
      if (permit.allowed) return;
      if (!permit.retryMs || performance.now() + permit.retryMs + 5000 >= deadline)
        throw new DgisRequestBudgetError('SUBSCRIPTION_QUOTA_EXHAUSTED');
      await (this.options.sleep ?? delay)(permit.retryMs);
    }
  }
}
