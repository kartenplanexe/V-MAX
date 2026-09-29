import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { FormEdit, type PlanningView } from '../shared/planning-form.js';
import type { SavedConditionsView, SavedUserConditionsV1 } from '../shared/saved-conditions.js';
import { PlanningSessions, PlanningSessionError, type PlanningContext } from './planning-sessions.js';
import { PlanningDatabase, type OwnerState } from './planning-database.js';
import { parseInitialIntent, isExactGreeting, InitialIntentError, type InitialContext, type IntentProvider } from './intent-start.js';
import { projectSavedConditions, remapSavedConditions } from './saved-conditions.js';

const Input = z.object({ event_id: z.string().min(8).max(128), user_text: z.string().trim().min(1).max(4000),
  locality_token: z.string().min(1).max(16000), locality_query: z.string().trim().min(1).max(1000).optional() }).strict();
export const RestoreSavedInputSchema = z.object({ event_id: z.string().min(8).max(128),
  base_revision: z.number().int().nonnegative(), locality_token: z.string().min(1).max(16000) }).strict();
const SAVED_TTL = 30 * 86_400_000;
function conditionKey(value: SavedUserConditionsV1) {
  const { conditions_revision: _revision, updated_at: _updated, review_state: _review, points, ...own } = value;
  const authoredPoints = Object.fromEntries(Object.entries(points).map(([field, { saved_at: _at, ...point }]) => [field, point]));
  return { ...own, points: authoredPoints };
}

/** The production coordinator: all instances share drafts and idempotency receipts. */
export class DurablePlanning {
  constructor(readonly options: { database: PlanningDatabase; plan: (job: Record<string, unknown>) => Promise<unknown>;
    context: (token: string) => Promise<InitialContext & { planning: PlanningContext }>;
    provider: IntentProvider; now?: () => Date }) {}
  private now() { return (this.options.now ?? this.options.database.now)(); }
  private sessions(state: OwnerState, save: () => Promise<void>, reservePlan?: () => Promise<void>) {
    const sessions = new PlanningSessions({ checkpoint: state.checkpoint, plan: this.options.plan, now: () => this.now(),
      beforePlan: async () => { await reservePlan?.(); state.checkpoint = sessions.checkpoint(); await save(); } });
    // Receipts can outlive individual drafts. Every subsequent save, including a
    // failed start/restore or an off-topic greeting, must use the pruned context.
    state.checkpoint = sessions.checkpoint();
    return sessions;
  }
  private maybeView(sessions: PlanningSessions, owner: string, id: string) {
    try { return sessions.get(owner, id); }
    catch (error) { if (error instanceof PlanningSessionError && error.code === 'DRAFT_NOT_FOUND') return undefined; throw error; }
  }
  private async persist(owner: string, state: OwnerState, save: () => Promise<void>, client: PoolClient,
    sessions: PlanningSessions, view?: PlanningView, capture = false,
    queries?: SavedUserConditionsV1['queries'], review?: SavedUserConditionsV1['review_state']) {
    let saved = view ? await this.options.database.loadSaved(client, owner, view.id) : null;
    if (view && capture) {
      const next = projectSavedConditions(view, { now: this.now(), queries: queries ?? saved?.conditions.queries });
      if (!saved || !isDeepStrictEqual(conditionKey(next), conditionKey(saved.conditions))) saved = {
        id: view.id, revision: view.version, conditions: next, expires_at: new Date(this.now().getTime() + SAVED_TTL).toISOString() };
    }
    if (saved && view) {
      saved.revision = Math.max(saved.revision, view.version);
      if (review) saved.conditions.review_state = review;
    }
    const previous = state.checkpoint;
    state.checkpoint = sessions.checkpoint();
    try { await this.options.database.transaction(client, async () => {
      await save(); if (saved) await this.options.database.saveSaved(client, owner, saved);
      if (saved && state.checkpoint?.records.some(record => record.view.id === saved.id && record.retained))
        await client.query('UPDATE saved_user_conditions SET retained=true WHERE owner=$1 AND draft_id=$2', [owner, saved.id]);
    }); } catch (error) { state.checkpoint = previous; throw error; }
    return saved;
  }
  private action(owner: string, id: string, action: 'get' | 'edit' | 'confirm' | 'calculate', input?: unknown) {
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save, () => this.options.database.recordUsage(client, 'plan'));
      let changedConditions = false, confirmed = false;
      try {
        // Ownership is checked before validation and the planner call.
        const before = sessions.get(owner, id);
        const view = action === 'calculate' ? await this.options.database.withSlot(client, 'plan', () => sessions.calculate(owner, id, input))
          : action === 'get' ? sessions.get(owner, id) : await sessions[action](owner, id, input);
        changedConditions = action === 'edit' && view.version > before.version;
        confirmed = action === 'confirm' && view.confirmed_version === view.version;
        return view;
      } finally {
        const pending = state.chat?.pending;
        let queries: SavedUserConditionsV1['queries'] | undefined;
        if (changedConditions) {
          queries = { ...(await this.options.database.loadSaved(client, owner, id))?.conditions.queries };
          for (const change of FormEdit.parse(input).changes) {
            if (change.op === 'clear_destination') delete queries.destination;
            if (change.op === 'point') {
              delete queries[change.field];
              if (change.field === 'origin' && change.point.source === 'place_choice' && pending?.kind === 'origin_address'
                && pending.draftId === id && pending.query) queries.origin = pending.query;
            }
          }
        }
        await this.persist(owner, state, save, client, sessions, this.maybeView(sessions, owner, id), changedConditions,
          queries, confirmed ? 'user_confirmed' : undefined);
      }
    });
  }
  get(owner: string, id: string) { return this.action(owner, id, 'get'); }
  activityOptions(owner: string, id: string) {
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save);
      try { return sessions.activityOptions(owner, id); }
      finally { await this.persist(owner, state, save, client, sessions, this.maybeView(sessions, owner, id)); }
    });
  }
  remove(owner: string, id: string) {
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save);
      const active = this.maybeView(sessions, owner, id), saved = await this.options.database.loadSaved(client, owner, id);
      if (!active && !saved) throw new PlanningSessionError('DRAFT_NOT_FOUND', 404);
      if (active) sessions.remove(owner, id);
      state.checkpoint = sessions.checkpoint();
      await this.options.database.transaction(client, async () => { await save(); await this.options.database.deleteSaved(client, owner, id); });
    });
  }
  edit(owner: string, id: string, input: unknown) { return this.action(owner, id, 'edit', input); }
  confirm(owner: string, id: string, input: unknown) { return this.action(owner, id, 'confirm', input); }
  calculate(owner: string, id: string, input: unknown) { return this.action(owner, id, 'calculate', input); }
  previewAlternative(owner: string, id: string, input: unknown) {
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save, () => this.options.database.recordUsage(client, 'plan'));
      try {
        sessions.get(owner, id); // Authorize before any paid work or schema details.
        return await this.options.database.withSlot(client, 'plan', () => sessions.previewAlternative(owner, id, input));
      } finally { await this.persist(owner, state, save, client, sessions, this.maybeView(sessions, owner, id)); }
    });
  }
  applyAlternative(owner: string, id: string, input: unknown) {
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save);
      const view = sessions.applyAlternative(owner, id, input);
      await this.persist(owner, state, save, client, sessions, view);
      return view;
    });
  }
  async latest(owner: string) {
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save), records = sessions.checkpoint().records;
      const view = records.length ? sessions.get(owner, records[records.length - 1]!.view.id) : null;
      await this.persist(owner, state, save, client, sessions, view ?? undefined);
      return view;
    });
  }
  async getSaved(owner: string, id: string): Promise<SavedConditionsView> {
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save), view = this.maybeView(sessions, owner, id);
      // A read may invalidate an expired result and advance the ephemeral revision.
      // Persist that revision atomically, but never refresh the own-condition TTL.
      const saved = await this.persist(owner, state, save, client, sessions, view)
        ?? await this.options.database.loadSaved(client, owner, id);
      if (!saved) throw new PlanningSessionError('SAVED_CONDITIONS_NOT_FOUND', 404);
      return saved;
    });
  }
  async restore(owner: string, id: string, input: unknown): Promise<PlanningView> {
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save);
      let saved = await this.options.database.loadSaved(client, owner, id);
      if (!saved) throw new PlanningSessionError('SAVED_CONDITIONS_NOT_FOUND', 404);
      const parsed = RestoreSavedInputSchema.safeParse(input);
      if (!parsed.success) throw new PlanningSessionError('INVALID_ACTION', 400);
      const body = parsed.data, key = `restore:${body.event_id}`;
      const hash = createHash('sha256').update(JSON.stringify([id, body.base_revision, body.locality_token])).digest('hex');
      const old = state.receipts[key];
      if (old) {
        if (old.hash !== hash) throw new PlanningSessionError('EVENT_CONFLICT');
        if (old.status === 'pending') throw new PlanningSessionError('RESTORE_INTERRUPTED', 503);
        if (old.status === 'failed') throw new PlanningSessionError(old.error ?? 'SAVED_RESTORE_FAILED', old.errorStatus ?? 503);
        const view = sessions.get(owner, id);
        await this.persist(owner, state, save, client, sessions, view);
        return view;
      }
      const active = this.maybeView(sessions, owner, id);
      if (active) saved = (await this.persist(owner, state, save, client, sessions, active))!;
      if (body.base_revision !== saved.revision) throw new PlanningSessionError('SAVED_CONDITIONS_STALE');
      state.receipts[key] = { hash, status: 'pending', at: this.now().getTime(), draftId: id };
      await save(); // Reserve recovery before fresh catalog work; no SQL transaction spans HTTP.
      try {
        const context = await this.options.database.withSlot(client, 'intent', () => this.options.context(body.locality_token));
        if (this.now().getTime() >= new Date(saved.expires_at).getTime()) throw new PlanningSessionError('SAVED_CONDITIONS_NOT_FOUND', 404);
        const remapped = remapSavedConditions(saved.conditions, { ...context, now: this.now().toISOString() });
        if (remapped.status === 'NEEDS_INPUT') throw new PlanningSessionError(remapped.issues[0]?.code ?? 'SAVED_RESTORE_FAILED', 422);
        const view = sessions.restoreDraft(owner, id, Math.max(saved.revision, active?.version ?? 0) + 1,
          remapped.draft, context.planning, remapped.provenance);
        state.receipts[key]!.status = 'done';
        await this.persist(owner, state, save, client, sessions, view, false, undefined, 'draft');
        // Session issues derive from the restored draft on every read/replay.
        // Remapper blockers were rejected above; unresolved points/dates remain
        // concrete draft constraints, so no response-only issue is appended.
        return view;
      } catch (error) {
        const failure = error instanceof PlanningSessionError ? error : error instanceof InitialIntentError
          ? new PlanningSessionError(error.code, error.status) : new PlanningSessionError('SAVED_RESTORE_FAILED', 503);
        state.receipts[key]!.status = 'failed'; state.receipts[key]!.error = failure.code;
        state.receipts[key]!.errorStatus = failure.status;
        await save(); throw failure;
      }
    });
  }
  async start(owner: string, input: unknown) {
    const parsed = Input.safeParse(input);
    if (!parsed.success) throw new InitialIntentError('INVALID_REQUEST_TEXT', 400);
    const body = parsed.data, hash = createHash('sha256').update(JSON.stringify([body.user_text, body.locality_token,
      ...(body.locality_query ? [body.locality_query] : [])])).digest('hex');
    return this.options.database.withOwner(owner, async (state, save, client) => {
      const sessions = this.sessions(state, save), old = state.receipts[body.event_id];
      if (old) {
        if (old.hash !== hash) throw new PlanningSessionError('EVENT_CONFLICT');
        if (old.status === 'pending') throw new InitialIntentError('INTENT_INTERRUPTED', 503);
        if (old.status === 'failed') throw new InitialIntentError(old.error ?? 'INTENT_PROVIDER_FAILED', 502);
        if (old.offTopic) return { status: 'off_topic' as const };
        const view = sessions.get(owner, old.draftId!);
        await this.persist(owner, state, save, client, sessions, view);
        return { status: 'draft' as const, view };
      }
      state.receipts[body.event_id] = { hash, status: 'pending', at: this.now().getTime() };
      await save(); // Before *any* external work. A crash cannot silently repeat a paid call.
      try {
        if (isExactGreeting(body.user_text)) {
          state.receipts[body.event_id]!.offTopic = true; state.receipts[body.event_id]!.status = 'done';
          await save(); return { status: 'off_topic' as const };
        }
        const { context, result } = await this.options.database.withSlot(client, 'intent', async () => {
          const context = await this.options.context(body.locality_token);
          const result = await parseInitialIntent({ ...context, now: this.now().toISOString(), userText: body.user_text, inputId: body.event_id }, async request => {
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
        await this.persist(owner, state, save, client, sessions, view, true,
          body.locality_query ? { locality: body.locality_query } : undefined);
        return { status: 'draft' as const, view };
      } catch (error) {
        const failure = error instanceof InitialIntentError || error instanceof PlanningSessionError ? error : new InitialIntentError('INTENT_PROVIDER_FAILED', 502);
        state.receipts[body.event_id]!.status = 'failed'; state.receipts[body.event_id]!.error = failure.code;
        await save(); throw failure;
      }
    });
  }
}
