import { describe, expect, it, vi } from 'vitest';
import type { PlanningView } from '../shared/planning-form.js';
import { SavedConditionsViewSchema, SavedUserConditionsV1Schema } from '../shared/saved-conditions.js';
import { projectSavedConditions, remapSavedConditions } from './saved-conditions.js';
import type { InitialContext } from './intent-start.js';
import type { PlanningContext } from './planning-sessions.js';
import { PlanningSessions } from './planning-sessions.js';
import { intentFixture } from './intent-start.fixture.js';
import { parseInitialIntent } from './intent-start.js';

const now = new Date('2026-09-24T09:30:00Z');
function fixture() {
  const activity = (id: string, label: string, category: string, kind: 'route_walk' | 'place_visit') => ({
    id, label, intent_kind: kind, selection: { category_policy: 'related_allowed' as const, named_types: [] }, requirements: [],
    categories: { state: 'matched', include_any: [category], exclude: [], region_id: 'old-provider-region', catalog_version: 'old-provider-catalog' },
  });
  const view: PlanningView = { id: 'draft-own-id', version: 7, phase: 'DRAFT', confirmed_version: null,
    expires_at: '2026-09-24T10:00:00Z', result: null, issues: [], capabilities: { modes: ['walking'], data_mode: 'test' },
    provenance: { 'shared.budget': 'user_form', 'shared.party.total': 'user_form', 'shared.mobility': 'inferred_walk',
      'points.origin': 'user_map', 'days.d1.window.start': 'user_form', 'days.d1.window.end': 'user_form', 'days.d1.date': 'suggested_today' },
    draft: { locality: { id: 'old-provider-city', name: 'Provider city label', region_id: 'old-provider-region', timezone: 'Europe/Moscow' },
      shared: { budget: { kind: 'limit', amount_rub: 2400, basis: 'whole_party', period: 'whole_trip', enforcement: 'estimated', price_basis_assumption: 'per_person' },
        party: { total: 2 }, mobility: ['walking'] },
      points: { origin: { lat: 55.75, lon: 37.62, source: 'user_map', locality_id: 'old-provider-city', label: 'Provider address label' } },
      days: [{ day_id: 'd1', date: '2026-09-25', window: { start: '17:00', end: '20:00' },
        activities: [activity('walk', 'Прогулка', 'old-park-id', 'route_walk'), activity('food', 'Поесть', 'old-food-id', 'place_visit')],
        order: [['walk', 'food']] }] },
  };
  const context: InitialContext & { planning: PlanningContext } = {
    now: now.toISOString(), locality: { id: 'fresh-city', name: 'Fresh provider city', region_id: 'fresh-region', timezone: 'Europe/Moscow' },
    catalog: { format: 'rows', version: 'fresh-catalog', region_id: 'fresh-region', complete: true, roots: [],
      rows: [['901', 'Парки', []], ['902', 'Скверы', []], ['903', 'Кафе', []], ['904', 'Столовые', []], ['905', 'Музеи', []]] },
    planning: { catalog: { version: 'fresh-catalog', region_id: 'fresh-region', leaf_ids: ['901', '902', '903', '904', '905'] },
      visit_policy: { version: 'fresh-durations', by_category: {}, walkable_category_ids: ['901', '902'], park_category_ids: ['901'], arrival_buffer_minutes: 5 },
      point_area: { south: 55, north: 56, west: 37, east: 38 }, modes: ['walking'], data_mode: 'test' },
  };
  return { view, context };
}

describe('saved own conditions allowlist and fresh binding', () => {
  it('preserves a user visit duration and a relaxed requirement through reopening', () => {
    const { view, context } = fixture(), activity = view.draft.days[0]!.activities[0]!;
    if (activity.intent_kind === 'event_visit') throw Error('fixture');
    activity.duration_minutes = 17;
    activity.requirements = [{ text: 'тихое место', strength: 'preferred' }];
    const saved = projectSavedConditions(view, { now });
    const restored = remapSavedConditions(saved, context);
    expect(restored.status).toBe('RESTORABLE');
    if (restored.status === 'RESTORABLE') expect(restored.draft.days[0]!.activities[0]).toMatchObject({
      duration_minutes: 17, requirements: [{ text: 'тихое место', strength: 'preferred' }] });
  });
  it('preserves explicit search radius and provenance through saving and fresh-context remapping', () => {
    const { view, context } = fixture();
    view.draft.shared.search_radius_meters = 12_000;
    view.provenance['shared.search_radius_meters'] = 'user_form';
    const saved = projectSavedConditions(view, { now });
    expect(saved.shared.search_radius_meters).toBe(12_000);
    expect(saved.provenance['shared.search_radius_meters']).toBe('user_form');
    expect(saved.reconfirmation_required).not.toContainEqual({ code: 'SAVED_UNSUPPORTED_CONDITIONS', field: 'shared' });
    const restored = remapSavedConditions(saved, context);
    expect(restored.status).toBe('RESTORABLE');
    if (restored.status === 'RESTORABLE') expect(restored.draft.shared.search_radius_meters).toBe(12_000);
  });
  it('preserves only an explicit event choice and own duration, then restores unconfirmed without event HTTP or LLM', () => {
    const { view, context } = fixture();
    const target = { kind: 'event' as const, provider: 'kudago' as const, event_id: '123', occurrence_key: 'a'.repeat(64), visit_duration_minutes: 60 };
    view.draft.days[0]!.activities[0] = { id: 'walk', label: 'SOURCE TITLE MUST NOT BE DURABLE', intent_kind: 'event_visit', requirements: [], target };
    const saved = projectSavedConditions(view, { now });
    expect(saved.days[0]!.activities[0]).toEqual({ id: 'walk', label: 'Выбранное событие', intent_kind: 'event_visit', requirements: [], target, semantic_key: 'selected_event' });
    expect(JSON.stringify(saved)).not.toContain('SOURCE TITLE');
    expect(saved.reconfirmation_required).toContainEqual({ code: 'EVENT_RECHECK_REQUIRED', field: 'days.d1.activities.walk' });
    const fetch = vi.fn(() => { throw new Error('No event HTTP allowed'); }); vi.stubGlobal('fetch', fetch);
    try {
      const restored = remapSavedConditions(saved, context);
      expect(restored.status).toBe('RESTORABLE');
      if (restored.status !== 'RESTORABLE') return;
      expect(restored.draft.days[0]!.activities[0]).toMatchObject({ target, label: 'Выбранное событие' });
      expect(restored.draft.days[0]!.activities[0]).not.toHaveProperty('categories');
      expect(restored.issues).toContainEqual({ code: 'EVENT_RECHECK_REQUIRED', field: 'days.d1.activities.walk' });
      expect(restored.draft.days[0]!.order).toEqual([['walk', 'food']]);
      expect(fetch).not.toHaveBeenCalled();
      const polluted = structuredClone(saved); Object.assign(polluted.days[0]!.activities[0]!, { price: 500, source: { provider: 'kudago' } });
      expect(() => SavedUserConditionsV1Schema.parse(polluted)).toThrow();
    } finally { vi.unstubAllGlobals(); }
  });
  it('preserves current edited conditions, order, provenance and deleted activity state', () => {
    const { view } = fixture();
    view.draft.days[0]!.activities.shift(); view.draft.days[0]!.order = [];
    const saved = projectSavedConditions(view, { now, queries: { locality: 'город пользователя' } });
    expect(saved.conditions_revision).toBe(7);
    expect(saved.shared).toEqual(view.draft.shared);
    expect(saved.days[0]!.window).toEqual({ start: '17:00', end: '20:00' });
    expect(saved.days[0]!.activities.map(a => a.id)).toEqual(['food']);
    expect(saved.days[0]!.order).toEqual([]);
    expect(saved.provenance['days.d1.date']).toBe('suggested_today');
    expect(saved.queries.locality).toBe('город пользователя');
    expect(SavedConditionsViewSchema.parse({ id: view.id, revision: 9, expires_at: '2026-10-01T00:00:00Z', conditions: saved }).revision).toBe(9);
  });

  it('does not serialize provider context, addresses, category IDs, result cards or unknown metadata', () => {
    const { view } = fixture();
    Object.assign(view.draft.shared.party!, { provider_label: 'party-provider-secret' });
    Object.assign(view.draft.shared, { provider_context: { value: 'shared-provider-secret' } });
    Object.assign(view.provenance, { 'draft.provider-label': 'provider-provenance-secret', 'shared.party.total': 'user_form' });
    view.result = { status: 'AVAILABLE', warnings: [], days: [], total_expected_cost_minor: 1987654321 };
    const saved = projectSavedConditions(view, { now }), json = JSON.stringify(saved);
    for (const forbidden of ['old-provider', 'Provider city label', 'Provider address label', 'old-park-id', 'old-food-id',
      'party-provider-secret', 'shared-provider-secret', 'provider-provenance-secret', '1987654321', 'include_any', 'catalog_version', 'locality_id'])
      expect(json).not.toContain(forbidden);
    expect(saved.reconfirmation_required).toContainEqual({ code: 'SAVED_UNSUPPORTED_CONDITIONS', field: 'shared' });
    expect(saved.queries).toEqual({});
    expect(() => SavedUserConditionsV1Schema.parse({ ...saved, provider: 'forbidden' })).toThrow();
    expect(() => SavedUserConditionsV1Schema.parse({ ...saved, points: { origin: { ...saved.points.origin, label: 'forbidden' } } })).toThrow();
    expect(() => SavedUserConditionsV1Schema.parse({ ...saved, provenance: { 'provider.address': 'user' } })).toThrow();
    expect(() => SavedUserConditionsV1Schema.parse({ ...saved, reconfirmation_required: [{ code: 'SAVED_UNSUPPORTED_CONDITIONS', field: 'provider-card-label' }] })).toThrow();
  });

  it('only captures original user queries or fields with user provenance', () => {
    const { view } = fixture();
    Object.assign(view.draft.shared, { locality_text: 'my city', origin_text: 'my street', destination_text: 'provider address' });
    view.provenance['shared.locality_text'] = 'user'; view.provenance['shared.origin_text'] = 'user_form';
    expect(projectSavedConditions(view, { now }).queries).toEqual({ locality: 'my city', origin: 'my street' });
  });

  it('omits provider-selected coordinates and refuses to relabel them as a user point', () => {
    const { view } = fixture();
    view.draft.points.origin!.source = 'place_choice'; view.provenance['points.origin'] = 'place_choice';
    const saved = projectSavedConditions(view, { now });
    expect(saved.points).toEqual({});
    expect(saved.reconfirmation_required).toContainEqual({ code: 'POINT_RECONFIRM_REQUIRED', field: 'points.origin' });
    view.draft.points.origin!.source = 'user_geolocation';
    expect(projectSavedConditions(view, { now }).points).toEqual({});
  });

  it('binds walk and food to fresh IDs without invoking LLM or providers', () => {
    const { view, context } = fixture();
    const fetch = vi.fn(() => { throw new Error('No provider request allowed'); });
    vi.stubGlobal('fetch', fetch);
    try {
      const result = remapSavedConditions(projectSavedConditions(view, { now }), context);
      expect(result.status).toBe('RESTORABLE');
      if (result.status !== 'RESTORABLE') return;
      expect(result.draft.days[0]!.activities.map(a => a.categories.include_any)).toEqual([['901', '902'], ['903', '904']]);
      expect(result.draft.days[0]!.order).toEqual([['walk', 'food']]);
      expect(result.draft.points.origin).toEqual({ lat: 55.75, lon: 37.62, source: 'user_map', locality_id: 'fresh-city' });
      expect(result.draft.shared.budget).toEqual(view.draft.shared.budget);
      expect(result).not.toHaveProperty('result'); expect(result).not.toHaveProperty('confirmed_version');
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('preserves strict named types without substituting related categories', () => {
    const { view, context } = fixture(), activity = view.draft.days[0]!.activities[0]!;
    activity.label = 'Музеи'; activity.intent_kind = 'place_visit';
    activity.selection = { category_policy: 'named_types_only', named_types: ['Музеи'] };
    const saved = projectSavedConditions(view, { now });
    const mapped = remapSavedConditions(saved, context);
    expect(mapped.status).toBe('RESTORABLE');
    if (mapped.status === 'RESTORABLE') expect(mapped.draft.days[0]!.activities[0]!.categories.include_any).toEqual(['905']);
    context.catalog.rows.push(['906', 'Музеи', []]); context.planning.catalog.leaf_ids.push('906');
    expect(remapSavedConditions(saved, context)).toMatchObject({ status: 'NEEDS_INPUT', issues: [{ code: 'SAVED_CATEGORY_RECONFIRM_REQUIRED' }] });
  });

  it('restores both activities from the original parser fixture using fresh rubric IDs', async () => {
    const f = intentFixture();
    const parsed = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'save-parser-fixture' }, async () => f.response);
    expect(parsed.status).toBe('draft'); if (parsed.status !== 'draft') return;
    const { view, context } = fixture(); view.draft = parsed.draft; view.provenance = parsed.provenance;
    const result = remapSavedConditions(projectSavedConditions(view, { now }), context);
    expect(result.status).toBe('RESTORABLE');
    if (result.status !== 'RESTORABLE') return;
    expect(result.draft.days[0]!.activities.map(activity => [activity.label, activity.categories.include_any])).toEqual([
      ['музей', ['905']], ['кафе', ['903']],
    ]);
  });

  it.each([
    ['музей', 'Музеи'], ['парк', 'Парки'], ['сквер', 'Скверы'],
    ['кинотеатр', 'Кинотеатры'], ['кофейня', 'Кофейни'],
  ])('normalizes known type morphology without expanding strict %s into another type', (type, rubric) => {
    const { view, context } = fixture(), activity = view.draft.days[0]!.activities[0]!;
    activity.selection = { category_policy: 'named_types_only', named_types: [type] };
    context.catalog.rows = [['991', rubric, []], ['903', 'Кафе', []]];
    context.planning.catalog.leaf_ids = ['991', '903'];
    const result = remapSavedConditions(projectSavedConditions(view, { now }), context);
    expect(result.status).toBe('RESTORABLE');
    if (result.status === 'RESTORABLE') expect(result.draft.days[0]!.activities[0]!.categories.include_any).toEqual(['991']);
  });

  it('does not drop unknown exclusions when old IDs cannot be retained', () => {
    const { view, context } = fixture(); view.draft.days[0]!.activities[1]!.categories.exclude = ['old-excluded-provider-id'];
    const saved = projectSavedConditions(view, { now });
    expect(JSON.stringify(saved)).not.toContain('old-excluded-provider-id');
    expect(saved.days[0]!.activities[1]!.category_reconfirmation_required).toBe(true);
    expect(remapSavedConditions(saved, context)).toMatchObject({ status: 'NEEDS_INPUT', issues: [{ code: 'SAVED_EXCLUSIONS_RECONFIRM_REQUIRED' }] });
  });

  it('keeps expired calendar dates and requires a point outside the newly selected city to be chosen again', () => {
    const { view, context } = fixture(); context.now = '2026-09-27T09:30:00Z';
    context.planning.point_area = { south: 10, north: 11, west: 20, east: 21 };
    const result = remapSavedConditions(projectSavedConditions(view, { now }), context);
    expect(result.status).toBe('RESTORABLE');
    if (result.status !== 'RESTORABLE') return;
    expect(result.draft.days[0]!.date).toBe('2026-09-25'); expect(result.draft.points.origin).toBeUndefined();
    expect(result.issues.map(i => i.code)).toEqual(expect.arrayContaining(['WINDOW_EXPIRED', 'POINT_RECONFIRM_REQUIRED', 'ORIGIN_REQUIRED']));
  });

  it('does not silently remove a provider-derived destination with no surviving user query', () => {
    const { view, context } = fixture();
    view.draft.points.destination = { lat: 55.75, lon: 37.62, locality_id: 'old-provider-city', source: 'place_choice', label: 'Provider finish address' };
    view.provenance['points.destination'] = 'place_choice';
    const saved = projectSavedConditions(view, { now });
    expect(saved.points.destination).toBeUndefined();
    expect(remapSavedConditions(saved, context)).toMatchObject({ status: 'RESTORABLE', draft: { shared: { destination_text: 'Финиш нужно выбрать заново' } } });
    const withQuery = projectSavedConditions(view, { now, queries: { destination: 'user finish query' } });
    const result = remapSavedConditions(withQuery, context);
    expect(result.status).toBe('RESTORABLE');
    if (result.status === 'RESTORABLE') expect(result.draft.shared.destination_text).toBe('user finish query');
  });

  it('keeps the existence of a destination when its text has unverified provenance', () => {
    const { view, context } = fixture(); view.draft.shared.destination_text = 'unverified provider destination';
    const saved = projectSavedConditions(view, { now });
    expect(saved.queries.destination).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('unverified provider destination');
    expect(saved.reconfirmation_required).toContainEqual({ code: 'POINT_RECONFIRM_REQUIRED', field: 'points.destination' });
    const result = remapSavedConditions(saved, context);
    expect(result.status).toBe('RESTORABLE');
    if (result.status !== 'RESTORABLE') return;
    expect(result.draft.shared.destination_text).toBe('Финиш нужно выбрать заново');
    const sessions = new PlanningSessions({ now: () => now, plan: async () => { throw new Error('No paid work'); } });
    const restored = sessions.create('owner', result.draft, context.planning, result.provenance);
    expect(restored.issues.map(i => i.code)).toContain('DESTINATION_REQUIRED');
    expect(() => sessions.confirm('owner', restored.id, { base_version: restored.version, event_id: 'confirm-blocked' })).toThrow('INCOMPLETE_DRAFT');
    const changed = sessions.edit('owner', restored.id, { base_version: restored.version, event_id: 'remove-finish-1', changes: [{ op: 'clear_destination' }] });
    expect(changed.issues.map(i => i.code)).not.toContain('DESTINATION_REQUIRED');
    const capturedAgain = projectSavedConditions(restored, { now });
    expect(capturedAgain.queries.destination).toBeUndefined();
    expect(capturedAgain.reconfirmation_required).toContainEqual({ code: 'POINT_RECONFIRM_REQUIRED', field: 'points.destination' });
  });

  it('does not drop unknown party conditions as if they never existed', () => {
    const { view, context } = fixture(); view.draft.shared.party = { total: 2, mobility_assistance: 'private detail' };
    const saved = projectSavedConditions(view, { now });
    expect(JSON.stringify(saved)).not.toContain('private detail');
    expect(saved.reconfirmation_required).toContainEqual({ code: 'SAVED_UNSUPPORTED_CONDITIONS', field: 'shared.party' });
    expect(remapSavedConditions(saved, context)).toMatchObject({ status: 'NEEDS_INPUT' });
  });

  it('restores generic named walking intent without weakening strict named-type restrictions', () => {
    const { view, context } = fixture(), activity = view.draft.days[0]!.activities[0]!;
    activity.selection.named_types = ['Прогулка'];
    const saved = projectSavedConditions(view, { now });
    expect(saved.days[0]!.activities[0]!.semantic_key).toBe('route_walk');
    expect(remapSavedConditions(saved, context)).toMatchObject({ status: 'RESTORABLE' });
    activity.selection.category_policy = 'named_types_only';
    expect(remapSavedConditions(projectSavedConditions(view, { now }), context)).toMatchObject({ status: 'NEEDS_INPUT' });
  });

  it('does not restore estimated-budget consent from an untrusted origin', () => {
    const { view, context } = fixture(); view.provenance['shared.budget'] = 'user';
    const saved = projectSavedConditions(view, { now });
    expect(remapSavedConditions(saved, context)).toMatchObject({ status: 'NEEDS_INPUT', issues: [{ code: 'BUDGET_ASSUMPTION_RECONFIRM_REQUIRED' }] });
  });

  it('requires an explicit migration when the remapping policy changes', () => {
    const { view, context } = fixture(), saved = projectSavedConditions(view, { now });
    saved.semantic_policy_version = 'unsupported-policy';
    expect(remapSavedConditions(saved, context)).toMatchObject({ status: 'NEEDS_INPUT', issues: [{ code: 'SAVED_SEMANTIC_POLICY_CHANGED' }] });
  });
});
