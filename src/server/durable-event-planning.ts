import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { SearchEventsInputSchema, EventAvailabilityInputSchema, SelectEventInputSchema, RecheckEventInputSchema,
  EventSearchPreviewSchema, EventAvailabilityPreviewSchema, type EventSearchPreview, type EventAvailabilityPreview } from '../shared/event-selection.js';
import { isEventActivity, type PlanningView } from '../shared/planning-form.js';
import { PlanningDatabase } from './planning-database.js';
import { PlanningSessions, PlanningSessionError, type PlanningContext } from './planning-sessions.js';
import { KudagoClient, EventRequestBudgetError, KUDAGO_LOCALITIES } from './kudago.js';
import { localEventInstant } from './event-normalization.js';
import { resolveEventAvailability, resolveEventSelection, resolveSelectedEvent, EventSelectionError } from './event-availability.js';
import { projectSavedConditions } from './saved-conditions.js';

type Operation = 'search' | 'availability' | 'select' | 'recheck';
type Row = { id: string; owner: string; draft_id: string; operation: Operation; event_id: string; fingerprint: string;
  base_revision: number; day_id: string; parent_id: string | null; status: 'pending' | 'done' | 'failed';
  data: unknown | null; data_expires_at: Date | null; expires_at: Date; error: string | null; error_status: number | null };
type Context = { row: Row; parent?: Row; client: PoolClient; sessions: PlanningSessions; view: PlanningView; planning: PlanningContext };
type Common = { base_version: number; event_id: string; day_id?: string; search_id?: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function reject(code: string, status = 409): never { throw new PlanningSessionError(code, status); }
function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw); if (!result.success) reject('INVALID_ACTION', 400); return result.data;
}
const noPlan = async (): Promise<never> => reject('EVENT_SERVICE_CANNOT_CALCULATE', 500);

/** Explicit event selection only. Every source observation is short-lived;
 * durable own snapshots contain the chosen identity and user duration only. */
export class DurableEventPlanning {
  constructor(readonly options: { database: PlanningDatabase; client: KudagoClient }) {}
  private now() { return this.options.database.now(); }
  private active(row: Row | undefined, view: PlanningView): Row {
    if (!row) reject('EVENT_PREVIEW_NOT_FOUND', 404);
    if (row.base_revision !== view.version) reject('EVENT_PREVIEW_STALE');
    if (row.status !== 'done' || !row.data || !row.data_expires_at || row.data_expires_at.getTime() <= this.now().getTime()) reject('EVENT_PREVIEW_EXPIRED', 410);
    return row;
  }
  private scope(ctx: Context) {
    const day = ctx.view.draft.days.find(value => value.day_id === ctx.row.day_id);
    if (!day) reject('UNKNOWN_DAY', 422);
    if (!day.window) reject('WINDOW_REQUIRED', 422);
    const locality = ctx.view.draft.locality;
    const entry = Object.entries(KUDAGO_LOCALITIES).find(([, value]) => value.name.toLocaleLowerCase('ru-RU') === locality.name.trim().toLocaleLowerCase('ru-RU') && value.timezone === locality.timezone);
    if (!entry) reject('EVENT_LOCALITY_UNSUPPORTED', 422);
    return { date: day.date, window: day.window, providerLocation: entry[0], timezone: locality.timezone,
      localityId: locality.id, regionId: locality.region_id, pointArea: ctx.planning.point_area };
  }
  private async bounded<T>(client: PoolClient, work: (policy: { requestBudget: { consume(): void }; shouldContinue: () => boolean }) => Promise<T>) {
    return this.options.database.withSlot(client, 'intent', async () => {
      const started = performance.now(); let attempts = 0;
      const shouldContinue = () => performance.now() - started < 90000;
      try { return await work({ shouldContinue, requestBudget: { consume() {
        if (!shouldContinue()) throw new EventRequestBudgetError('DEADLINE_EXCEEDED');
        if (attempts >= 4) throw new EventRequestBudgetError('HTTP_BUDGET_EXHAUSTED');
        attempts++;
      } } }); } finally {
        // Aggregate physical-attempt usage, never a raw response, token or user text.
        if (attempts) await client.query(`INSERT INTO planning_daily_usage(day,kind,calls) VALUES(CURRENT_DATE,'event_http',$1)
          ON CONFLICT(day,kind) DO UPDATE SET calls=planning_daily_usage.calls+excluded.calls`, [attempts]);
      }
    });
  }
  private async operation<T>(owner: string, draftId: string, operation: Operation, body: Common,
    work: (context: Context) => Promise<{ value: T; dataExpires?: Date; mutation?: 'own' | 'header' }>): Promise<T> {
    if (!owner || owner.length > 200 || !draftId || draftId.length > 128) reject('INVALID_ACTION', 400);
    const database = this.options.database, fingerprint = hash([operation, draftId, body]);
    return database.withOwner(owner, async (state, save, client) => {
      const sessions = new PlanningSessions({ checkpoint: state.checkpoint, now: () => this.now(), plan: noPlan });
      const old = (await client.query<Row>('SELECT * FROM planning_event_previews WHERE owner=$1 AND event_id=$2', [owner, body.event_id])).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint) reject('EVENT_CONFLICT');
        if (old.expires_at.getTime() <= this.now().getTime()) reject('EVENT_PREVIEW_EXPIRED', 410);
        if (old.status === 'pending') reject('EVENT_OPERATION_INTERRUPTED', 503);
        if (old.status === 'failed') reject(old.error ?? 'EVENT_OPERATION_FAILED', old.error_status ?? 503);
        if (operation === 'select' || operation === 'recheck') {
          try { return sessions.get(owner, draftId) as T; }
          catch (error) { if (!(error instanceof PlanningSessionError) || error.code !== 'DRAFT_NOT_FOUND') throw error; reject('EVENT_PREVIEW_EXPIRED', 410); }
        }
        const view = sessions.get(owner, draftId), active = this.active(old, view);
        return parse(operation === 'search' ? EventSearchPreviewSchema : EventAvailabilityPreviewSchema, active.data) as T;
      }
      const view = sessions.get(owner, draftId), saved = await database.loadSaved(client, owner, draftId);
      if (!saved) reject('SAVED_CONDITIONS_NOT_FOUND', 404);
      // Persist pruning/header changes without refreshing the durable condition TTL.
      const pruned = sessions.checkpoint();
      if (JSON.stringify(pruned) !== JSON.stringify(state.checkpoint)) {
        const before = state.checkpoint; state.checkpoint = pruned;
        try { await database.transaction(client, async () => { await save(); await database.saveSaved(client, owner, { ...saved, revision: Math.max(saved.revision, view.version) }); }); }
        catch (error) { state.checkpoint = before; throw error; }
      }
      if (view.version !== body.base_version) reject('EVENT_PREVIEW_STALE');
      if (view.phase === 'PLANNING') reject('PLAN_IN_PROGRESS');
      const planning = pruned.records.find(record => record.owner === owner && record.view.id === draftId)!.context;
      let parent: Row | undefined;
      if (body.search_id) parent = this.active((await client.query<Row>(`SELECT * FROM planning_event_previews
        WHERE owner=$1 AND draft_id=$2 AND id=$3 AND operation='search'`, [owner, draftId, body.search_id])).rows[0], view);
      const dayId = body.day_id ?? parent?.day_id;
      if (!dayId || !view.draft.days.some(day => day.day_id === dayId) || parent && parent.day_id !== dayId) reject('UNKNOWN_DAY', 422);
      const count = await client.query(`SELECT count(*)::integer AS count FROM planning_event_previews WHERE owner=$1 AND expires_at>$2`, [owner, this.now()]);
      if (count.rows[0].count >= 100) reject('EVENT_PREVIEW_CAPACITY', 429);
      const row: Row = { id: randomUUID(), owner, draft_id: draftId, operation, event_id: body.event_id, fingerprint,
        base_revision: view.version, day_id: dayId, parent_id: parent?.id ?? null, status: 'pending', data: null, data_expires_at: null,
        expires_at: new Date(this.now().getTime() + 1800000), error: null, error_status: null };
      await client.query(`INSERT INTO planning_event_previews(id,owner,draft_id,event_id,operation,fingerprint,base_revision,day_id,parent_id,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`, [row.id, owner, draftId, body.event_id, operation, fingerprint, view.version, dayId, parent?.id ?? null, row.expires_at]);
      try {
        const result = await work({ row, parent, client, sessions, view, planning });
        const json = result.dataExpires ? JSON.stringify(result.value) : null;
        if (json && Buffer.byteLength(json) > 256 * 1024) reject('EVENT_PREVIEW_CAPACITY', 429);
        if (result.dataExpires && result.dataExpires.getTime() <= this.now().getTime()) reject('EVENT_PREVIEW_EXPIRED', 410);
        const before = state.checkpoint;
        if (result.mutation) state.checkpoint = sessions.checkpoint();
        try {
          await database.transaction(client, async () => {
            if (parent) this.active((await client.query<Row>('SELECT * FROM planning_event_previews WHERE owner=$1 AND id=$2 FOR UPDATE', [owner, parent.id])).rows[0], view);
            if (result.mutation) {
              const next = result.value as PlanningView;
              await save();
              const own = result.mutation === 'own' ? projectSavedConditions(next, { now: this.now(), queries: saved.conditions.queries }) : saved.conditions;
              await database.saveSaved(client, owner, { id: draftId, revision: next.version, conditions: own,
                expires_at: result.mutation === 'own' ? new Date(this.now().getTime() + 30 * 86400000).toISOString() : saved.expires_at });
            }
            await client.query("UPDATE planning_event_previews SET status='done',data=$3,data_expires_at=$4 WHERE owner=$1 AND id=$2",
              [owner, row.id, json, result.dataExpires ?? null]);
          });
        } catch (error) { state.checkpoint = before; throw error; }
        return result.value;
      } catch (error) {
        const failure = error instanceof PlanningSessionError ? error : error instanceof EventSelectionError
          ? new PlanningSessionError(error.code, error.code === 'EVENT_SOURCE_EXPIRED' ? 410 : 422) : new PlanningSessionError('EVENT_OPERATION_FAILED', 503);
        await client.query("UPDATE planning_event_previews SET status='failed',data=NULL,data_expires_at=NULL,error=$3,error_status=$4 WHERE owner=$1 AND id=$2",
          [owner, row.id, failure.code, failure.status]);
        throw failure;
      }
    });
  }
  async search(owner: string, id: string, input: unknown): Promise<EventSearchPreview> {
    const body = parse(SearchEventsInputSchema, input);
    return this.operation(owner, id, 'search', body, async ctx => {
      const scope = this.scope(ctx), formatter = new Intl.DateTimeFormat('en-CA', { timeZone: scope.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const starts = localEventInstant(scope.date, 0, formatter), ends = localEventInstant(scope.date, 1440, formatter);
      if (starts === null || ends === null) reject('EVENT_LOCAL_TIME_UNSUPPORTED', 422);
      const found = await this.bounded(ctx.client, policy => this.options.client.search({ location: scope.providerLocation, starts_at: starts, ends_at: ends,
        ...(body.categories ? { categories: body.categories } : {}) }, { ...policy, maxPages: 1, pageSize: 50 }));
      const expiry = new Date(Math.min(this.now().getTime() + 300000, Date.parse(ctx.view.expires_at),
        ...found.items.map(item => Date.parse(item.source.valid_until))));
      const value = EventSearchPreviewSchema.parse({ search_id: ctx.row.id, expires_at: expiry.toISOString(), coverage: found.coverage,
        reason: found.stop_reason, cards: found.items.map(card => ({ choice_id: randomUUID(), card })) });
      return { value, dataExpires: expiry };
    });
  }
  async availability(owner: string, id: string, input: unknown): Promise<EventAvailabilityPreview> {
    const body = parse(EventAvailabilityInputSchema, input);
    return this.operation(owner, id, 'availability', body, async ctx => {
      const source = parse(EventSearchPreviewSchema, ctx.parent!.data), selected = source.cards.find(item => item.choice_id === body.choice_id);
      if (!selected) reject('EVENT_CHOICE_NOT_FOUND', 422);
      const scope = this.scope(ctx);
      const result = await this.bounded(ctx.client, async policy => {
        const event = await this.options.client.getEvent(String(selected.card.provider_event_id), policy);
        if (!event.event) reject(`EVENT_${event.reason ?? 'PROVIDER_ERROR'}`, 503);
        if (!event.event.venue) reject('EVENT_VENUE_UNKNOWN', 422);
        const venue = await this.options.client.getVenue(event.event.venue.provider_venue_id, policy);
        if (!venue.venue) reject(`EVENT_${venue.reason ?? 'PROVIDER_ERROR'}`, 503);
        return resolveEventAvailability(event.event, venue.venue, { ...scope, now: this.now().getTime() });
      });
      const expiry = new Date(Math.min(Date.parse(source.expires_at), this.now().getTime() + 300000,
        ...result.choices.map(choice => Date.parse(choice.source.valid_until))));
      const value = EventAvailabilityPreviewSchema.parse({ search_id: source.search_id, expires_at: expiry.toISOString(), status: result.status,
        choices: result.choices.map(choice => ({ occurrence_choice_id: randomUUID(), choice })), unresolved: result.unresolved });
      return { value, dataExpires: expiry };
    });
  }
  async select(owner: string, id: string, input: unknown): Promise<PlanningView> {
    const body = parse(SelectEventInputSchema, input);
    return this.operation(owner, id, 'select', body, async ctx => {
      const rows = await ctx.client.query<Row>(`SELECT * FROM planning_event_previews WHERE owner=$1 AND draft_id=$2 AND parent_id=$3 AND operation='availability'
        AND status='done' AND data_expires_at>$4 ORDER BY expires_at DESC`, [owner, id, body.search_id, this.now()]);
      const selected = rows.rows.filter(row => row.base_revision === ctx.view.version).flatMap(row => parse(EventAvailabilityPreviewSchema, row.data).choices)
        .find(item => item.occurrence_choice_id === body.occurrence_choice_id);
      if (!selected) reject('EVENT_CHOICE_NOT_FOUND', 422);
      const choice = resolveEventSelection(selected.choice, body.visit_duration_minutes, this.now().getTime());
      const value = ctx.sessions.selectEvent(owner, id, { base_version: body.base_version, event_id: body.event_id, day_id: body.day_id,
        ...(body.replace_activity_id ? { replace_activity_id: body.replace_activity_id } : {}), target: choice.target, evidence: choice.evidence });
      return { value, mutation: 'own' };
    });
  }
  async recheck(owner: string, id: string, input: unknown): Promise<PlanningView> {
    const body = parse(RecheckEventInputSchema, input);
    return this.operation(owner, id, 'recheck', body, async ctx => {
      const activity = ctx.view.draft.days.find(day => day.day_id === body.day_id)?.activities.find(value => value.id === body.activity_id);
      if (!activity || !isEventActivity(activity)) reject('UNKNOWN_EVENT_ACTIVITY', 422);
      const result = await this.bounded(ctx.client, policy => resolveSelectedEvent(this.options.client, activity.target,
        { ...this.scope(ctx), activityId: activity.id, dayId: body.day_id }, { ...policy, now: () => this.now().getTime() }));
      if (result.status !== 'READY') reject(result.code, result.status === 'UNAVAILABLE' ? 503 : 422);
      const value = ctx.sessions.recheckEvent(owner, id, { ...body, evidence: result.evidence });
      return { value, mutation: 'header' };
    });
  }
}
