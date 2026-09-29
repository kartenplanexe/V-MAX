/** Acceptance probes must share the production counter, never a private allowance. */
import { config } from '../src/server/config.js';
import { PlanningDatabase } from '../src/server/planning-database.js';
import { loadDatabaseCa } from '../src/server/database-tls.js';
import { RoutingQuota } from '../src/server/routing-quota.js';
export function liveProbeQuota() {
  let database: PlanningDatabase | undefined;
  let ready: Promise<RoutingQuota> | undefined;
  return {
    async consume(objects: number, remainingMs: number) {
      ready ??= (async () => {
        if (!config.databaseUrl) throw new Error('SHARED_ROUTING_DATABASE_REQUIRED');
        const ca = await loadDatabaseCa({ pem: config.databaseCaPem, path: config.databaseCaPath, required: true });
        database = PlanningDatabase.connect(config.databaseUrl, ca);
        await database.migrate();
        return new RoutingQuota(database.pool, config.routingQuota);
      })();
      await (await ready).consume(objects, remainingMs);
    },
    async close() { await database?.pool.end(); },
  };
}
