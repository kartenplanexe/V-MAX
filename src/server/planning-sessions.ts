import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { clarificationReview } from '../shared/clarification-review.js';
import { FormDraft, FormEdit, FormEvent, CalculateInput, PublicPlan, minutes, isEventActivity, type FormIssue, type PlanningView } from '../shared/planning-form.js';
import { ACTIVITY_INTENT_POLICY, classifyActivityIntent } from './activity-intent.js';
import { PreviewAlternativeInputSchema, ApplyAlternativeInputSchema, type AlternativePreview } from '../shared/route-alternatives.js';
import { replacementRoster, matchesReplacement, planFreshUntil, alternativeDelta } from './route-alternatives.js';
import { SelectedEventTargetSchema, SelectedEventDisplaySchema, type SelectedEventTarget } from '../shared/event-selection.js';
import { choicesFromCatalog, catalogActivity } from './activity-choices.js';
import { orderWithoutActivity, validActivityOrder } from '../shared/activity-order.js';
import { agreedVisitMinutes, VISIT_DURATION_POLICY, WALK_STOP_MINUTES } from './visit-duration-policy.js';
import { WALK_DISCOVERY_POLICY, walkRubricScores } from './walk-discovery-policy.js';

const EventEvidenceSchema = z.object({ date: z.string(), valid_until: z.string().datetime(),
  point: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict(),
  display: SelectedEventDisplaySchema }).strict();
type EventEvidence = z.infer<typeof EventEvidenceSchema>;
const SelectEventInput = FormEvent.extend({ day_id: z.string().min(1).max(128), replace_activity_id: z.string().min(1).max(128).optional(),
  target: SelectedEventTargetSchema, evidence: EventEvidenceSchema }).strict();
const RecheckEventInput = FormEvent.extend({ day_id: z.string().min(1).max(128), activity_id: z.string().min(1).max(128),
  evidence: EventEvidenceSchema }).strict();
const eventKey = (dayId: string, activityId: string) => JSON.stringify([dayId, activityId]);

export type PlanningContext = {
  catalog: { version: string; region_id: string; leaf_ids: string[]; category_names?: Record<string, string> };
  visit_policy: { version: string; by_category: Record<string, number>; walkable_category_ids?: string[];
    park_category_ids?: string[];
    arrival_buffer_minutes: number };
  point_area?: { south: number; north: number; west: number; east: number };
  map_center?: { lat: number; lon: number };
  modes: readonly ('walking' | 'driving' | 'cycling' | 'public_transport')[];
  data_mode: 'test' | 'live';
};
type RecordState = { owner: string; context: PlanningContext; view: PlanningView; expires: number; retained?: boolean;
  events: Map<string, string>; failures: Map<string, PlanningSessionError>; resultExpires: number; inProgress: string | null;
  eventChecks?: Record<string, EventEvidence & { target_hash: string }>;
  alternative?: { event_id: string; preview: AlternativePreview } };
export type PlanningCheckpoint = { version: 1 | 2; records: (Omit<RecordState, 'events' | 'failures'> & {
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

// In-memory session logic; DurablePlanning provides persistence and cross-process locking.
export class PlanningSessions {
  readonly #records = new Map<string, RecordState>();
  readonly #activeOwners = new Set<string>();
  readonly #now: () => Date;
  readonly #plan: (job: Record<string, unknown>) => Promise<unknown>;
  readonly #beforePlan?: () => Promise<void>;
  constructor(options: { now?: () => Date; plan: (job: Record<string, unknown>) => Promise<unknown>;
    checkpoint?: PlanningCheckpoint; beforePlan?: () => Promise<void> }) {
    this.#now = options.now ?? (() => new Date()); this.#plan = options.plan;
    this.#beforePlan = options.beforePlan;
    if (options.checkpoint) {
      if (![1, 2].includes(options.checkpoint.version)) throw new Error('Unsupported planning checkpoint');
      for (const saved of options.checkpoint.records) {
        const r: RecordState = { ...structuredClone(saved), events: new Map(saved.events),
          failures: new Map(saved.failures.map(([key, e]) => [key, new PlanningSessionError(e.code, e.status)])) };
        r.view.draft = FormDraft.parse(r.view.draft);
        if (r.view.result?.status === 'PLACES_FOUND') r.retained = true;
        const evidence = z.record(z.string(), EventEvidenceSchema.extend({ target_hash: z.string() })).safeParse(r.eventChecks ?? {});
        r.eventChecks = evidence.success ? evidence.data : {};
        delete r.view.event_previews; // Public displays are always derived from still-valid bound evidence.
        // A durable pending receipt means the previous process died. Never repeat provider work implicitly.
        if (r.inProgress) {
          r.failures.set(r.inProgress, new PlanningSessionError('PLAN_INTERRUPTED', 503)); r.inProgress = null;
          if (r.view.phase === 'PLANNING') r.view.phase = 'CONFIRMED';
        }
        this.#records.set(r.view.id, r);
      }
      this.#prune();
    }
  }
  /** Persist only under the store's owner lock; contains personal draft state, never API credentials. */
  checkpoint(): PlanningCheckpoint {
    this.#prune();
    // Reject checkpoints with unknown unresolved fields rather than silently dropping them.
    const version = [...this.#records.values()].some(r => r.view.draft.clarifications?.length) ? 2 : 1;
    return structuredClone({ version, records: [...this.#records.values()].map(r => ({ ...r,
      events: [...r.events], failures: [...r.failures].map(([key, e]) => [key, { code: e.code, status: e.status }] as [string, { code: string; status: number }]) })),
      attempts: [] }); // Retained for compatibility with existing version-1 checkpoints.
  }
  #prune() {
    const now = this.#now().getTime();
    for (const [id, record] of this.#records) {
      if (!record.retained && now >= record.expires) this.#records.delete(id);
      else {
        if (record.alternative && now >= Date.parse(record.alternative.preview.expires_at)) delete record.alternative;
        for (const [key, check] of Object.entries(record.eventChecks ?? {}))
          if (now >= Date.parse(check.valid_until)) delete record.eventChecks![key];
      }
    }
  }
  #record(owner: string, id: string) {
    this.#prune();
    const record = this.#records.get(id);
    if (!record || record.owner !== owner) reject('DRAFT_NOT_FOUND', 404);
    if (record.retained && this.#now().getTime() >= record.expires) {
      record.expires = this.#now().getTime() + 1_800_000;
      record.view.expires_at = new Date(record.expires).toISOString();
    }
    if (record.view.result && record.view.result.status !== 'PLACES_FOUND' && this.#now().getTime() >= record.resultExpires) {
      record.view.result = null; record.view.confirmed_version = null; record.view.phase = 'DRAFT'; record.view.version++;
      delete record.alternative;
    }
    return record;
  }
  #issues(record: RecordState): FormIssue[] {
    const { draft } = record.view, issues: FormIssue[] = [];
    const add = (code: string, field: string) => { issues.push({ code, field }); };
    for (const question of draft.clarifications ?? []) add('INPUT_CLARIFICATION_REQUIRED', `clarifications.${question.id}`);
    if (!draft.points.origin) add('ORIGIN_REQUIRED', 'points.origin');
    if (draft.shared.mobility?.length !== 1 || !record.context.modes.includes(draft.shared.mobility[0] as 'walking')) add('TRANSPORT_REQUIRED', 'shared.mobility');
    const budget = draft.shared.budget;
    if (budget?.kind === 'limit' && (budget.basis === 'unknown' || budget.period === 'unknown')) add('BUDGET_SCOPE_REQUIRED', 'shared.budget');
    if (draft.shared.destination_text && !draft.points.destination) add('DESTINATION_REQUIRED', 'points.destination');
    if (budget?.kind === 'limit' && (budget.basis === 'per_person' || budget.enforcement === 'estimated') && !draft.shared.party?.total) add('PARTY_REQUIRED', 'shared.party.total');
    if (draft.shared.party?.child_ages?.length) {
      if (!draft.shared.party.total && !issues.some(issue => issue.code === 'PARTY_REQUIRED')) add('PARTY_REQUIRED', 'shared.party.total');
      else if (draft.shared.party.total && draft.shared.party.child_ages.length > draft.shared.party.total) add('PARTY_SIZE_CONFLICT', 'shared.party');
    }
    if (budget?.kind === 'limit' && budget.enforcement === 'estimated' && budget.price_basis_assumption !== 'per_person') add('BUDGET_PRICE_BASIS_REQUIRED', 'shared.budget');
    if (budget?.kind === 'limit' && draft.shared.mobility?.[0] !== 'walking') add('TRANSPORT_COST_POLICY_REQUIRED', 'shared.budget');
    // Unknown age restrictions require review.
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
        if (isEventActivity(activity)) {
          if (!this.#eventCheck(record, day.day_id, activity.id, day.date, activity.target))
            add('EVENT_RECHECK_REQUIRED', `${path}.activities.${activity.id}`);
          continue;
        }
        const kind = activity.intent_kind ?? classifyActivityIntent({ label: activity.label, namedTypes: activity.selection.named_types });
        if (kind === 'route_walk' && draft.shared.mobility?.length === 1 && draft.shared.mobility[0] !== 'walking')
          add('WALK_ROUTE_REQUIRES_WALKING', 'shared.mobility');
        const c = activity.categories, catalog = record.context.catalog;
        if (c.state !== 'matched' || c.region_id !== draft.locality.region_id || c.region_id !== catalog.region_id ||
            c.catalog_version !== catalog.version || !c.include_any.length ||
            [...c.include_any, ...c.exclude].some(id => !catalog.leaf_ids.includes(id)) || c.include_any.some(id => c.exclude.includes(id))) add('CATALOG_MISMATCH', `${path}.activities.${activity.id}`);
      }
    }
    return issues;
  }
  #view(record: RecordState) {
    const event_previews: NonNullable<PlanningView['event_previews']> = {};
    for (const day of record.view.draft.days) for (const activity of day.activities) if (isEventActivity(activity)) {
      const check = this.#eventCheck(record, day.day_id, activity.id, day.date, activity.target);
      if (check) event_previews[eventKey(day.day_id, activity.id)] = check.display;
    }
    return structuredClone({ ...record.view, issues: this.#issues(record),
      ...(Object.keys(event_previews).length ? { event_previews } : {}) });
  }
  #eventCheck(record: RecordState, dayId: string, activityId: string, date: string, target: SelectedEventTarget) {
    const check = record.eventChecks?.[eventKey(dayId, activityId)];
    return check && check.date === date && check.target_hash === fingerprint('selectedEvent', target) &&
      Date.parse(check.valid_until) > this.#now().getTime() ? check : null;
  }
  #validateEventEvidence(record: RecordState, date: string, target: SelectedEventTarget, evidence: EventEvidence) {
    const display = evidence.display, ref = display.event_ref;
    if (date !== evidence.date || display.date !== date || ref.provider !== target.provider ||
        ref.event_id !== target.event_id || ref.occurrence_key !== target.occurrence_key ||
        display.point.lat !== evidence.point.lat || display.point.lon !== evidence.point.lon)
      reject('EVENT_SELECTION_CHANGED', 422);
    if (display.schedule.kind === 'fixed' ? target.visit_duration_minutes !== undefined || display.duration.basis !== 'provider_session'
      : target.visit_duration_minutes === undefined || display.duration.basis !== 'user_estimate' || display.duration.minutes !== target.visit_duration_minutes)
      reject('EVENT_DURATION_REQUIRED', 422);
    const until = Date.parse(evidence.valid_until), maximum = Math.min(record.expires, this.#now().getTime() + 300_000,
      Date.parse(display.source.valid_until), display.venue_source ? Date.parse(display.venue_source.valid_until) : Infinity);
    if (until <= this.#now().getTime() || until > maximum) reject('EVENT_PREVIEW_EXPIRED', 410);
    const area = record.context.point_area, point = evidence.point;
    if (area && (point.lat < area.south || point.lat > area.north || point.lon < area.west || point.lon > area.east))
      reject('EVENT_OUTSIDE_LOCALITY', 422);
  }
  // EventPlanning resolves opaque choices before supplying source facts.
  selectEvent(owner: string, id: string, input: unknown): PlanningView {
    const record = this.#record(owner, id), body = parse(SelectEventInput, input);
    const hash = this.#event(record, 'selectEvent', body, body);
    if (hash === null) return this.#view(record);
    if (record.inProgress) reject('PLAN_IN_PROGRESS');
    const draft = structuredClone(record.view.draft), day = draft.days.find(day => day.day_id === body.day_id);
    if (!day) reject('UNKNOWN_DAY', 422);
    const previous = body.replace_activity_id ? day.activities.find(activity => activity.id === body.replace_activity_id) : undefined;
    if (body.replace_activity_id && !previous) reject('UNKNOWN_ACTIVITY', 422);
    this.#validateEventEvidence(record, day.date, body.target, body.evidence);
    const activity = { id: previous?.id ?? randomUUID(), label: 'Выбранное событие', requirements: previous?.requirements ?? [],
      intent_kind: 'event_visit' as const, target: body.target };
    if (previous) day.activities = day.activities.map(item => item.id === previous.id ? activity : item);
    else day.activities.push(activity);
    if (draft.days.reduce((count, day) => count + day.activities.length, 0) > 120) reject('TOO_MANY_ACTIVITIES', 422);
    record.view.draft = parse(FormDraft, draft);
    record.eventChecks ??= {};
    record.eventChecks[eventKey(day.day_id, activity.id)] = { ...structuredClone(body.evidence), target_hash: fingerprint('selectedEvent', body.target) };
    record.view.provenance[`days.${day.day_id}.activities`] = 'user_form';
    this.#finishEventChange(record, body.event_id, hash);
    return this.#view(record);
  }
  recheckEvent(owner: string, id: string, input: unknown): PlanningView {
    const record = this.#record(owner, id), body = parse(RecheckEventInput, input);
    const hash = this.#event(record, 'recheckEvent', body, body);
    if (hash === null) return this.#view(record);
    if (record.inProgress) reject('PLAN_IN_PROGRESS');
    const day = record.view.draft.days.find(day => day.day_id === body.day_id);
    const activity = day?.activities.find(activity => activity.id === body.activity_id);
    if (!day || !activity || !isEventActivity(activity)) reject('UNKNOWN_EVENT_ACTIVITY', 422);
    this.#validateEventEvidence(record, day.date, activity.target, body.evidence);
    record.eventChecks ??= {};
    record.eventChecks[eventKey(day.day_id, activity.id)] = { ...structuredClone(body.evidence), target_hash: fingerprint('selectedEvent', activity.target) };
    this.#finishEventChange(record, body.event_id, hash);
    return this.#view(record);
  }
  #finishEventChange(record: RecordState, eventId: string, hash: string) {
    record.view.version++; record.view.confirmed_version = null; record.view.phase = 'DRAFT'; record.view.result = null;
    record.events.set(eventId, hash); delete record.alternative;
  }
  create(owner: string, seed: unknown, context: PlanningContext, provenance: Record<string, string> = {}): PlanningView {
    return this.#create(owner, randomUUID(), 0, seed, context, provenance);
  }
  // Restore remapped conditions with a revision newer than every previous view.
  restoreDraft(owner: string, id: string, version: number, seed: unknown, context: PlanningContext,
    provenance: Record<string, string> = {}): PlanningView {
    this.#prune();
    const current = this.#records.get(id);
    if (current && current.owner !== owner) reject('DRAFT_NOT_FOUND', 404);
    if (current?.inProgress) reject('PLAN_IN_PROGRESS');
    if (!id || id.length > 128 || !Number.isSafeInteger(version) || version < 1 || current && version <= current.view.version)
      reject('INVALID_RESTORE', 400);
    return this.#create(owner, id, version, seed, context, provenance);
  }
  #create(owner: string, id: string, version: number, seed: unknown, context: PlanningContext,
    provenance: Record<string, string>): PlanningView {
    this.#prune();
    if (!owner || owner.length > 200 || JSON.stringify(seed).length > 128 * 1024) reject('INVALID_SEED', 400);
    const draft = parse(FormDraft, seed), now = this.#now().getTime();
    const record: RecordState = { owner, context: structuredClone(context), expires: now + 1_800_000,
      events: new Map(), failures: new Map(), resultExpires: 0, inProgress: null,
      view: { id, version, phase: 'DRAFT', confirmed_version: null, expires_at: new Date(now + 1_800_000).toISOString(),
        draft, provenance: structuredClone(provenance), issues: [], capabilities: { modes: [...context.modes], data_mode: context.data_mode,
          ...(context.map_center ? { map_center: context.map_center } : {}) }, result: null } };
    this.#records.set(id, record); return this.#view(record);
  }
  get(owner: string, id: string) { return this.#view(this.#record(owner, id)); }
  activityOptions(owner: string, id: string) {
    const record = this.#record(owner, id);
    if (!record.context.catalog.category_names) reject('ACTIVITY_OPTIONS_UNAVAILABLE', 503);
    return choicesFromCatalog(record.context, record.view.draft.locality.name);
  }
  remove(owner: string, id: string) {
    this.#record(owner, id);
    this.#records.delete(id);
  }
  #event(record: RecordState, operation: string, body: z.infer<typeof FormEvent>, full: unknown) {
    const hash = fingerprint(operation, full), previous = record.events.get(body.event_id);
    if (previous) { if (previous !== hash) reject('EVENT_CONFLICT'); return null; }
    if (record.view.version !== body.base_version) reject('STALE_VERSION');
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
        case 'activity_details': {
          const day = getDay(change.day_id), activity = day.activities.find(value => value.id === change.activity_id);
          if (!activity || isEventActivity(activity)) reject('UNKNOWN_ACTIVITY', 422);
          if (change.duration_minutes === null) delete activity.duration_minutes;
          else activity.duration_minutes = change.duration_minutes;
          activity.requirements = structuredClone(change.requirements);
          provenance[`days.${day.day_id}.activities`] = 'user_form';
          break;
        }
        case 'discard_clarification': {
          const question = draft.clarifications?.find(value => value.id === change.clarification_id);
          if (!question) reject('CLARIFICATION_NOT_FOUND', 422);
          draft.clarifications = draft.clarifications!.filter(value => value.id !== question.id);
          if (!draft.clarifications.length) delete draft.clarifications;
          provenance[`clarifications.${question.id}`] = 'user_discarded';
          break;
        }
        case 'resolve_clarification': {
          const question = draft.clarifications?.find(value => value.id === change.clarification_id);
          if (!question) reject('CLARIFICATION_NOT_FOUND', 422);
          if (!clarificationReview(draft, question)?.ready) reject('CLARIFICATION_VALUE_REQUIRED', 422);
          draft.clarifications = draft.clarifications!.filter(value => value.id !== question.id);
          if (!draft.clarifications.length) delete draft.clarifications;
          break;
        }
        case 'activity_choice': {
          const day = getDay(change.day_id), old = day.activities.find(activity => activity.id === change.activity_id);
          if (!old || isEventActivity(old)) reject('UNKNOWN_ACTIVITY', 422);
          const options = this.activityOptions(owner, id);
          if (change.catalog_version !== options.catalog_version) reject('MANUAL_CATALOG_CHANGED', 422);
          const replacement = catalogActivity(change.choice, old.id, record.context, options, code => reject(code, 422));
          if (old.categories.exclude.length && (old.categories.catalog_version !== record.context.catalog.version ||
              old.categories.exclude.some(value => !record.context.catalog.leaf_ids.includes(value) || replacement.categories.include_any.includes(value))))
            reject('ACTIVITY_EXCLUSIONS_REVIEW_REQUIRED', 422);
          replacement.categories.exclude = [...old.categories.exclude];
          day.activities = day.activities.map(activity => activity.id === old.id ? { ...replacement, duration_minutes: old.duration_minutes, requirements: structuredClone(old.requirements) } : activity);
          provenance[`days.${day.day_id}.activities`] = 'user_form';
          break;
        }
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
          if (provenance['shared.search_radius_meters'] === 'default_taxi') {
            delete draft.shared.search_radius_meters;
            delete provenance['shared.search_radius_meters'];
          }
          draft.shared.mobility = [change.mode]; provenance['shared.mobility'] = 'user_form'; break;
        case 'budget': draft.shared.budget = change.value; provenance['shared.budget'] = 'user_form'; break;
        case 'search_radius': draft.shared.search_radius_meters = change.meters; provenance['shared.search_radius_meters'] = 'user_form'; break;
        case 'party':
          if (change.total === null) { if (draft.shared.party) delete draft.shared.party.total; }
          else draft.shared.party = { ...draft.shared.party, total: change.total };
          if (change.child_ages !== undefined) {
            if (change.child_ages === null) { if (draft.shared.party) delete draft.shared.party.child_ages; }
            else draft.shared.party = { ...draft.shared.party, child_ages: [...change.child_ages] };
            provenance['shared.party.child_ages'] = 'user_form';
          }
          provenance['shared.party.total'] = 'user_form'; break;
        case 'point': {
          const area = record.context.point_area, p = change.point;
          if (!area) reject('POINT_VERIFICATION_UNAVAILABLE', 422);
          if (p.lat < area.south || p.lat > area.north || p.lon < area.west || p.lon > area.east) reject('POINT_OUTSIDE_AREA', 422);
          draft.points[change.field] = { ...p, locality_id: draft.locality.id };
          if (p.source === 'user_map' || p.source === 'user_geolocation') {
            delete draft.shared[`${change.field}_text`]; delete provenance[`shared.${change.field}_text`];
          }
          provenance[`points.${change.field}`] = p.source; break;
        }
        case 'clear_destination': delete draft.points.destination; delete draft.shared.destination_text; provenance['points.destination'] = 'user_form'; break;
        case 'remove_activity': {
          const day = getDay(change.day_id);
          if (!day.activities.some(a => a.id === change.activity_id)) reject('UNKNOWN_ACTIVITY', 422);
          day.activities = day.activities.filter(a => a.id !== change.activity_id);
          day.order = orderWithoutActivity(day.order, change.activity_id);
          provenance[`days.${day.day_id}.activities`] = 'user_form'; break;
        }
        case 'activities': {
          const day = getDay(change.day_id);
          const originalIds = new Set(day.activities.map(a => a.id));
          for (const id of change.remove_ids) {
            if (!originalIds.has(id)) reject('UNKNOWN_ACTIVITY', 422);
            day.activities = day.activities.filter(a => a.id !== id);
            day.order = orderWithoutActivity(day.order, id);
          }
          const options = change.additions.length ? this.activityOptions(owner, id) : undefined;
          for (const addition of change.additions) {
            if (originalIds.has(addition.activity_id) || day.activities.some(a => a.id === addition.activity_id)) reject('DUPLICATE_ACTIVITY', 422);
            if (addition.catalog_version !== options!.catalog_version) reject('MANUAL_CATALOG_CHANGED', 422);
            day.activities.push(catalogActivity(addition.choice, addition.activity_id, record.context, options!, code => reject(code, 422)));
          }
          provenance[`days.${day.day_id}.activities`] = 'user_form'; break;
        }
        case 'order': {
          const day = getDay(change.day_id), ids = change.activity_ids;
          if (ids.length !== day.activities.length || new Set(ids).size !== ids.length || ids.some(a => !day.activities.some(b => b.id === a))) reject('INVALID_ORDER', 422);
          const precedence: [string, string][] = change.precedence ?? ids.slice(1).map((id, i) => [ids[i]!, id]);
          if (!validActivityOrder(ids, precedence)) reject('INVALID_ORDER', 422);
          day.activities = ids.map(id => day.activities.find(activity => activity.id === id)!);
          day.order = precedence; provenance[`days.${day.day_id}.order`] = 'user_form'; break;
        }
      }
    }
    if (draft.shared.party?.total && (draft.shared.party.child_ages?.length ?? 0) > draft.shared.party.total) reject('PARTY_SIZE_CONFLICT', 422);
    if (draft.days.reduce((sum, day) => sum + day.activities.length, 0) > 120) reject('TOO_MANY_ACTIVITIES', 422);
    if (body.changes.some(change => change.op === 'activities' && change.additions.some(a => a.choice.kind === 'walk')) && draft.shared.mobility?.[0] !== 'walking')
      reject('WALK_ROUTE_REQUIRES_WALKING', 422);
    record.view.draft = parse(FormDraft, draft); // The entire change set commits only after validation.
    record.view.provenance = provenance; record.view.version++; record.view.confirmed_version = null;
    record.view.result = null; record.view.phase = 'DRAFT'; record.events.set(body.event_id, hash);
    for (const [key] of Object.entries(record.eventChecks ?? {})) {
      const relevant = record.view.draft.days.some(day => day.activities.some(activity =>
        isEventActivity(activity) && key === eventKey(day.day_id, activity.id) && this.#eventCheck(record, day.day_id, activity.id, day.date, activity.target)));
      if (!relevant) delete record.eventChecks![key];
    }
    delete record.alternative;
    return this.#view(record);
  }
  confirm(owner: string, id: string, input: unknown) {
    const record = this.#record(owner, id), body = parse(FormEvent, input), hash = this.#event(record, 'confirm', body, body);
    if (hash === null) return this.#view(record);
    if (record.inProgress) reject('PLAN_IN_PROGRESS');
    if (this.#issues(record).length) reject('INCOMPLETE_DRAFT', 422);
    if (record.view.phase !== 'DRAFT') reject('ALREADY_CONFIRMED');
    record.view.version++; record.view.confirmed_version = record.view.version; record.view.phase = 'CONFIRMED';
    delete record.alternative;
    record.events.set(body.event_id, hash); return this.#view(record);
  }
  #job(record: RecordState) {
    const draft = record.view.draft;
      // Outdoor stops use an editable default when category durations are absent.
      const planDraft = structuredClone(draft);
      const visitPolicy = structuredClone(record.context.visit_policy);
      if (record.context.data_mode === 'live' && record.context.catalog.category_names) {
        // Update old draft defaults without changing the saved result.
        for (const [id, name] of Object.entries(record.context.catalog.category_names)) {
          const estimate = agreedVisitMinutes(name);
          if (estimate !== undefined) visitPolicy.by_category[id] = estimate;
        }
        visitPolicy.version = VISIT_DURATION_POLICY;
      }
      const leaves = new Set(record.context.catalog.leaf_ids);
      // For legacy drafts, use only fallback IDs present in the current regional catalog.
      const legacyWalkIds = ['111526', '112594', '112668', '112720', '112900', '112901',
        '112905', '112906', '112907', '112912', '112918', '112926', '113289', '113292',
        '113468', '113471', '114018', '168', '24169', '24353'];
      const walkIds = (record.context.visit_policy.walkable_category_ids ?? legacyWalkIds)
        .filter(id => leaves.has(id));
      const parkIds = (record.context.visit_policy.park_category_ids ?? ['168'])
        .filter(id => leaves.has(id));
      const walkSet = new Set(walkIds);
      const by_activity: Record<string, number> = {};
      const max_stops_by_activity: Record<string, number> = {};
      const walk_travel_target_minutes_by_day: Record<string, number> = {};
      for (const day of planDraft.days) for (const activity of day.activities) {
        if (isEventActivity(activity)) continue;
        const kind = activity.intent_kind ?? classifyActivityIntent({ label: activity.label,
          namedTypes: activity.selection.named_types });
        if (kind === 'place_visit') {
          if (/(?<!\p{L})природ[а-яё]*(?!\p{L})/iu.test(activity.label) &&
              activity.categories.include_any.some(id => walkSet.has(id)))
            by_activity[activity.id] = activity.duration_minutes ?? 60;
          continue;
        }
        const areaWalk = kind === 'area_walk';
        activity.intent_kind = kind;
        const allowed = areaWalk ? new Set(parkIds) : walkSet;
        const safeIds = activity.categories.include_any.filter(id => allowed.has(id) && !activity.categories.exclude.includes(id));
        const generalWalk = kind === 'route_walk' && activity.selection.category_policy === 'related_allowed' &&
          activity.selection.named_types.length === 0;
        const categories = areaWalk ? parkIds.filter(id => !activity.categories.exclude.includes(id))
          : generalWalk ? walkIds.filter(id => !activity.categories.exclude.includes(id))
          : safeIds.length ? safeIds : activity.selection.category_policy === 'named_types_only'
          ? [] : walkIds.filter(id => !activity.categories.exclude.includes(id));
        if (!categories.length) reject('WALK_CATEGORY_UNAVAILABLE', 422);
        activity.categories.include_any = categories;
        const routeWalk = kind === 'route_walk' &&
          !!day.window && minutes(day.window.end) - minutes(day.window.start) >= 2 * WALK_STOP_MINUTES;
        by_activity[activity.id] = activity.duration_minutes ?? WALK_STOP_MINUTES;
        if (routeWalk) {
          const window = minutes(day.window!.end) - minutes(day.window!.start);
          // Visit time gives an upper bound; the solver also accounts for travel.
          const cap = Math.floor(window / by_activity[activity.id]!);
          if (cap >= 2) max_stops_by_activity[activity.id] = Math.min(120, cap);
          // A soft duration target may produce a shorter route.
          walk_travel_target_minutes_by_day[day.day_id] = Math.min(50, Math.max(15, Math.round(window * 0.3)));
        }
      }
      return { schema_version: 'place-selection.v1', intent: { ...planDraft,
        schema_version: 'confirmed-daily-intent.research.v1', session_id: record.view.id, draft_revision: record.view.version },
        ...(record.context.point_area ? { point_area: structuredClone(record.context.point_area) } : {}),
        event_evidence: planDraft.days.flatMap(day => day.activities.flatMap(activity => {
          if (!isEventActivity(activity)) return [];
          const check = this.#eventCheck(record, day.day_id, activity.id, day.date, activity.target);
          return check ? [{ day_id: day.day_id, activity_id: activity.id, target: activity.target,
            point: check.point, date: check.date, valid_until: check.valid_until }] : [];
        })),
        catalog: { version: record.context.catalog.version, region_id: record.context.catalog.region_id,
          leaf_ids: [...record.context.catalog.leaf_ids] }, visit_policy: {
          ...visitPolicy, by_activity, max_stops_by_activity,
          walk_discovery_policy: WALK_DISCOVERY_POLICY,
          walk_rubric_scores: walkRubricScores(walkIds, record.context.catalog.category_names),
          walk_travel_target_minutes_by_day, activity_intent_policy: ACTIVITY_INTENT_POLICY,
          tentative_schedule_category_ids: walkIds } };
  }
  async previewAlternative(owner: string, id: string, input: unknown): Promise<AlternativePreview> {
    const record = this.#record(owner, id), body = parse(PreviewAlternativeInputSchema, input);
    const hash = this.#event(record, 'previewAlternative', body, body);
    if (hash === null) {
      if (record.inProgress === body.event_id) reject('PLAN_IN_PROGRESS');
      const failed = record.failures.get(body.event_id); if (failed) throw failed;
      if (record.alternative?.event_id !== body.event_id || record.alternative.preview.base_version !== record.view.version)
        reject('ALTERNATIVE_EXPIRED', 410);
      return structuredClone(record.alternative.preview);
    }
    if (!record.view.result || record.view.phase !== 'RESULT') reject('RESULT_REQUIRED', 422);
    if (record.view.draft.days.find(day => day.day_id === body.day_id)?.activities.some(activity =>
      activity.id === body.activity_id && isEventActivity(activity))) reject('EVENT_RESELECT_REQUIRED', 422);
    if (this.#issues(record).length) reject('CONFIRMATION_REQUIRED', 422);
    if (record.inProgress || this.#activeOwners.has(owner)) reject('PLAN_IN_PROGRESS');
    if (this.#activeOwners.size >= 2) reject('PLANNER_BUSY', 429);
    const before = structuredClone(record.view.result), target = { day_id: body.day_id, activity_id: body.activity_id, place_id: body.place_id };
    const replacement = replacementRoster(before, target);
    if (!replacement) reject('UNKNOWN_STOP', 422);
    const expires = Math.min(record.expires, record.resultExpires, planFreshUntil(before));
    if (expires <= this.#now().getTime()) reject('ALTERNATIVE_EXPIRED', 410);
    const version = record.view.version;
    this.#activeOwners.add(owner); record.inProgress = body.event_id; record.events.set(body.event_id, hash);
    delete record.alternative;
    try {
      const job = { ...this.#job(record), replacement };
      await this.#beforePlan?.();
      const output = PublicPlan.parse(await this.#plan(job));
      if (this.#record(owner, id) !== record || record.view.version !== version) reject('STALE_RESULT');
      const expiresAt = Math.min(expires, this.#now().getTime() + 300_000,
        ['AVAILABLE', 'LIMITED'].includes(output.status) ? planFreshUntil(output) : expires);
      if (expiresAt <= this.#now().getTime()) reject('ALTERNATIVE_EXPIRED', 410);
      const valid = matchesReplacement(before, output, target);
      const preview: AlternativePreview = { draft_id: id, base_version: version, target,
        expires_at: new Date(expiresAt).toISOString(),
        alternatives: valid ? [{ id: randomUUID(), result: output, delta: alternativeDelta(before, output, target) }] : [],
        issues: valid ? [] : output.issues?.length ? output.issues : ['REPLACEMENT_UNAVAILABLE'] };
      record.alternative = { event_id: body.event_id, preview };
      return structuredClone(preview);
    } catch (error) {
      const failure = error instanceof PlanningSessionError ? error : new PlanningSessionError('ALTERNATIVE_PREVIEW_FAILED', 503);
      record.failures.set(body.event_id, failure); throw failure;
    } finally { record.inProgress = null; this.#activeOwners.delete(owner); }
  }
  applyAlternative(owner: string, id: string, input: unknown) {
    const record = this.#record(owner, id), body = parse(ApplyAlternativeInputSchema, input);
    const hash = this.#event(record, 'applyAlternative', body, body);
    if (hash === null) return this.#view(record);
    if (record.inProgress) reject('PLAN_IN_PROGRESS');
    if (this.#issues(record).length) reject('CONFIRMATION_REQUIRED', 422);
    const preview = record.alternative?.preview;
    if (!preview || preview.base_version !== record.view.version || Date.parse(preview.expires_at) <= this.#now().getTime())
      reject('ALTERNATIVE_EXPIRED', 410);
    const alternative = preview.alternatives.find(option => option.id === body.alternative_id);
    if (!alternative) reject('ALTERNATIVE_NOT_FOUND', 404);
    if (!record.view.result || planFreshUntil(alternative.result) <= this.#now().getTime()) reject('ALTERNATIVE_EXPIRED', 410);
    record.view.result = structuredClone(alternative.result);
    record.resultExpires = Date.parse(preview.expires_at);
    record.view.version++; record.view.confirmed_version = record.view.version; record.view.phase = 'RESULT';
    record.events.set(body.event_id, hash); delete record.alternative;
    return this.#view(record);
  }
  async calculate(owner: string, id: string, input: unknown) {
    const record = this.#record(owner, id), body = parse(CalculateInput, input), hash = this.#event(record, 'calculate', body, body);
    if (hash === null) {
      if (record.inProgress === body.event_id) reject('PLAN_IN_PROGRESS');
      const failure = record.failures.get(body.event_id); if (failure) throw failure;
      return this.#view(record);
    }
    if (record.view.result && !body.refresh) reject('RESULT_ALREADY_EXISTS');
    if (record.view.confirmed_version !== body.base_version || this.#issues(record).length) reject('CONFIRMATION_REQUIRED', 422);
    if (record.inProgress || this.#activeOwners.has(owner)) reject('PLAN_IN_PROGRESS');
    if (this.#activeOwners.size >= 2) reject('PLANNER_BUSY', 429);
    if (record.view.result) {
      // A new calculation clears the result and invalidates old callbacks, retaining confirmation.
      record.view.result = null; record.resultExpires = 0;
      record.view.version++; record.view.confirmed_version = record.view.version;
    }
    // No awaits before lock/revision capture: single-process atomicity only.
    this.#activeOwners.add(owner);
    record.inProgress = body.event_id; record.events.set(body.event_id, hash); record.view.phase = 'PLANNING';
    delete record.alternative;
    const version = record.view.version;
    try {
      const job = this.#job(record);
      await this.#beforePlan?.();
      const output = await this.#plan(job);
      if (this.#record(owner, id) !== record || record.view.version !== version) reject('STALE_RESULT');
      const result = PublicPlan.parse(output);
      const eventExpiry = Math.min(...job.event_evidence.map(evidence => Date.parse(evidence.valid_until)));
      if (eventExpiry <= this.#now().getTime()) reject('EVENT_PREVIEW_EXPIRED', 410);
      if (Number.isFinite(eventExpiry)) result.valid_until = new Date(Math.min(eventExpiry,
        result.valid_until ? Date.parse(result.valid_until) : Infinity)).toISOString();
      if (result.valid_until && Date.parse(result.valid_until) <= this.#now().getTime()) reject('PLAN_EXPIRED_OR_INVALID', 503);
      record.view.result = result;
      if (result.status === 'PLACES_FOUND') record.retained = true;
      record.resultExpires = Math.min(this.#now().getTime() + 300_000, record.expires,
        record.view.result.valid_until ? Date.parse(record.view.result.valid_until) : Infinity);
      record.view.phase = 'RESULT'; return this.#view(record);
    } catch (error) {
      if (record.view.version === version && record.view.phase === 'PLANNING') record.view.phase = 'CONFIRMED';
      const failure = error instanceof PlanningSessionError ? error : new PlanningSessionError('PLANNING_FAILED', 503);
      record.failures.set(body.event_id, failure); throw failure;
    } finally { record.inProgress = null; this.#activeOwners.delete(owner); }
  }
}
