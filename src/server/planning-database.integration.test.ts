import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PlanningDatabase } from './planning-database.js';

const url = process.env.TEST_DATABASE_URL;
const database = url ? PlanningDatabase.connect(url) : null;
beforeAll(async () => { await database?.migrate(); await database?.migrate(); });
afterAll(async () => { await database?.pool.end(); });

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
