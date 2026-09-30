import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PlanningDatabase } from './planning-database.js';

const url = process.env.TEST_DATABASE_URL;
const database = url ? PlanningDatabase.connect(url) : null;
beforeAll(async () => { await database?.migrate(); await database?.migrate(); });
afterAll(async () => { await database?.pool.end(); });

it.skipIf(!database)('serializes chat updates across instances while leaving nested owner writes and another user available', async () => {
  const owner = `chat-lock:${randomUUID()}`, second = PlanningDatabase.connect(url!);
  try {
    await database!.withChatUpdate(owner, async () => {
      await expect(second.withChatUpdate(owner, async () => true)).rejects.toMatchObject({ code: 'CHAT_UPDATE_BUSY' });
      expect(await second.withChatUpdate(`${owner}:other`, async () => true)).toBe(true);
      await database!.withOwner(owner, async (state, save) => { state.attempts.push(Date.now()); await save(); });
    });
    await expect(second.withChatUpdate(owner, async () => { throw new Error('synthetic interruption'); })).rejects.toThrow('synthetic interruption');
    expect(await database!.withChatUpdate(owner, async () => true)).toBe(true);
  } finally {
    await database!.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]);
    await second.pool.end();
  }
});

it.skipIf(!database)('enforces a shared two-slot cap across separate database sessions', async () => {
  const a = await database!.pool.connect(), b = await database!.pool.connect(), c = await database!.pool.connect();
  try {
    await database!.withSlot(a, 'intent', async () => {
      await database!.withSlot(b, 'intent', async () => {
        await expect(database!.withSlot(c, 'intent', async () => true)).rejects.toMatchObject({ code: 'INTENT_BUSY' });
      });
      expect(await database!.withSlot(c, 'intent', async () => true)).toBe(true);
    });
  } finally { a.release(); b.release(); c.release(); }
});

it.skipIf(!database)('persists after reconnect, isolates owners and rejects concurrent owner operations', async () => {
  const owner = 'integration:' + randomUUID();
  const second = PlanningDatabase.connect(url!);
  try {
    await database!.withOwner(owner, async (state, save) => {
      state.receipts['request-1'] = { hash: 'a', status: 'pending', at: Date.now() }; await save();
      await expect(second.withOwner(owner, async () => true)).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
      expect(await second.withOwner(owner + ':other', async state => Object.keys(state.receipts))).toEqual([]);
    });
    expect(await second.withOwner(owner, async state => state.receipts['request-1']?.status)).toBe('pending');
    await database!.withOwner(owner, async (_state, _save, client) => {
      for (let i = 0; i < 21; i++) await database!.recordUsage(client, owner);
    });
    const usage = await second.pool.query('SELECT calls FROM planning_daily_usage WHERE day=CURRENT_DATE AND kind=$1', [owner]);
    expect(usage.rows[0]?.calls).toBe(21);
  } finally {
    await database!.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]);
    await database!.pool.query('DELETE FROM planning_daily_usage WHERE kind=$1', [owner]);
    await second.pool.end();
  }
});

it.skipIf(!database)('keeps the user-authored route index separate from expiring planner checkpoints', async () => {
  const owner = 'integration:' + randomUUID();
  const second = PlanningDatabase.connect(url!);
  try {
    await database!.withNavigation(owner, async (state, save) => {
      state.welcomed = true; state.mode = 'planning'; state.activeRouteId = 'route-1';
      state.routes.push({ id: 'route-1', createdAt: new Date().toISOString(), title: 'Москва · прогулка',
        requestText: 'Хочу погулять в Москве', localityName: 'Москва', draftId: 'short-lived-draft', status: 'draft' });
      await save();
      await expect(second.withNavigation(owner, async () => true)).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
    });
    expect(await second.withNavigation(owner, async state => state.routes[0]?.title)).toBe('Москва · прогулка');
    expect(await second.withNavigation(owner + ':other', async state => state.routes)).toEqual([]);
    expect(await second.withOwner(owner, async state => state.checkpoint)).toBeUndefined();
    const row = await database!.pool.query('SELECT expires_at > now() + interval \'29 days\' AS retained FROM bot_navigation WHERE owner=$1', [owner]);
    expect(row.rows[0]?.retained).toBe(true);
  } finally {
    await database!.pool.query('DELETE FROM bot_navigation WHERE owner=$1', [owner]);
    await second.pool.end();
  }
});

it.skipIf(!database)('purges expired own snapshots in an isolated schema without changing longer-lived valid rows', async () => {
  const schema = 'saved_purge_' + randomUUID().replaceAll('-', ''), instant = new Date('2026-09-24T09:00:00Z');

  await database!.pool.query(`CREATE SCHEMA ${schema}`);
  const isolatedUrl = new URL(url!); isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const isolated = PlanningDatabase.connect(isolatedUrl.toString(), undefined, { now: () => instant });
  try {
    await isolated.migrate(); await isolated.migrate();
    await isolated.pool.query(`INSERT INTO saved_user_conditions(owner,draft_id,revision,conditions,expires_at)
      VALUES ('synthetic','expired',0,'{}',$1),('synthetic','valid',0,'{}',$2)`,
    [new Date(instant.getTime() - 1), new Date(instant.getTime() + 86_400_000)]);
    await isolated.purge();
    expect((await isolated.pool.query('SELECT draft_id FROM saved_user_conditions')).rows).toEqual([{ draft_id: 'valid' }]);
  } finally {
    await isolated.pool.end();

    await database!.pool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});
