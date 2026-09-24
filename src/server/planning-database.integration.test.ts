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
      await database!.reserve(client, owner, 1);
      await expect(second.reserve(client, owner, 1)).rejects.toMatchObject({ code: 'DAILY_LIMIT' });
    });
  } finally {
    await database!.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]);
    await database!.pool.query('DELETE FROM planning_daily_usage WHERE kind=$1', [owner]);
    await second.pool.end();
  }
});
