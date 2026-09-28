import fs from 'node:fs';
import { FormDraft, minutes, isEventActivity, type Activity, type FormIssue, type PlanningView } from '../shared/planning-form.js';
import { SavedUserConditionsV1Schema, type SavedUserConditionsV1 } from '../shared/saved-conditions.js';
import { classifyActivityIntent } from './activity-intent.js';
import { semanticAnchors } from './intent/semantic-coverage.mjs';
import type { InitialContext } from './intent-start.js';
import type { PlanningContext } from './planning-sessions.js';

export const SAVED_REMAP_POLICY = 'saved-remap.v1.1';
const semanticPolicy = JSON.parse(fs.readFileSync(new URL('./intent/semantic-policy.v1.json', import.meta.url), 'utf8')) as {
  families: { id: string; rubrics: string }[];
};
const fold = (value: string) => value.trim().toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
// Own bounded type lexicon, not a cached provider catalog. Inflection changes
// one named type into that same type only; it never adds a related venue type.
const typeForms: Record<string, readonly string[]> = {
  'музеи': ['музей', 'музея', 'музее', 'музею', 'музеем', 'музеев', 'музеях'],
  'парки': ['парк', 'парка', 'парке', 'парку', 'парком', 'парков', 'парках'],
  'парки культуры и отдыха': ['парк культуры и отдыха'],
  'скверы': ['сквер', 'сквера', 'сквере', 'скверу', 'сквером', 'скверов', 'скверах'],
  'кинотеатры': ['кинотеатр', 'кинотеатра', 'кинотеатре', 'кинотеатру', 'кинотеатром', 'кинотеатров', 'кинотеатрах'],
  'кофейни': ['кофейня', 'кофейню', 'кофейне', 'кофейней', 'кофеен', 'кофейнях'],
  'рестораны': ['ресторан', 'ресторана', 'ресторане', 'ресторану', 'рестораном', 'ресторанов', 'ресторанах'],
  'столовые': ['столовая', 'столовую', 'столовой', 'столовых'],
  'пиццерии': ['пиццерия', 'пиццерию', 'пиццерией', 'пиццерий', 'пиццериях'],
  'художественные галереи': ['художественная галерея', 'художественную галерею', 'художественной галерее'],
  'набережные': ['набережная', 'набережную', 'набережной', 'набережных'],
  'смотровые площадки': ['смотровая площадка', 'смотровую площадку', 'смотровой площадке'],
};
const canonicalTypes = new Map(Object.entries(typeForms).flatMap(([canonical, forms]) =>
  [canonical, ...forms].map(form => [fold(form), fold(canonical)] as const)));
const canonicalType = (value: string) => canonicalTypes.get(fold(value)) ?? fold(value);
const foodRubrics = new Set(semanticPolicy.families.find(family => family.id === 'food')!.rubrics.split('|').map(fold));
const genericFood = new Set(['еда', 'поесть', 'обед', 'ужин', 'завтрак', 'перекус']);
const genericWalk = new Set(['прогулка', 'прогулки', 'погулять', 'гулять', 'прогуляться', 'пешая прогулка', 'прогулка по городу']);
const unresolvedDestination = 'Финиш нужно выбрать заново';
type Queries = SavedUserConditionsV1['queries'];
type SavedIssue = SavedUserConditionsV1['reconfirmation_required'][number];
const provenanceValues = new Set(['user', 'user_form', 'inferred_walk', 'suggested', 'suggested_today',
  'derived_from_suggested_today', 'derived_from_duration', 'user_map', 'user_geolocation', 'policy_restore']);

function semanticKey(activity: Exclude<Activity, { intent_kind: 'event_visit' }>) {
  const named = activity.selection.named_types;
  const exactTypes = named.length && !named.every(value => genericFood.has(fold(value)) || genericWalk.has(fold(value)));
  if (activity.selection.category_policy === 'named_types_only' || exactTypes) return 'named_types' as const;
  const kind = activity.intent_kind ?? classifyActivityIntent({ label: activity.label, namedTypes: named });
  if (kind === 'route_walk' || kind === 'area_walk') return kind;
  const families = new Set(semanticAnchors(activity.label, { source: false }).map((anchor: { family: string }) => anchor.family));
  return families.size === 1 && families.has('food') ? 'food' as const : 'unresolved' as const;
}

/** Caller-supplied queries must be original user input, never provider labels. */
export function projectSavedConditions(view: PlanningView, options: { now?: Date; queries?: Queries } = {}): SavedUserConditionsV1 {
  const now = (options.now ?? new Date()).toISOString(), draft = FormDraft.parse(view.draft);
  const required: SavedIssue[] = [];
  const shared: SavedUserConditionsV1['shared'] = {};
  if (draft.shared.budget) {
    shared.budget = structuredClone(draft.shared.budget);
    if (shared.budget.kind === 'limit' && shared.budget.enforcement === 'estimated' && view.provenance['shared.budget'] !== 'user_form')
      required.push({ code: 'BUDGET_ASSUMPTION_RECONFIRM_REQUIRED', field: 'shared.budget' });
  }
  if (draft.shared.mobility) shared.mobility = [...draft.shared.mobility];
  if (draft.shared.search_radius_meters !== undefined) shared.search_radius_meters = draft.shared.search_radius_meters;
  if (draft.shared.party) shared.party = {
    ...(draft.shared.party.total !== undefined ? { total: draft.shared.party.total } : {}),
    ...(draft.shared.party.child_ages ? { child_ages: [...draft.shared.party.child_ages] } : {}),
  };
  if (draft.shared.party && Object.keys(draft.shared.party).some(key => !['total', 'child_ages'].includes(key)))
    required.push({ code: 'SAVED_UNSUPPORTED_CONDITIONS', field: 'shared.party' });
  const queries: Queries = {};
  for (const field of ['locality', 'origin', 'destination'] as const) {
    const supplied = options.queries?.[field], path = `shared.${field}_text`;
    const extracted = draft.shared[`${field}_text`];
    if (supplied !== undefined) queries[field] = supplied;
    else if (typeof extracted === 'string' && ['user', 'user_form'].includes(view.provenance[path] ?? '')) queries[field] = extracted;
  }
  if (Object.keys(draft.shared).some(key => !['budget', 'mobility', 'search_radius_meters', 'party', 'locality_text', 'origin_text', 'destination_text'].includes(key)))
    required.push({ code: 'SAVED_UNSUPPORTED_CONDITIONS', field: 'shared' });
  const points: SavedUserConditionsV1['points'] = {};
  for (const field of ['origin', 'destination'] as const) {
    const point = draft.points[field];
    if (!point) continue;
    if ((point.source === 'user_map' || point.source === 'user_geolocation') && view.provenance[`points.${field}`] === point.source)
      points[field] = { lat: point.lat, lon: point.lon, source: point.source, saved_at: now };
    else required.push({ code: 'POINT_RECONFIRM_REQUIRED', field: `points.${field}` });
  }
  for (const field of ['origin', 'destination'] as const)
    if (!draft.points[field] && typeof draft.shared[`${field}_text`] === 'string' && draft.shared[`${field}_text`] && !queries[field])
      required.push({ code: 'POINT_RECONFIRM_REQUIRED', field: `points.${field}` });
  const days = draft.days.map(day => ({ day_id: day.day_id, date: day.date,
    ...(day.window ? { window: { start: day.window.start, end: day.window.end } } : {}),
    ...(day.duration_constraint_minutes !== undefined ? { duration_constraint_minutes: day.duration_constraint_minutes } : {}),
    activities: day.activities.map(activity => {
      if (isEventActivity(activity)) {
        required.push({ code: 'EVENT_RECHECK_REQUIRED', field: `days.${day.day_id}.activities.${activity.id}` });
        return { id: activity.id, label: 'Выбранное событие' as const, intent_kind: 'event_visit' as const,
          target: structuredClone(activity.target), requirements: structuredClone(activity.requirements), semantic_key: 'selected_event' as const };
      }
      return { id: activity.id, label: activity.label,
      ...(activity.intent_kind ? { intent_kind: activity.intent_kind } : {}),
      selection: { category_policy: activity.selection.category_policy, named_types: [...activity.selection.named_types] },
      requirements: activity.requirements.map(value => ({ text: value.text, strength: value.strength })),
      semantic_key: semanticKey(activity), category_reconfirmation_required: activity.categories.exclude.length > 0,
      ...(activity.categories.state !== 'matched' || !activity.categories.include_any.length ? { category_selection_pending: true as const } : {}),
      };
    }), order: day.order.map(([before, after]) => [before, after] as [string, string]),
  }));
  const paths = new Set(['shared.budget', 'shared.mobility', 'shared.search_radius_meters', 'shared.party', 'shared.party.total', 'shared.party.child_ages',
    ...(['origin', 'destination'] as const).filter(field => points[field]).map(field => `points.${field}`),
    ...days.flatMap(day => ['date', 'window', 'window.start', 'window.end', 'duration_constraint_minutes', 'activities', 'order'].map(field => `days.${day.day_id}.${field}`)),
  ]);
  const provenance = Object.fromEntries(Object.entries(view.provenance).filter(([path, value]) => paths.has(path) && provenanceValues.has(value)));
  return SavedUserConditionsV1Schema.parse({ schema_version: 'saved-user-conditions.v1', conditions_revision: view.version,
    ...(draft.clarifications?.length ? { clarifications: structuredClone(draft.clarifications) } : {}),
    updated_at: now, review_state: view.confirmed_version === view.version ? 'user_confirmed' : 'draft',
    semantic_policy_version: SAVED_REMAP_POLICY, shared, queries, points, days, provenance, reconfirmation_required: required });
}

export type SavedConditionsRemap = { status: 'RESTORABLE'; draft: PlanningView['draft']; provenance: Record<string, string>; issues: FormIssue[] }
  | { status: 'NEEDS_INPUT'; issues: FormIssue[] };

/** Pure fresh-context binding. Never calls LLM, Places, routing, or a geocoder. */
export function remapSavedConditions(raw: SavedUserConditionsV1, context: InitialContext & { planning: PlanningContext }): SavedConditionsRemap {
  const saved = SavedUserConditionsV1Schema.parse(raw), issues: FormIssue[] = [];
  const blockers: FormIssue[] = saved.reconfirmation_required.filter(issue => !['POINT_RECONFIRM_REQUIRED', 'EVENT_RECHECK_REQUIRED'].includes(issue.code));
  if (saved.semantic_policy_version !== SAVED_REMAP_POLICY)
    blockers.push({ code: 'SAVED_SEMANTIC_POLICY_CHANGED', field: 'days' });
  if (!context.catalog.complete || context.catalog.region_id !== context.locality.region_id ||
    context.planning.catalog.region_id !== context.locality.region_id || context.planning.catalog.version !== context.catalog.version)
    return { status: 'NEEDS_INPUT', issues: [{ code: 'SAVED_CATEGORY_RECONFIRM_REQUIRED', field: 'days' }] };
  const leaves = new Set(context.planning.catalog.leaf_ids);
  const rows = context.catalog.rows.filter(row => (row[3]?.type ?? 'rubric') === 'rubric' && leaves.has(row[0]));
  const allowed = new Set(rows.map(row => row[0]));
  const freshIds = (values: string[] | undefined) => [...new Set(values ?? [])].filter(id => allowed.has(id));
  const days = saved.days.map(day => ({ day_id: day.day_id, date: day.date,
    ...(day.window ? { window: { ...day.window } } : {}),
    ...(day.duration_constraint_minutes !== undefined ? { duration_constraint_minutes: day.duration_constraint_minutes } : {}),
    activities: day.activities.map(activity => {
      const path = `days.${day.day_id}.activities.${activity.id}`;
      if (activity.semantic_key === 'selected_event') {
        issues.push({ code: 'EVENT_RECHECK_REQUIRED', field: path });
        return { id: activity.id, label: 'Выбранное событие', intent_kind: 'event_visit' as const,
          target: structuredClone(activity.target), requirements: structuredClone(activity.requirements) };
      }
      let include: string[] = [];
      if (activity.category_reconfirmation_required) blockers.push({ code: 'SAVED_EXCLUSIONS_RECONFIRM_REQUIRED', field: path });
      if (activity.category_selection_pending) return { id: activity.id, label: activity.label,
        ...(activity.intent_kind ? { intent_kind: activity.intent_kind } : {}), selection: structuredClone(activity.selection),
        requirements: structuredClone(activity.requirements), categories: { state: 'no_match', include_any: [], exclude: [],
          region_id: context.locality.region_id, catalog_version: context.catalog.version } };
      if (activity.selection.category_policy === 'named_types_only' || activity.semantic_key === 'named_types') {
        const matches = activity.selection.named_types.map(name => rows.filter(row => canonicalType(row[1]) === canonicalType(name)));
        if (matches.length && matches.every(group => group.length === 1)) include = matches.map(group => group[0]![0]);
      } else if (activity.semantic_key === 'route_walk') include = freshIds(context.planning.visit_policy.walkable_category_ids);
      else if (activity.semantic_key === 'area_walk') include = freshIds(context.planning.visit_policy.park_category_ids);
      else if (activity.semantic_key === 'food' && activity.selection.category_policy === 'related_allowed')
        include = rows.filter(row => foodRubrics.has(fold(row[1]))).map(row => row[0]);
      if (!include.length) blockers.push({ code: 'SAVED_CATEGORY_RECONFIRM_REQUIRED', field: path });
      return { id: activity.id, label: activity.label, ...(activity.intent_kind ? { intent_kind: activity.intent_kind } : {}),
        selection: structuredClone(activity.selection), requirements: structuredClone(activity.requirements),
        categories: { state: 'matched', include_any: [...new Set(include)].sort(), exclude: [],
          region_id: context.locality.region_id, catalog_version: context.catalog.version } };
    }), order: structuredClone(day.order),
  }));
  const points: PlanningView['draft']['points'] = {};
  for (const field of ['origin', 'destination'] as const) {
    const point = saved.points[field], area = context.planning.point_area;
    if (point && area && point.lat >= area.south && point.lat <= area.north && point.lon >= area.west && point.lon <= area.east)
      points[field] = { lat: point.lat, lon: point.lon, source: point.source, locality_id: context.locality.id };
    else if (point || saved.reconfirmation_required.some(issue => issue.field === `points.${field}`)) {
      const issue = { code: 'POINT_RECONFIRM_REQUIRED', field: `points.${field}` };
      issues.push(issue);
    }
  }
  if (!points.origin) issues.push({ code: 'ORIGIN_REQUIRED', field: 'points.origin' });
  if (blockers.length) return { status: 'NEEDS_INPUT', issues: [...blockers, ...issues] };
  const destinationRequired = !points.destination && issues.some(issue => issue.field === 'points.destination');
  const shared = { ...structuredClone(saved.shared),
    ...(saved.queries.origin ? { origin_text: saved.queries.origin } : {}),
    ...(saved.queries.destination || destinationRequired ? { destination_text: saved.queries.destination ?? unresolvedDestination } : {}) };
  const draft = FormDraft.parse({ locality: context.locality, shared, points, days,
    ...(saved.clarifications?.length ? { clarifications: structuredClone(saved.clarifications) } : {}) });
  const now = new Date(context.now);
  const local = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: context.locality.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(part => [part.type, part.value]));
  const today = `${local.year}-${local.month}-${local.day}`, currentMinute = Number(local.hour) * 60 + Number(local.minute);
  for (const day of days) if (day.date < today || (day.date === today && day.window && minutes(day.window.start) < currentMinute))
    issues.push({ code: 'WINDOW_EXPIRED', field: `days.${day.day_id}.window` });
  const provenance = { ...saved.provenance };
  if (destinationRequired && !saved.queries.destination) provenance['shared.destination_text'] = 'policy_restore';
  for (const field of ['origin', 'destination'] as const) if (!points[field]) delete provenance[`points.${field}`];
  return { status: 'RESTORABLE', draft, provenance, issues };
}
