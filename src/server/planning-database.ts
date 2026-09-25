import { Pool, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { PlanningSessionError, type PlanningCheckpoint } from './planning-sessions.js';
import { planningPoolConfig } from './database-tls.js';

export type DurableReceipt = { hash: string; status: 'pending' | 'done' | 'failed'; at: number;
  draftId?: string; offTopic?: boolean; error?: string };
export type ChatPending =
  | { kind: 'city'; requestText: string; requestId: string; nonce: string;
      choices?: { name: string; token: string }[] }
  | { kind: 'origin' | 'destination'; draftId: string }
  | { kind: 'party'; draftId: string };
export type OwnerState = { checkpoint?: PlanningCheckpoint; receipts: Record<string, DurableReceipt>; attempts: number[];
  chat?: { pending?: ChatPending; seen: Record<string, { at: number; status: 'pending' | 'done' }> } };

/** One short-lived owner actor per DB connection. Session advisory locks, NOT open SQL transactions
 * during HTTP calls. try-lock returns immediately; disconnect releases the lock. Requires direct
 * PostgreSQL/session pooling (transaction-mode PgBouncer is deliberately unsupported).
 */
export class PlanningDatabase {
  constructor(readonly pool: Pool) {}
  static connect(connectionString: string, ca?: string) {
    return new PlanningDatabase(new Pool(planningPoolConfig(connectionString, ca)));
  }
  async migrate() {
    const sql = await readFile(new URL('./planning-schema.sql', import.meta.url), 'utf8');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(782001)');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async withOwner<T>(owner: string, work: (state: OwnerState, save: () => Promise<void>, client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let locked = false, broken = false;
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 782002)) AS acquired', [owner]);
      if (!lock.rows[0]?.acquired) throw new PlanningSessionError('OPERATION_IN_PROGRESS');
      locked = true;
      const row = await client.query('SELECT state FROM planning_owners WHERE owner = $1 AND expires_at > now()', [owner]);
      const state: OwnerState = row.rows[0]?.state ?? { receipts: {}, attempts: [] };
      const now = Date.now();
      state.attempts = state.attempts.filter(t => now - t < 600_000);
      for (const [key, receipt] of Object.entries(state.receipts)) {
        if (now - receipt.at >= (key.startsWith('geo:') ? 60_000 : 1_800_000)) delete state.receipts[key];
      }
      const save = async () => {
        const json = JSON.stringify(state);
        if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new PlanningSessionError('SESSION_CAPACITY', 429);
        await client.query(`INSERT INTO planning_owners(owner,state,expires_at) VALUES ($1,$2,now()+interval '30 minutes')
          ON CONFLICT(owner) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at`, [owner, json]);
      };
      return await work(state, save, client);
    } finally {
      // This leased connection owns no other work. Clear both owner and capacity locks,
      // including a capacity lock whose individual release failed earlier.
      if (locked) { try { await client.query('SELECT pg_advisory_unlock_all()'); } catch { broken = true; } }
      client.release(broken);
    }
  }
  async reserve(client: PoolClient, kind: string, maximum: number) {
    // A reservation is never refunded on timeout: billing outcome can be unknown.
    const result = await client.query(`INSERT INTO planning_daily_usage(day,kind,calls) VALUES (CURRENT_DATE,$1,1)
      ON CONFLICT(day,kind) DO UPDATE SET calls=planning_daily_usage.calls+1 WHERE planning_daily_usage.calls < $2 RETURNING calls`, [kind, maximum]);
    if (!result.rowCount) throw new PlanningSessionError('DAILY_LIMIT', 429);
  }
  async withSlot<T>(client: PoolClient, kind: 'intent' | 'plan', work: () => Promise<T>): Promise<T> {
    let slot: number | null = null;
    const namespace = kind === 'intent' ? 782010 : 782011;
    for (let i = 0; i < 2; i++) {
      const result = await client.query('SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired', [namespace, i]);
      if (result.rows[0]?.acquired) { slot = i; break; }
    }
    if (slot === null) throw new PlanningSessionError(kind === 'intent' ? 'INTENT_BUSY' : 'PLANNER_BUSY', 429);
    try { return await work(); }
    finally { await client.query('SELECT pg_advisory_unlock($1::integer,$2::integer)', [namespace, slot]); }
  }
  async purge() {
    // Run at startup and periodically; no provider snapshots are retained as a reusable cache.
    await this.pool.query('DELETE FROM planning_owners WHERE expires_at <= now()');
    await this.pool.query("DELETE FROM planning_daily_usage WHERE day < CURRENT_DATE - 2");
  }
}
