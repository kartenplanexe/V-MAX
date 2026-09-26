import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PlanningSessions, PlanningSessionError, type PlanningContext } from './planning-sessions.js';
import { PlanningDatabase, type OwnerState } from './planning-database.js';
import { parseInitialIntent, isExactGreeting, InitialIntentError, type InitialContext, type IntentProvider } from './intent-start.js';

const Input = z.object({ event_id: z.string().min(8).max(128), user_text: z.string().trim().min(1).max(4000),
  locality_token: z.string().min(1).max(16000) }).strict();

/** The production coordinator: all instances share drafts and idempotency receipts. */
export class DurablePlanning {
  constructor(readonly options: { database: PlanningDatabase; plan: (job: Record<string, unknown>) => Promise<unknown>;
    context: (token: string) => Promise<InitialContext & { planning: PlanningContext }>;
    provider: IntentProvider }) {}
  private sessions(state: OwnerState, save: () => Promise<void>, reservePlan?: () => Promise<void>) {
    const sessions = new PlanningSessions({ checkpoint: state.checkpoint, plan: this.options.plan,
      beforePlan: async () => { await reservePlan?.(); state.checkpoint = sessions.checkpoint(); await save(); } });
    return sessions;
  }
  private action(owner: string, id: string, action: 'get' | 'edit' | 'confirm' | 'calculate', input?: unknown) {
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save, () => this.options.database.recordUsage(client, 'plan'));
      // Ownership is checked before validation and the planner call.
      sessions.get(owner, id);
      try {
        if (action === 'calculate') return await this.options.database.withSlot(client, 'plan', () => sessions.calculate(owner, id, input));
        return action === 'get' ? sessions.get(owner, id) : await sessions[action](owner, id, input);
      } finally { state.checkpoint = sessions.checkpoint(); await save(); }
    });
  }
  get(owner: string, id: string) { return this.action(owner, id, 'get'); }
  remove(owner: string, id: string) {
    return this.options.database.withOwner(owner, async (state, save) => {
      const sessions = this.sessions(state, save);
      sessions.remove(owner, id);
      state.checkpoint = sessions.checkpoint(); await save();
    });
  }
  edit(owner: string, id: string, input: unknown) { return this.action(owner, id, 'edit', input); }
  confirm(owner: string, id: string, input: unknown) { return this.action(owner, id, 'confirm', input); }
  calculate(owner: string, id: string, input: unknown) { return this.action(owner, id, 'calculate', input); }
  async latest(owner: string) {
    return this.options.database.withOwner(owner, async (state, save) => {
      const sessions = this.sessions(state, save), records = sessions.checkpoint().records;
      return records.length ? sessions.get(owner, records[records.length - 1]!.view.id) : null;
    });
  }
  async start(owner: string, input: unknown) {
    const parsed = Input.safeParse(input);
    if (!parsed.success) throw new InitialIntentError('INVALID_REQUEST_TEXT', 400);
    const body = parsed.data, hash = createHash('sha256').update(JSON.stringify([body.user_text, body.locality_token])).digest('hex');
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save), old = state.receipts[body.event_id];
      if (old) {
        if (old.hash !== hash) throw new PlanningSessionError('EVENT_CONFLICT');
        if (old.status === 'pending') throw new InitialIntentError('INTENT_INTERRUPTED', 503);
        if (old.status === 'failed') throw new InitialIntentError(old.error ?? 'INTENT_PROVIDER_FAILED', 502);
        return old.offTopic ? { status: 'off_topic' as const } : { status: 'draft' as const, view: sessions.get(owner, old.draftId!) };
      }
      state.receipts[body.event_id] = { hash, status: 'pending', at: Date.now() };
      await save(); // Before *any* external work. A crash cannot silently repeat a paid call.
      try {
        if (isExactGreeting(body.user_text)) {
          state.receipts[body.event_id]!.offTopic = true; state.receipts[body.event_id]!.status = 'done';
          await save(); return { status: 'off_topic' as const };
        }
        const { context, result } = await this.options.database.withSlot(client, 'intent', async () => {
          const context = await this.options.context(body.locality_token);
          const result = await parseInitialIntent({ ...context, now: new Date().toISOString(), userText: body.user_text, inputId: body.event_id }, async request => {
            await this.options.database.recordUsage(client, 'intent');
            return this.options.provider(request);
          });
          return { context, result };
        });
        if (result.status === 'off_topic') {
          state.receipts[body.event_id]!.offTopic = true; state.receipts[body.event_id]!.status = 'done'; await save(); return result;
        }
        const view = sessions.create(owner, result.draft, context.planning, result.provenance);
        state.receipts[body.event_id]!.draftId = view.id; state.receipts[body.event_id]!.status = 'done';
        state.checkpoint = sessions.checkpoint(); await save(); return { status: 'draft' as const, view };
      } catch (error) {
        const failure = error instanceof InitialIntentError || error instanceof PlanningSessionError ? error : new InitialIntentError('INTENT_PROVIDER_FAILED', 502);
        state.receipts[body.event_id]!.status = 'failed'; state.receipts[body.event_id]!.error = failure.code;
        await save(); throw failure;
      }
    });
  }
}
