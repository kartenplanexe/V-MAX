import { Pool, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { PlanningSessionError, type PlanningCheckpoint } from './planning-sessions.js';
import { planningPoolConfig } from './database-tls.js';
import { SavedConditionsViewSchema, type SavedConditionsView } from '../shared/saved-conditions.js';

export type DurableReceipt = { hash: string; status: 'pending' | 'done' | 'failed'; at: number;
  draftId?: string; offTopic?: boolean; error?: string; errorStatus?: number };
export type ChatPending =
  | { kind: 'city'; requestText: string; requestId: string; nonce: string;
      routeId?: string; localityQuery?: string; choices?: { name: string; token: string }[] }
  | { kind: 'intent_retry'; requestText: string; localityToken: string; nonce: string; routeId?: string; localityQuery?: string }
  | { kind: 'origin' | 'destination'; draftId: string }
  | { kind: 'origin_address'; draftId: string; query?: string; nonce?: string }
  | { kind: 'party'; draftId: string };
export type OwnerState = { checkpoint?: PlanningCheckpoint; receipts: Record<string, DurableReceipt>; attempts: number[];
  chat?: { pending?: ChatPending; welcomed?: boolean;
    seen: Record<string, { at: number; status: 'pending' | 'done' }> } };
export type SavedRoute = { id: string; createdAt: string; title: string; requestText: string;
  localityName: string; draftId: string; status: 'draft' | 'planned' };
export type BotNavigation = { welcomed: boolean; mode: 'idle' | 'awaiting_request' | 'planning';
  activeRouteId?: string; deletePendingRouteId?: string; routes: SavedRoute[];
  greetingMessageId?: string; activeMessageIds?: string[]; cleanupMessageIds?: string[];
  resultMessageIds?: string[]; resultDraftId?: string };
const emptyNavigation = (): BotNavigation => ({ welcomed: false, mode: 'idle', routes: [] });

export class PlanningDatabase {
  readonly now: () => Date;
  constructor(readonly pool: Pool, options: { now?: () => Date } = {}) { this.now = options.now ?? (() => new Date()); }
  static connect(connectionString: string, ca?: string, options: { now?: () => Date } = {}) {
    return new PlanningDatabase(new Pool(planningPoolConfig(connectionString, ca)), options);
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
      const row = await client.query('SELECT state FROM planning_owners WHERE owner = $1 AND (retained OR expires_at > $2)', [owner, this.now()]);
      const state: OwnerState = row.rows[0]?.state ?? { receipts: {}, attempts: [] };
      const now = this.now().getTime();
      state.attempts = state.attempts.filter(t => now - t < 600_000);
      for (const [key, receipt] of Object.entries(state.receipts)) {
        if (now - receipt.at >= (key.startsWith('geo:') ? 60_000 : 1_800_000)) delete state.receipts[key];
      }
      const save = async () => {
        const json = JSON.stringify(state);
        if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new PlanningSessionError('SESSION_CAPACITY', 429);
        await client.query(`INSERT INTO planning_owners(owner,state,expires_at,retained) VALUES ($1,$2,$3,$4)
          ON CONFLICT(owner) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at,retained=excluded.retained`,
        [owner, json, new Date(this.now().getTime() + 1_800_000), state.checkpoint?.records.some(record => record.retained) ?? false]);
      };
      return await work(state, save, client);
    } finally {

      if (locked) { try { await client.query('SELECT pg_advisory_unlock_all()'); } catch { broken = true; } }
      client.release(broken);
    }
  }

  async transaction<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try { const value = await work(); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  async loadSaved(client: PoolClient, owner: string, id: string): Promise<SavedConditionsView | null> {
    const result = await client.query(`SELECT draft_id,revision,conditions,expires_at FROM saved_user_conditions
      WHERE owner=$1 AND draft_id=$2 AND (retained OR expires_at>$3)`, [owner, id, this.now()]);
    const row = result.rows[0];
    return row ? SavedConditionsViewSchema.parse({ id: row.draft_id, revision: row.revision,
      conditions: row.conditions, expires_at: new Date(row.expires_at).toISOString() }) : null;
  }
  async saveSaved(client: PoolClient, owner: string, input: SavedConditionsView) {

    const saved = SavedConditionsViewSchema.parse(input), json = JSON.stringify(saved.conditions);
    if (Buffer.byteLength(json) > 256 * 1024) throw new PlanningSessionError('SESSION_CAPACITY', 429);
    await client.query(`INSERT INTO saved_user_conditions(owner,draft_id,revision,conditions,expires_at)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT(owner,draft_id) DO UPDATE SET
      revision=GREATEST(saved_user_conditions.revision,excluded.revision),conditions=excluded.conditions,expires_at=excluded.expires_at`,
    [owner, saved.id, saved.revision, json, saved.expires_at]);
  }
  async deleteSaved(client: PoolClient, owner: string, id: string) {
    return client.query('DELETE FROM saved_user_conditions WHERE owner=$1 AND draft_id=$2', [owner, id]);
  }
  async withNavigation<T>(owner: string, work: (state: BotNavigation, save: () => Promise<void>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let locked = false, broken = false;
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 782003)) AS acquired', [owner]);
      if (!lock.rows[0]?.acquired) throw new PlanningSessionError('OPERATION_IN_PROGRESS');
      locked = true;
      const row = await client.query('SELECT state FROM bot_navigation WHERE owner = $1 AND expires_at > now()', [owner]);
      const state: BotNavigation = row.rows[0]?.state ?? emptyNavigation();
      const save = async () => {
        const json = JSON.stringify(state);
        if (Buffer.byteLength(json) > 100_000) throw new PlanningSessionError('ROUTE_CAPACITY', 429);
        await client.query(`INSERT INTO bot_navigation(owner,state,expires_at) VALUES ($1,$2,now()+interval '30 days')
          ON CONFLICT(owner) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at`, [owner, json]);
      };
      return await work(state, save);
    } finally {
      if (locked) { try { await client.query('SELECT pg_advisory_unlock_all()'); } catch { broken = true; } }
      client.release(broken);
    }
  }
  async recordUsage(client: PoolClient, kind: string) {

    await client.query(`INSERT INTO planning_daily_usage(day,kind,calls) VALUES (CURRENT_DATE,$1,1)
      ON CONFLICT(day,kind) DO UPDATE SET calls=planning_daily_usage.calls+1`, [kind]);
  }

  async withChatUpdate<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let broken = false;
    try {
      return await this.withSlot(client, 'chat', async () => {
        const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 782004)) AS acquired', [owner]);
        if (!lock.rows[0]?.acquired) throw new PlanningSessionError('CHAT_UPDATE_BUSY', 503);
        return await work();
      });
    } finally {
      try { await client.query('SELECT pg_advisory_unlock_all()'); } catch { broken = true; }
      client.release(broken);
    }
  }
  async withSlot<T>(client: PoolClient, kind: 'intent' | 'plan' | 'chat', work: () => Promise<T>): Promise<T> {
    let slot: number | null = null;
    const namespace = kind === 'intent' ? 782010 : kind === 'plan' ? 782011 : 782012;
    for (let i = 0; i < 2; i++) {
      const result = await client.query('SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired', [namespace, i]);
      if (result.rows[0]?.acquired) { slot = i; break; }
    }
    if (slot === null) throw new PlanningSessionError(kind === 'intent' ? 'INTENT_BUSY' : kind === 'plan' ? 'PLANNER_BUSY' : 'CHAT_BUSY', 429);
    try { return await work(); }
    finally { await client.query('SELECT pg_advisory_unlock($1::integer,$2::integer)', [namespace, slot]); }
  }
  async purge() {

    await this.pool.query('UPDATE planning_share_links SET plan=NULL,plan_expires_at=NULL WHERE plan_expires_at <= $1', [this.now()]);
    await this.pool.query('DELETE FROM planning_share_links WHERE expires_at <= $1', [this.now()]);
    await this.pool.query('DELETE FROM planning_share_imports WHERE expires_at <= $1', [this.now()]);
    await this.pool.query('UPDATE planning_event_previews SET data=NULL,data_expires_at=NULL WHERE data_expires_at <= $1', [this.now()]);
    await this.pool.query('DELETE FROM planning_event_previews WHERE expires_at <= $1', [this.now()]);
    await this.pool.query('DELETE FROM planning_owners WHERE NOT retained AND expires_at <= $1', [this.now()]);
    await this.pool.query("DELETE FROM planning_daily_usage WHERE day < CURRENT_DATE - 2");
    await this.pool.query('DELETE FROM bot_navigation WHERE expires_at <= now()');
    await this.pool.query('DELETE FROM saved_user_conditions WHERE NOT retained AND expires_at <= $1', [this.now()]);
  }
}
