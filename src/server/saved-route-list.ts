import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { SavedConditionsViewSchema, type SavedConditionsView } from '../shared/saved-conditions.js';
import { ActivateSavedRouteInputSchema, DeleteSavedRouteInputSchema, SavedRouteListSchema, type SavedRouteActivation } from '../shared/saved-route-list.js';
import { PlanningDatabase, type BotNavigation } from './planning-database.js';
import { PlanningSessions, PlanningSessionError, type PlanningCheckpoint } from './planning-sessions.js';
import type { PlanningAuthenticator } from './planning-routes.js';
import { planFreshUntil } from './route-alternatives.js';

const PAGE_SIZE = 50;
const Cursor = z.object({ updated_at: z.string().datetime(), id: z.string().min(1).max(128) }).strict();
function title(saved: SavedConditionsView) {
  const day = saved.conditions.days[0]!;
  return `${day.date} · ${day.activities.map(activity => activity.label).join(' · ') || 'Маршрут'}`
    .replace(/\s+/gu, ' ').slice(0, 160);
}
function rowView(row: { draft_id: string; revision: number; conditions: unknown; expires_at: Date }) {
  return SavedConditionsViewSchema.parse({ id: row.draft_id, revision: row.revision,
    conditions: row.conditions, expires_at: new Date(row.expires_at).toISOString() });
}

/** Existing own snapshots + ephemeral headers. This service never invokes a provider. */
export class SavedRouteLibrary {
  constructor(readonly database: PlanningDatabase) {}
  remove(owner: string, id: string, input: unknown): Promise<{ deleted: true }> {
    return this.database.withOwner(owner, async (state, save, client) => {
      const saved = await this.database.loadSaved(client, owner, id);
      const parsed = DeleteSavedRouteInputSchema.safeParse(input);
      if (!saved && (!parsed.success || !state.receipts[`delete-route:${parsed.data.event_id}`]))
        throw new PlanningSessionError('SAVED_CONDITIONS_NOT_FOUND', 404);
      if (!parsed.success) throw new PlanningSessionError('INVALID_ACTION', 400);
      const key = `delete-route:${parsed.data.event_id}`, hash = createHash('sha256').update(JSON.stringify([id, parsed.data.base_revision])).digest('hex');
      if (state.receipts[key]) {
        if (state.receipts[key]!.hash !== hash) throw new PlanningSessionError('EVENT_CONFLICT');
        return { deleted: true };
      }
      const sessions = new PlanningSessions({ checkpoint: state.checkpoint, now: this.database.now,
        plan: async () => { throw Error('Deletion cannot invoke the planner'); } });
      try { sessions.remove(owner, id); }
      catch (error) { if (!(error instanceof PlanningSessionError) || error.code !== 'DRAFT_NOT_FOUND') throw error; }
      // Every authored edit persists its saved revision under this same owner lock.
      // Expiring provider facts alone must not make a freshly listed own snapshot undeletable.
      if (parsed.data.base_revision !== saved!.revision) throw new PlanningSessionError('SAVED_CONDITIONS_STALE');
      const acquired = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 782003)) AS acquired', [owner]);
      if (!acquired.rows[0]?.acquired) throw new PlanningSessionError('OPERATION_IN_PROGRESS');
      try {
        const row = await client.query('SELECT state FROM bot_navigation WHERE owner=$1 AND expires_at>now()', [owner]);
        const nav: BotNavigation | undefined = row.rows[0]?.state;
        if (nav) {
          const removed = new Set(nav.routes.filter(route => route.draftId === id).map(route => route.id));
          nav.routes = nav.routes.filter(route => route.draftId !== id);
          if (nav.activeRouteId && removed.has(nav.activeRouteId)) { delete nav.activeRouteId; nav.mode = 'idle'; }
          if (nav.deletePendingRouteId && removed.has(nav.deletePendingRouteId)) delete nav.deletePendingRouteId;
        }
        if (state.chat?.pending && 'draftId' in state.chat.pending && state.chat.pending.draftId === id) delete state.chat.pending;
        state.checkpoint = sessions.checkpoint();
        state.receipts[key] = { hash, at: +this.database.now(), status: 'done', draftId: id };
        await this.database.transaction(client, async () => {
          await save(); await this.database.deleteSaved(client, owner, id);
          if (nav) await client.query('UPDATE bot_navigation SET state=$2 WHERE owner=$1', [owner, JSON.stringify(nav)]);
        });
        return { deleted: true };
      } finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 782003))', [owner]); }
    });
  }
  async list(owner: string, rawCursor?: string) {
    let cursor: z.infer<typeof Cursor> | undefined;
    if (rawCursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]{1,600}$/u.test(rawCursor)) throw Error();
        cursor = Cursor.parse(JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')));
      } catch { throw new PlanningSessionError('INVALID_SAVED_CURSOR', 400); }
    }
    const now = this.database.now();
    const [rows, ownerRow, navigation] = await Promise.all([
      this.database.pool.query(`SELECT draft_id,revision,conditions,expires_at FROM saved_user_conditions
        WHERE owner=$1 AND expires_at>$2 AND ($3::timestamptz IS NULL OR
          (conditions->>'updated_at')::timestamptz < $3 OR
          ((conditions->>'updated_at')::timestamptz = $3 AND draft_id > $4))
        ORDER BY (conditions->>'updated_at')::timestamptz DESC,draft_id ASC LIMIT $5`,
      [owner, now, cursor?.updated_at ?? null, cursor?.id ?? null, PAGE_SIZE + 1]),
      this.database.pool.query('SELECT state FROM planning_owners WHERE owner=$1 AND expires_at>$2', [owner, now]),
      this.database.pool.query('SELECT state FROM bot_navigation WHERE owner=$1 AND expires_at>now()', [owner]),
    ]);
    const checkpoint: PlanningCheckpoint | undefined = ownerRow.rows[0]?.state?.checkpoint;
    const nav: BotNavigation | undefined = navigation.rows[0]?.state;
    const activeDraft = nav?.mode === 'planning' ? nav.routes.find(route => route.id === nav.activeRouteId)?.draftId : undefined;
    const saved = rows.rows.slice(0, PAGE_SIZE).map(rowView);
    return SavedRouteListSchema.parse({ items: saved.map(snapshot => {
      const record = checkpoint?.records.find(item => item.owner === owner && item.view.id === snapshot.id && item.expires > +now);
      return { id: snapshot.id, title: title(snapshot), revision: Math.max(snapshot.revision, record?.view.version ?? 0),
        updated_at: snapshot.conditions.updated_at, expires_at: snapshot.expires_at, active: activeDraft === snapshot.id,
        can_open: Boolean(record), has_fresh_result: Boolean(record?.view.result && record.resultExpires > +now && planFreshUntil(record.view.result) > +now) };
    }), next_cursor: rows.rows.length > PAGE_SIZE && saved.length ? Buffer.from(JSON.stringify({
      updated_at: saved.at(-1)!.conditions.updated_at, id: saved.at(-1)!.id })).toString('base64url') : null });
  }
  activate(owner: string, id: string, input: unknown): Promise<SavedRouteActivation> {
    return this.database.withOwner(owner, async (state, save, client) => {
      const saved = await this.database.loadSaved(client, owner, id);
      if (!saved) throw new PlanningSessionError('SAVED_CONDITIONS_NOT_FOUND', 404);
      const parsed = ActivateSavedRouteInputSchema.safeParse(input);
      if (!parsed.success) throw new PlanningSessionError('INVALID_ACTION', 400);
      const key = 'activate:' + parsed.data.event_id, hash = createHash('sha256').update(id).digest('hex');
      const receipt = state.receipts[key];
      if (receipt && receipt.hash !== hash) throw new PlanningSessionError('EVENT_CONFLICT');
      const acquired = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 782003)) AS acquired', [owner]);
      if (!acquired.rows[0]?.acquired) throw new PlanningSessionError('OPERATION_IN_PROGRESS');
      try {
        const navRow = await client.query('SELECT state FROM bot_navigation WHERE owner=$1 AND expires_at>now()', [owner]);
        const nav: BotNavigation = navRow.rows[0]?.state ?? { welcomed: false, mode: 'idle', routes: [] };
        let route = nav.routes.find(item => item.draftId === id);
        if (receipt && (nav.mode !== 'planning' || nav.activeRouteId !== route?.id))
          throw new PlanningSessionError('ACTIVATION_SUPERSEDED');
        const sessions = new PlanningSessions({ checkpoint: state.checkpoint, now: this.database.now,
          plan: async () => { throw Error('A library read cannot invoke the planner'); } });
        let view = null;
        try { view = sessions.get(owner, id); }
        catch (error) { if (!(error instanceof PlanningSessionError) || error.code !== 'DRAFT_NOT_FOUND') throw error; }
        if (!route) {
          route = { id: randomUUID(), draftId: id, createdAt: saved.conditions.updated_at, title: title(saved),
            requestText: '', localityName: saved.conditions.queries.locality ?? '', status: view?.result ? 'planned' : 'draft' };
          nav.routes.push(route);
        }
        route.title = title(saved); route.status = view?.result ? 'planned' : 'draft';
        nav.activeRouteId = route.id; nav.mode = 'planning'; delete nav.deletePendingRouteId;
        if (state.chat) delete state.chat.pending;
        state.checkpoint = sessions.checkpoint();
        if (view) saved.revision = Math.max(saved.revision, view.version);
        state.receipts[key] = { hash, at: +this.database.now(), status: 'done', draftId: id };
        const navJson = JSON.stringify(nav);
        if (Buffer.byteLength(navJson) > 100_000) throw new PlanningSessionError('ROUTE_CAPACITY', 429);
        await this.database.transaction(client, async () => {
          await save(); await this.database.saveSaved(client, owner, saved);
          await client.query(`INSERT INTO bot_navigation(owner,state,expires_at) VALUES ($1,$2,now()+interval '30 days')
            ON CONFLICT(owner) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at`, [owner, navJson]);
        });
        return view ? { view } : { view: null, saved, expiredRoute: title(saved) };
      } finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 782003))', [owner]); }
    });
  }
}

export function registerSavedRouteLibrary(app: FastifyInstance, library: SavedRouteLibrary, authenticate: PlanningAuthenticator) {
  app.post<{ Params: { id: string } }>('/api/planning/saved/:id/delete', { bodyLimit: 2048 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = authenticate(request); if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    try { return await library.remove(owner, request.params.id, request.body); }
    catch (error) {
      if (error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
      return reply.code(503).send({ error: 'SAVED_LIBRARY_UNAVAILABLE' });
    }
  });
  app.get('/api/planning/saved', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = authenticate(request); if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    const query = z.object({ cursor: z.string().max(600).optional() }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'INVALID_SAVED_CURSOR' });
    try { return await library.list(owner, query.data.cursor); }
    catch (error) {
      if (error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
      return reply.code(503).send({ error: 'SAVED_LIBRARY_UNAVAILABLE' });
    }
  });
  app.post<{ Params: { id: string } }>('/api/planning/saved/:id/activate', { bodyLimit: 2048 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = authenticate(request); if (!owner) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    try { return await library.activate(owner, request.params.id, request.body); }
    catch (error) {
      if (error instanceof PlanningSessionError) return reply.code(error.status).send({ error: error.code });
      return reply.code(503).send({ error: 'SAVED_LIBRARY_UNAVAILABLE' });
    }
  });
}
