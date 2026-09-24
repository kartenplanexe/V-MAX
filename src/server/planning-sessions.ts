import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FormDraft, FormEdit, FormEvent, PublicPlan, minutes, type FormIssue, type PlanningView } from '../shared/planning-form.js';

export type PlanningContext = {
  catalog: { version: string; region_id: string; leaf_ids: string[] };
  visit_policy: { version: string; by_category: Record<string, number>; arrival_buffer_minutes: number };
  point_area?: { south: number; north: number; west: number; east: number };
  map_center?: { lat: number; lon: number };
  modes: readonly ('walking' | 'driving' | 'cycling')[];
  data_mode: 'test' | 'live';
};
type RecordState = { owner: string; context: PlanningContext; view: PlanningView; expires: number;
  events: Map<string, string>; failures: Map<string, PlanningSessionError>; resultExpires: number; inProgress: string | null };
export type PlanningCheckpoint = { version: 1; records: (Omit<RecordState, 'events' | 'failures'> & {
  events: [string, string][]; failures: [string, { code: string; status: number }][] })[]; attempts: [string, number[]][] };
export class PlanningSessionError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
function reject(code: string, status = 409): never { throw new PlanningSessionError(code, status); }
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) reject('INVALID_ACTION', 400);
  return result.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (operation: string, value: unknown) => createHash('sha256').update(operation + canonical(value)).digest('hex');

/** Bounded, volatile single-process implementation. NOT a shared/serverless store.
 * Only a trusted parser/seed adapter can create drafts: no client POST of a full intent.
 * No LLM dependency; all form writes are typed, atomic and revision-bound.
 */
export class PlanningSessions {
  readonly #records = new Map<string, RecordState>();
  readonly #attempts = new Map<string, number[]>();
  readonly #activeOwners = new Set<string>();
  readonly #now: () => Date;
  readonly #plan: (job: Record<string, unknown>) => Promise<unknown>;
  readonly #beforePlan?: () => Promise<void>;
  constructor(options: { now?: () => Date; plan: (job: Record<string, unknown>) => Promise<unknown>;
    checkpoint?: PlanningCheckpoint; beforePlan?: () => Promise<void> }) {
    this.#now = options.now ?? (() => new Date()); this.#plan = options.plan;
    this.#beforePlan = options.beforePlan;
    if (options.checkpoint) {
      if (options.checkpoint.version !== 1) throw new Error('Unsupported planning checkpoint');
      for (const saved of options.checkpoint.records) {
        const r: RecordState = { ...structuredClone(saved), events: new Map(saved.events),
          failures: new Map(saved.failures.map(([key, e]) => [key, new PlanningSessionError(e.code, e.status)])) };
        r.view.draft = FormDraft.parse(r.view.draft);
        // A durable pending receipt means the previous process died. Never repeat provider work implicitly.
        if (r.inProgress) {
          r.failures.set(r.inProgress, new PlanningSessionError('PLAN_INTERRUPTED', 503)); r.inProgress = null;
          if (r.view.phase === 'PLANNING') r.view.phase = 'CONFIRMED';
        }
        this.#records.set(r.view.id, r);
      }
      for (const [owner, times] of options.checkpoint.attempts) this.#attempts.set(owner, times);
      this.#prune();
    }
  }
  /** Persist only under the store's owner lock; contains personal draft state, never API credentials. */
  checkpoint(): PlanningCheckpoint {
    this.#prune();
    return structuredClone({ version: 1, records: [...this.#records.values()].map(r => ({ ...r,
      events: [...r.events], failures: [...r.failures].map(([key, e]) => [key, { code: e.code, status: e.status }] as [string, { code: string; status: number }]) })),
      attempts: [...this.#attempts] });
  }
  #prune() {
    const now = this.#now().getTime();
    for (const [id, record] of this.#records) if (now >= record.expires) this.#records.delete(id);
    for (const [owner, attempts] of this.#attempts) {
      const remaining = attempts.filter(time => now - time < 600_000);
      if (remaining.length) this.#attempts.set(owner, remaining); else this.#attempts.delete(owner);
    }
  }
  #record(owner: string, id: string) {
    this.#prune();
    const record = this.#records.get(id);
    if (!record || record.owner !== owner) reject('DRAFT_NOT_FOUND', 404);
    if (record.view.result && this.#now().getTime() >= record.resultExpires) {
      record.view.result = null; record.view.confirmed_version = null; record.view.phase = 'DRAFT'; record.view.version++;
    }
    return record;
  }
  #issues(record: RecordState): FormIssue[] {
    const { draft } = record.view, issues: FormIssue[] = [];
    const add = (code: string, field: string) => { issues.push({ code, field }); };
    if (!draft.points.origin) add('ORIGIN_REQUIRED', 'points.origin');
    if (draft.shared.mobility?.length !== 1 || !record.context.modes.includes(draft.shared.mobility[0] as 'walking')) add('TRANSPORT_REQUIRED', 'shared.mobility');
    const budget = draft.shared.budget;
    if (budget?.kind === 'limit' && (budget.basis === 'unknown' || budget.period === 'unknown')) add('BUDGET_SCOPE_REQUIRED', 'shared.budget');
    if (draft.shared.destination_text && !draft.points.destination) add('DESTINATION_REQUIRED', 'points.destination');
    if (budget?.kind === 'limit' && budget.basis === 'per_person' && !draft.shared.party?.total) add('PARTY_REQUIRED', 'shared.party.total');
    if (budget?.kind === 'limit' && draft.shared.mobility?.[0] !== 'walking') add('TRANSPORT_COST_POLICY_REQUIRED', 'shared.budget');
    if (draft.shared.party?.child_ages?.length) add('AGE_ELIGIBILITY_NOT_IMPLEMENTED', 'shared.party');
    let parts: Intl.DateTimeFormatPart[];
    try { parts = new Intl.DateTimeFormat('en-GB', { timeZone: draft.locality.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(this.#now()); }
    catch { return [{ code: 'TIMEZONE_REQUIRED', field: 'locality' }]; }
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    const today = `${part('year')}-${part('month')}-${part('day')}`, current = Number(part('hour')) * 60 + Number(part('minute'));
    if (new Set(draft.days.map(d => d.date)).size !== draft.days.length) add('DUPLICATE_DATE', 'days');
    if (new Set(draft.days.map(d => d.day_id)).size !== draft.days.length) add('DUPLICATE_DAY', 'days');
    if (draft.days.reduce((n, d) => n + d.activities.length, 0) > 120) add('TOO_MANY_ACTIVITIES', 'days');
    for (const day of draft.days) {
      const path = `days.${day.day_id}`;
      if (!day.window) add('WINDOW_REQUIRED', `${path}.window`);
      if (day.date < today || day.date === today && day.window && minutes(day.window.start) < current) add('WINDOW_EXPIRED', `${path}.window`);
      if (day.window && day.duration_constraint_minutes != null && minutes(day.window.end) - minutes(day.window.start) !== day.duration_constraint_minutes) add('TIME_CONFLICT', `${path}.window`);
      const activityIds = day.activities.map(a => a.id);
      if (!activityIds.length) add('ACTIVITIES_REQUIRED', path);
      if (new Set(activityIds).size !== activityIds.length) add('DUPLICATE_ACTIVITY', path);
      const graph = new Map(activityIds.map(id => [id, new Set<string>()]));
      for (const [a, b] of day.order) {
        if (!graph.has(a) || !graph.has(b) || a === b) add('INVALID_ORDER', path); else graph.get(a)!.add(b);
      }
      const pending = new Set(activityIds);
      while (pending.size) {
        const roots = [...pending].filter(a => ![...pending].some(b => graph.get(b)!.has(a)));
        if (!roots.length) { add('INVALID_ORDER', path); break; }
        roots.forEach(a => pending.delete(a));
      }
      for (const activity of day.activities) {
        const c = activity.categories, catalog = record.context.catalog;
        if (c.state !== 'matched' || c.region_id !== draft.locality.region_id || c.region_id !== catalog.region_id ||
            c.catalog_version !== catalog.version || !c.include_any.length ||
            [...c.include_any, ...c.exclude].some(id => !catalog.leaf_ids.includes(id)) || c.include_any.some(id => c.exclude.includes(id))) add('CATALOG_MISMATCH', path);
      }
    }
    return issues;
  }
  #view(record: RecordState) {
    return structuredClone({ ...record.view, issues: this.#issues(record) });
  }
  create(owner: string, seed: unknown, context: PlanningContext, provenance: Record<string, string> = {}): PlanningView {
    this.#prune();
    if (!owner || owner.length > 200 || JSON.stringify(seed).length > 128 * 1024) reject('INVALID_SEED', 400);
    if (this.#records.size >= 200 || [...this.#records.values()].filter(r => r.owner === owner).length >= 5) reject('SESSION_CAPACITY', 429);
    const draft = parse(FormDraft, seed), now = this.#now().getTime(), id = randomUUID();
    const record: RecordState = { owner, context: structuredClone(context), expires: now + 1_800_000,
      events: new Map(), failures: new Map(), resultExpires: 0, inProgress: null,
      view: { id, version: 0, phase: 'DRAFT', confirmed_version: null, expires_at: new Date(now + 1_800_000).toISOString(),
        draft, provenance: structuredClone(provenance), issues: [], capabilities: { modes: [...context.modes], data_mode: context.data_mode,
          ...(context.map_center ? { map_center: context.map_center } : {}) }, result: null } };
    this.#records.set(id, record); return this.#view(record);
  }
  get(owner: string, id: string) { return this.#view(this.#record(owner, id)); }
  #event(record: RecordState, operation: string, body: z.infer<typeof FormEvent>, full: unknown) {
    const hash = fingerprint(operation, full), previous = record.events.get(body.event_id);
    if (previous) { if (previous !== hash) reject('EVENT_CONFLICT'); return null; }
    if (record.view.version !== body.base_version) reject('STALE_VERSION');
    if (record.events.size >= 128) reject('EVENT_CAPACITY', 429);
    return hash;
  }
  edit(owner: string, id: string, input: unknown) {
    const record = this.#record(owner, id), body = parse(FormEdit, input);
    const hash = this.#event(record, 'edit', body, body);
    if (hash === null) return this.#view(record);
    const draft = structuredClone(record.view.draft), provenance = { ...record.view.provenance };
    const getDay = (dayId: string) => { const day = draft.days.find(d => d.day_id === dayId); if (!day) reject('UNKNOWN_DAY', 422); return day; };
    for (const change of body.changes) {
      switch (change.op) {
        case 'window':
          for (const dayId of change.day_ids) {
            const day = getDay(dayId); day.window = { start: change.start, end: change.end };
            // Explicitly replacing both boundaries replaces the old inferred duration too.
            if (day.duration_constraint_minutes != null) day.duration_constraint_minutes = minutes(change.end) - minutes(change.start);
            provenance[`days.${dayId}.window`] = 'user_form';
            provenance[`days.${dayId}.window.start`] = 'user_form'; provenance[`days.${dayId}.window.end`] = 'user_form';
          } break;
        case 'date': getDay(change.day_id).date = change.date; provenance[`days.${change.day_id}.date`] = 'user_form'; break;
        case 'mobility':
          if (!record.context.modes.includes(change.mode as 'walking')) reject('UNSUPPORTED_TRANSPORT', 422);
          draft.shared.mobility = [change.mode]; provenance['shared.mobility'] = 'user_form'; break;
        case 'budget': draft.shared.budget = change.value; provenance['shared.budget'] = 'user_form'; break;
        case 'party':
          if (change.total === null) { if (draft.shared.party) delete draft.shared.party.total; }
          else draft.shared.party = { ...draft.shared.party, total: change.total };
          provenance['shared.party.total'] = 'user_form'; break;
        case 'point': {
          const area = record.context.point_area, p = change.point;
          if (!area) reject('POINT_VERIFICATION_UNAVAILABLE', 422);
          if (p.lat < area.south || p.lat > area.north || p.lon < area.west || p.lon > area.east) reject('POINT_OUTSIDE_AREA', 422);
          draft.points[change.field] = { ...p, locality_id: draft.locality.id };
          provenance[`points.${change.field}`] = p.source; break;
        }
        case 'clear_destination': delete draft.points.destination; delete draft.shared.destination_text; provenance['points.destination'] = 'user_form'; break;
        case 'remove_activity': {
          const day = getDay(change.day_id);
          if (!day.activities.some(a => a.id === change.activity_id)) reject('UNKNOWN_ACTIVITY', 422);
          day.activities = day.activities.filter(a => a.id !== change.activity_id);
          day.order = day.order.filter(edge => !edge.includes(change.activity_id));
          provenance[`days.${day.day_id}.activities`] = 'user_form'; break;
        }
        case 'order': {
          const day = getDay(change.day_id), ids = change.activity_ids;
          if (ids.length !== day.activities.length || new Set(ids).size !== ids.length || ids.some(a => !day.activities.some(b => b.id === a))) reject('INVALID_ORDER', 422);
          day.activities = ids.map(id => day.activities.find(activity => activity.id === id)!);
          day.order = ids.slice(1).map((id, i) => [ids[i]!, id]); provenance[`days.${day.day_id}.order`] = 'user_form'; break;
        }
      }
    }
    record.view.draft = parse(FormDraft, draft); // The entire change set commits only after validation.
    record.view.provenance = provenance; record.view.version++; record.view.confirmed_version = null;
    record.view.result = null; record.view.phase = 'DRAFT'; record.events.set(body.event_id, hash);
    return this.#view(record);
  }
  confirm(owner: string, id: string, input: unknown) {
    const record = this.#record(owner, id), body = parse(FormEvent, input), hash = this.#event(record, 'confirm', body, body);
    if (hash === null) return this.#view(record);
    if (record.inProgress) reject('PLAN_IN_PROGRESS');
    if (this.#issues(record).length) reject('INCOMPLETE_DRAFT', 422);
    if (record.view.phase !== 'DRAFT') reject('ALREADY_CONFIRMED');
    record.view.version++; record.view.confirmed_version = record.view.version; record.view.phase = 'CONFIRMED';
    record.events.set(body.event_id, hash); return this.#view(record);
  }
  async calculate(owner: string, id: string, input: unknown) {
    const record = this.#record(owner, id), body = parse(FormEvent, input), hash = this.#event(record, 'calculate', body, body);
    if (hash === null) {
      if (record.inProgress === body.event_id) reject('PLAN_IN_PROGRESS');
      const failure = record.failures.get(body.event_id); if (failure) throw failure;
      return this.#view(record);
    }
    if (record.view.result) reject('RESULT_ALREADY_EXISTS');
    if (record.view.confirmed_version !== body.base_version || this.#issues(record).length) reject('CONFIRMATION_REQUIRED', 422);
    if (record.inProgress || this.#activeOwners.has(owner)) reject('PLAN_IN_PROGRESS');
    if (this.#activeOwners.size >= 2) reject('PLANNER_BUSY', 429);
    const attempts = this.#attempts.get(owner) ?? [];
    if (attempts.length >= 3) reject('PLAN_RATE_LIMIT', 429);
    if (this.#attempts.size >= 200 && !this.#attempts.has(owner)) reject('PLANNER_BUSY', 429);
    // No awaits before lock/revision capture/quota debit: single-process atomicity only.
    this.#activeOwners.add(owner); this.#attempts.set(owner, [...attempts, this.#now().getTime()]);
    record.inProgress = body.event_id; record.events.set(body.event_id, hash); record.view.phase = 'PLANNING';
    const version = record.view.version;
    const job = { schema_version: 'place-selection.v1', intent: { ...structuredClone(record.view.draft),
      schema_version: 'confirmed-daily-intent.research.v1', session_id: id, draft_revision: version },
      catalog: structuredClone(record.context.catalog), visit_policy: structuredClone(record.context.visit_policy) };
    try {
      await this.#beforePlan?.();
      const output = await this.#plan(job);
      if (this.#record(owner, id) !== record || record.view.version !== version) reject('STALE_RESULT');
      record.view.result = PublicPlan.parse(output); record.resultExpires = this.#now().getTime() + 300_000;
      record.view.phase = 'RESULT'; return this.#view(record);
    } catch (error) {
      if (record.view.version === version && record.view.phase === 'PLANNING') record.view.phase = 'CONFIRMED';
      const failure = error instanceof PlanningSessionError ? error : new PlanningSessionError('PLANNING_FAILED', 503);
      record.failures.set(body.event_id, failure); throw failure;
    } finally { record.inProgress = null; this.#activeOwners.delete(owner); }
  }
}
