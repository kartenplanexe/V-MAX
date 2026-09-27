import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { PlanningDatabase } from './planning-database.js';
import { registerMaxChatRoute, maxWebhookSecret } from './max-chat.js';

it.skipIf(!process.env.TEST_DATABASE_URL)('does not let text overtake an unfinished new-route callback across HTTP handlers', async () => {
  const database = PlanningDatabase.connect(process.env.TEST_DATABASE_URL!);
  await database.migrate();
  const app = Fastify(), userId = Math.floor(1e9 + Math.random() * 1e9), owner = `max:${userId}`;
  const token = 'synthetic-concurrency-only';
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const unexpected = async (): Promise<never> => { throw new Error('No external calls expected'); };
  registerMaxChatRoute(app, { database, geography: { search: unexpected, searchAddress: unexpected },
    planning: { start: unexpected, get: unexpected, edit: unexpected, confirm: unexpected, calculate: unexpected },
    transport: { send: async () => {}, answer: async () => { entered(); await gate; } },
    botUsername: 'synthetic_bot', mapEnabled: false }, token);
  const headers = { 'x-max-bot-api-secret': maxWebhookSecret(token) };
  const action = { update_type: 'message_callback', callback: { user: { user_id: userId }, callback_id: randomUUID(), payload: 'nav:new' }, message: { recipient: { chat_type: 'dialog' } } };
  const text = { update_type: 'message_created', message: { sender: { user_id: userId, is_bot: false }, recipient: { chat_type: 'dialog' }, body: { mid: randomUUID(), text: 'хочу погулять' } } };
  let first: Promise<unknown> | undefined;
  try {
    first = app.inject({ method: 'POST', url: '/api/max/webhook', headers, payload: action }).then(response => { expect(response.statusCode).toBe(200); });
    await started;
    const overlapping = await app.inject({ method: 'POST', url: '/api/max/webhook', headers, payload: text });
    expect(overlapping.statusCode).toBe(503);
    expect(overlapping.json()).toEqual({ status: 'retry_later' });
    release(); await first;
    const retried = await app.inject({ method: 'POST', url: '/api/max/webhook', headers, payload: text });
    expect(retried.statusCode).toBe(200);
    expect(await database.withOwner(owner, async state => state.chat?.pending)).toMatchObject({ kind: 'city', requestText: 'хочу погулять' });
    const duplicate = await app.inject({ method: 'POST', url: '/api/max/webhook', headers, payload: action });
    expect(duplicate.json()).toEqual({ status: 'duplicate' });
    expect(await database.withOwner(owner, async state => state.chat?.pending)).toMatchObject({ kind: 'city', requestText: 'хочу погулять' });
  } finally {
    release(); await first?.catch(() => undefined); await app.close();
    await database.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]);
    await database.pool.query('DELETE FROM bot_navigation WHERE owner=$1', [owner]);
    await database.pool.end();
  }
}, 15000);
