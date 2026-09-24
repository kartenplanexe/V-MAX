import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { parseInitialIntent, InitialIntentError, type InitialContext, type IntentProvider } from './intent-start.js';
import { PlanningSessions, PlanningSessionError, type PlanningContext } from './planning-sessions.js';
import type { PlanningAuthenticator } from './planning-routes.js';
import type { PlanningView } from '../shared/planning-form.js';

const Input = z.object({ event_id: z.string().min(8).max(128), user_text: z.string().trim().min(1).max(4000) }).strict();
type Result = { status: 'off_topic' } | { status: 'draft'; view: PlanningView };
type Receipt = { hash: string; expires: number; pending: boolean; task: Promise<Result> };

/** Single-process coordinator. Deliberately not mounted in Serverless until shared state exists. */
export class InitialRequests {
  readonly #receipts = new Map<string, Receipt>();
  readonly #attempts = new Map<string, number[]>();
  readonly #active = new Set<string>();
  constructor(readonly options: { sessions: PlanningSessions; provider: IntentProvider; now: () => Date;
    context: () => InitialContext & { planning: PlanningContext } }) {}
  async start(owner: string, input: unknown): Promise<Result> {
    if (!owner) throw new InitialIntentError('AUTH_REQUIRED', 401);
    const parsed = Input.safeParse(input);
    if (!parsed.success) throw new InitialIntentError('INVALID_REQUEST_TEXT', 400);
    const body = parsed.data, now = this.options.now().getTime();
    for (const [key, receipt] of this.#receipts) if (!receipt.pending && receipt.expires <= now) this.#receipts.delete(key);
    for (const [key, times] of this.#attempts) {
      const kept = times.filter(t => now - t < 600_000);
      if (kept.length) this.#attempts.set(key, kept); else this.#attempts.delete(key);
    }
    const key = JSON.stringify([owner, body.event_id]), hash = createHash('sha256').update(body.user_text).digest('hex');
    const old = this.#receipts.get(key);
    if (old) {
      if (old.hash !== hash) throw new InitialIntentError('EVENT_CONFLICT', 409);
      const result = await old.task;
      return result.status === 'draft' ? { ...result, view: this.options.sessions.get(owner, result.view.id) } : result;
    }
    if (this.#active.has(owner)) throw new InitialIntentError('INTENT_IN_PROGRESS', 409);
    if (this.#active.size >= 2 || this.#receipts.size >= 200) throw new InitialIntentError('INTENT_BUSY', 429);
    const attempts = this.#attempts.get(owner) ?? [];
    if (attempts.length >= 3) throw new InitialIntentError('INTENT_RATE_LIMIT', 429);
    this.#attempts.set(owner, [...attempts, now]); this.#active.add(owner);
    const receipt: Receipt = { hash, expires: now + 1_800_000, pending: true, task: Promise.resolve({ status: 'off_topic' }) };
    // Start on the next microtask so the receipt exists before any provider await.
    receipt.task = Promise.resolve().then(async (): Promise<Result> => {
      const context = this.options.context();
      if (context.catalog.version !== context.planning.catalog.version || context.catalog.region_id !== context.planning.catalog.region_id)
        throw new InitialIntentError('CATALOG_UNAVAILABLE', 503);
      const result = await parseInitialIntent({ ...context, now: new Date(now).toISOString(), userText: body.user_text, inputId: body.event_id }, this.options.provider);
      if (result.status === 'off_topic') return result;
      return { status: 'draft', view: this.options.sessions.create(owner, result.draft, context.planning, result.provenance) };
    }).catch((error: unknown) => {
      if (error instanceof InitialIntentError || error instanceof PlanningSessionError) throw error;
      throw new InitialIntentError('INTENT_PROVIDER_FAILED', 502);
    }).finally(() => { receipt.pending = false; this.#active.delete(owner); });
    this.#receipts.set(key, receipt);
    return receipt.task;
  }
}

export function registerInitialRequestRoutes(app: FastifyInstance, initial: { start(owner: string, input: unknown): Promise<Result> }, authenticate: PlanningAuthenticator) {
  app.post('/api/planning/requests', { bodyLimit: 24 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = authenticate(request);
    if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    try { return await initial.start(owner, request.body); }
    catch (error) {
      if (error instanceof InitialIntentError || error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
      return reply.code(500).send({ error: 'INTENT_PROVIDER_FAILED' });
    }
  });
}
