import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { PlanningDatabase } from './planning-database.js';
import { DurablePlanning } from './durable-planning.js';
import { PlanningSessions } from './planning-sessions.js';
import { registerMaxChatRoute, maxWebhookSecret, type MaxChatDependencies } from './max-chat.js';
import { maxWorkerSecret } from './max-async.js';
import { demoNow, planningFixture } from './place-planning.fixture.js';

it.skipIf(!process.env.TEST_DATABASE_URL || !process.env.RUN_LONG_ASYNC_ACCEPTANCE)(
  'persists a 40-second plan and rejects redelivery after reconnect without another calculation', async () => {
    const url = process.env.TEST_DATABASE_URL!;
    let database = PlanningDatabase.connect(url, undefined, { now: demoNow });
    await database.migrate();
    const userId = Math.floor(1e9 + Math.random() * 1e9), owner = `max:${userId}`;
    const f = planningFixture(), token = 'synthetic-durable-async-only';
    const seed = new PlanningSessions({ now: demoNow, plan: async () => { throw Error('UNEXPECTED_SEED_PLAN'); } });
    const view = seed.create(owner, f.input.intent, { catalog: f.input.catalog,
      visit_policy: f.input.visit_policy, modes: ['walking'], data_mode: 'test' });
    await database.withOwner(owner, async (state, save) => { state.checkpoint = seed.checkpoint(); await save(); });
    await database.withNavigation(owner, async (state, save) => {
      state.mode = 'planning'; state.activeRouteId = 'synthetic-route';
      state.routes = [{ id: 'synthetic-route', draftId: view.id, createdAt: demoNow().toISOString(),
        title: 'Synthetic', requestText: 'Synthetic', localityName: 'Synthetic', status: 'draft' }];
      await save();
    });
    let calculations = 0, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const queued: unknown[] = [];
    const messages: string[] = [];
    const unexpected = async (): Promise<never> => { throw Error('EXTERNAL_CALL_FORBIDDEN'); };
    const makeApp = async () => {
      const planning = new DurablePlanning({ database, now: demoNow, context: unexpected, provider: unexpected,
        plan: async () => { calculations++; started(); await new Promise(resolve => setTimeout(resolve, 40000));
          return { status: 'UNAVAILABLE', warnings: [], days: [] }; } });
      const deps: MaxChatDependencies = { database, geography: { search: unexpected, searchAddress: unexpected },
        planning: { start: unexpected, get: planning.get.bind(planning), edit: planning.edit.bind(planning),
          confirm: planning.confirm.bind(planning), calculate: planning.calculate.bind(planning), remove: unexpected },
        transport: { send: async (_id, message) => { messages.push(message.text); }, answer: async () => {} },
        botUsername: 'synthetic_bot', mapEnabled: false };
      const app = Fastify();
      registerMaxChatRoute(app, deps, token, { dispatch: async update => { queued.push(update); } });
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      return { app, base, planning };
    };
    let runtime = await makeApp();
    const payload = { update_type: 'message_callback', callback: { user: { user_id: userId },
      callback_id: randomUUID(), payload: `plan:${view.id}:${view.version}` } };
    const post = (path: string, secret: string, body: unknown) => fetch(runtime.base + path,
      { method: 'POST', headers: { 'content-type': 'application/json',
        [path.endsWith('worker') ? 'x-vmax-worker-secret' : 'x-max-bot-api-secret']: secret },
      body: JSON.stringify(body), signal: AbortSignal.timeout(55000) });
    let running: Promise<Response> | undefined;
    try {
      const at = performance.now();
      const accepted = await post('/api/max/webhook', maxWebhookSecret(token), payload);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ status: 'accepted' });
      const ackMs = performance.now() - at;
      expect(ackMs).toBeLessThan(1000); expect(calculations).toBe(0);
      const workAt = performance.now();
      running = post('/api/max/worker', maxWorkerSecret(token), queued[0]);
      await entered;
      const concurrentDuplicate = await post('/api/max/worker', maxWorkerSecret(token), queued[0]);
      expect(concurrentDuplicate.status).toBe(503);
      expect(await concurrentDuplicate.json()).toEqual({ status: 'retry_later' });
      const completed = await running;
      expect(completed.status).toBe(200); expect(await completed.json()).toEqual({ status: 'handled' });
      const workMs = performance.now() - workAt;
      expect(workMs).toBeGreaterThanOrEqual(40000);
      await runtime.app.close(); await database.pool.end();
      database = PlanningDatabase.connect(url, undefined, { now: demoNow });
      runtime = await makeApp();
      expect((await runtime.planning.get(owner, view.id)).phase).toBe('RESULT');
      expect((await runtime.planning.get(owner, view.id)).result?.status).toBe('UNAVAILABLE');
      const replay = await post('/api/max/worker', maxWorkerSecret(token), queued[0]);
      expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ status: 'duplicate' });
      expect(calculations).toBe(1);
      expect(messages.some(message => message.includes('Подбираю места'))).toBe(true);
      console.log(JSON.stringify({ acceptance: 'LOCAL_HTTP_SQL_ONLY', ack_ms: Math.round(ackMs),
        work_ms: Math.round(workMs), calculations, restored_result: true, replay: 'duplicate', concurrent_replay: 503 }));
    } finally {
      await running?.catch(() => undefined); await runtime.app.close();
      for (const table of ['saved_user_conditions', 'planning_owners', 'bot_navigation'])
        await database.pool.query(`DELETE FROM ${table} WHERE owner=$1`, [owner]);
      await database.pool.end();
    }
  }, 65000);
