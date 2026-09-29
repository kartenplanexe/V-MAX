import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PlanningDatabase } from './planning-database.js';
import { RoutingQuota, quotaPeriods } from './routing-quota.js';
const url = process.env.TEST_DATABASE_URL;
const db = url ? PlanningDatabase.connect(url) : null;
const scope = `quota-test-${randomUUID()}`;
let instant = new Date('2026-09-29T20:59:00Z');
const limits = { minute: 5, day: 50, month: 1000, initialDay: '2026-09-29', initialDayUsed: 45,
  initialMonth: '2026-09-20', initialMonthUsed: 900 };
const quota = () => new RoutingQuota(db!.pool, limits, { now: () => instant, scope });
beforeAll(async () => { await db?.migrate(); });
afterAll(async () => {
  if (db) { await db.pool.query('DELETE FROM routing_quota_attempts WHERE scope=$1', [scope]);
    await db.pool.query('DELETE FROM routing_quota_counters WHERE scope=$1', [scope]); await db.pool.end(); }
});
it('uses Moscow midnight and the provider monthly cycle', () => {
  expect(quotaPeriods(new Date('2026-09-19T20:59:59Z'))).toEqual({ day: '2026-09-19', month: '2026-08-20' });
  expect(quotaPeriods(new Date('2026-09-19T21:00:00Z'))).toEqual({ day: '2026-09-20', month: '2026-09-20' });
});
it.skipIf(!db)('serializes physical allowances across instances and retains counters after reconstruction', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => quota().reserve(1)));
  expect(results.filter(result => result.allowed)).toHaveLength(5);
  expect(await quota().reserve(1)).toEqual({ allowed: false, retryMs: 0 });
  instant = new Date('2026-09-29T21:00:01Z');
  expect(await quota().reserve(5)).toEqual({ allowed: true, retryMs: 0 });
  const blocked = await quota().reserve(1); expect(blocked.allowed).toBe(false); expect(blocked.retryMs).toBeGreaterThan(0);
  instant = new Date('2026-09-29T21:01:02Z');
  expect(await quota().reserve(5)).toEqual({ allowed: true, retryMs: 0 });
  const stored = await db!.pool.query("SELECT objects FROM routing_quota_counters WHERE scope=$1 AND kind='month'", [scope]);
  expect(stored.rows[0].objects).toBe(915);
  await expect(quota().consume(1, 100)).rejects.toMatchObject({ code: 'SUBSCRIPTION_QUOTA_EXHAUSTED' });
});
