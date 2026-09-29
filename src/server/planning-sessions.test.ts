import { describe, expect, it } from 'vitest';
import { PlanningSessions } from './planning-sessions.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';

function setup() {
  const fixture = planningFixture();
  let now = demoNow();
  const sessions = new PlanningSessions({ now: () => now, plan: job => planPlacesWithDgis(fixture.client(), job,
    { retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test', now: () => now }) });
  const context = { catalog: fixture.input.catalog, visit_policy: fixture.input.visit_policy,
    modes: ['walking', 'driving'] as const, point_area: { south: 55.7, north: 55.8, west: 37.5, east: 37.8 },
    data_mode: 'test' as const };
  const view = sessions.create('owner', fixture.input.intent, context);
  return { sessions, fixture, context, view, setNow: (value: Date) => { now = value; } };
}
const event = (version = 0, id = 'event-0001') => ({ base_version: version, event_id: id });

describe('server-owned form revisions', () => {
  it('can suggest an outdoor nature stop without published opening hours', async () => {
    const f = planningFixture();
    f.input.intent.shared.mobility = ['driving'];
    f.input.intent.days[0]!.activities[0]!.label = 'природа';
    for (const item of f.items.filter(item => item.rubrics[0]?.id === '100')) Object.assign(item, { schedule: undefined });
    const context = { catalog: { ...f.input.catalog,
      category_names: { '100': 'Природные достопримечательности', '200': 'Кафе' } },
      visit_policy: { ...f.input.visit_policy, walkable_category_ids: ['100'],
        by_category: { '100': 5, '200': 60 } }, modes: ['walking', 'driving'] as const, data_mode: 'test' as const };
    const sessions = new PlanningSessions({ now: demoNow, plan: job => planPlacesWithDgis(f.client(), job,
      { retrieval: { maxPages: 1 }, routingMode: 'external', dataMode: 'test', now: demoNow }) });
    const view = sessions.create('nature-owner', f.input.intent, context);
    const confirmed = sessions.confirm('nature-owner', view.id, event(view.version, 'nature-confirm'));
    const result = await sessions.calculate('nature-owner', view.id, event(confirmed.version, 'nature-plan'));
    expect(result.result?.status).toBe('PLACES_FOUND');
    expect(result.result?.search_scope?.radius_meters).toBe(50_000);
  }, 30_000);
  it('refreshes agreed duration defaults for an old live draft while preserving explicit minutes', async () => {
    const f = setup(); let submitted: Record<string, unknown> | undefined;
    const context = { ...f.context, data_mode: 'live' as const,
      catalog: { ...f.context.catalog, category_names: { '100': 'Музеи', '200': 'Рестораны' } },
      visit_policy: { ...f.context.visit_policy, version: 'visit-duration-estimates.v5', by_category: { '100': 90, '200': 90 } } };
    const sessions = new PlanningSessions({ now: demoNow, plan: async job => { submitted = job;
      return { status: 'UNAVAILABLE', days: [], warnings: [] }; } });
    const seed = structuredClone(f.fixture.input.intent);
    Object.assign(seed.days[0]!.activities[0]!, { duration_minutes: 80 });
    const view = sessions.create('owner', seed, context);
    const confirmed = sessions.confirm('owner', view.id, event());
    await sessions.calculate('owner', view.id, event(confirmed.version, 'new-duration-policy'));
    expect(submitted?.visit_policy).toMatchObject({ version: 'visit-duration-estimates.v7', by_category: { '100': 60, '200': 60 } });
    const intent = submitted?.intent as { days: { activities: { duration_minutes?: number }[] }[] };
    expect(intent.days[0]!.activities[0]!.duration_minutes).toBe(80);
    expect(sessions.get('owner', view.id).draft).toEqual(confirmed.draft);
  });
  it('edits child ages explicitly, preserves them on legacy total edits and rejects contradictory groups atomically', () => {
    const { sessions, view } = setup();
    const selected = sessions.edit('owner', view.id, { ...event(), changes: [{ op: 'party', total: 3, child_ages: [6, 12] }] });
    expect(selected.draft.shared.party).toEqual({ total: 3, child_ages: [6, 12] });
    expect(selected.provenance['shared.party.child_ages']).toBe('user_form');
    const changed = sessions.edit('owner', view.id, { ...event(selected.version, 'party-legacy'), changes: [{ op: 'party', total: 4 }] });
    expect(changed.draft.shared.party?.child_ages).toEqual([6, 12]);
    expect(() => sessions.edit('owner', view.id, { ...event(changed.version, 'party-conflict'), changes: [{ op: 'party', total: 1 }] }))
      .toThrow('PARTY_SIZE_CONFLICT');
    expect(sessions.get('owner', view.id)).toEqual(changed);
    const unknown = sessions.edit('owner', view.id, { ...event(changed.version, 'party-unknown'), changes: [{ op: 'party', total: null }] });
    expect(unknown.issues.map(issue => issue.code)).toContain('PARTY_REQUIRED');
    expect(() => sessions.confirm('owner', view.id, event(unknown.version, 'party-no-confirm'))).toThrow('INCOMPLETE_DRAFT');
    const cleared = sessions.edit('owner', view.id, { ...event(unknown.version, 'party-no-children'), changes: [{ op: 'party', total: 1, child_ages: [] }] });
    expect(cleared.draft.shared.party).toEqual({ total: 1, child_ages: [] });
    expect(cleared.issues.map(issue => issue.code)).not.toContain('PARTY_REQUIRED');
    expect(() => sessions.edit('owner', view.id, { ...event(cleared.version, 'party-invalid-age'), changes: [{ op: 'party', total: 2, child_ages: [18] }] })).toThrow('INVALID_ACTION');
    expect(sessions.get('owner', view.id)).toEqual(cleared);
  });
  it('expires a result at its earlier provider deadline instead of adding five minutes after computation', async () => {
    const f = setup(); let now = demoNow();
    const deadline = new Date(now.getTime() + 60_000).toISOString();
    const sessions = new PlanningSessions({ now: () => now,
      plan: async () => ({ status: 'LIMITED', valid_until: deadline, warnings: [], days: [] }) });
    const view = sessions.create('owner', f.fixture.input.intent, f.context);
    const confirmed = sessions.confirm('owner', view.id, event());
    const result = await sessions.calculate('owner', view.id, event(confirmed.version, 'earlier-provider-deadline'));
    expect(result.result?.valid_until).toBe(deadline);
    now = new Date(Date.parse(deadline) + 1);
    expect(sessions.get('owner', view.id)).toMatchObject({ result: null, confirmed_version: null, phase: 'DRAFT' });
    const reconfirmed = sessions.confirm('owner', view.id, event(sessions.get('owner', view.id).version, 'reconfirm-expired-deadline'));
    await expect(sessions.calculate('owner', view.id, event(reconfirmed.version, 'already-expired-provider-deadline')))
      .rejects.toMatchObject({ code: 'PLAN_EXPIRED_OR_INVALID' });
    expect(sessions.get('owner', view.id).result).toBeNull();
  });
  it('releases calculation locks when walk category preparation fails before the planner starts', async () => {
    const f = setup(), seed = structuredClone(f.fixture.input.intent);
    seed.days[0]!.activities[0]!.label = 'Прогулка по городу';
    seed.days[0]!.activities[0]!.intent_kind = 'route_walk';
    seed.shared.mobility = ['walking'];
    const view = f.sessions.create('owner', seed, { ...f.context,
      visit_policy: { ...f.context.visit_policy, walkable_category_ids: [] } });
    const confirmed = f.sessions.confirm('owner', view.id, event());
    const request = event(confirmed.version, 'failed-walk-prepare');
    await expect(f.sessions.calculate('owner', view.id, request)).rejects.toThrow('WALK_CATEGORY_UNAVAILABLE');
    expect(f.sessions.get('owner', view.id).phase).toBe('CONFIRMED');
    await expect(f.sessions.calculate('owner', view.id, request)).rejects.toThrow('WALK_CATEGORY_UNAVAILABLE');
    // A new action must reach preparation, not remain blocked by PLAN_IN_PROGRESS.
    await expect(f.sessions.calculate('owner', view.id, event(confirmed.version, 'retry-walk-prepare')))
      .rejects.toThrow('WALK_CATEGORY_UNAVAILABLE');
    const edited = f.sessions.edit('owner', view.id, { ...event(confirmed.version, 'edit-after-failure'),
      changes: [{ op: 'party', total: 2 }] });
    expect(edited.phase).toBe('DRAFT');
  });

  it('requires walking transport for a route walk instead of silently turning it into a driving tour', () => {
    const f = setup(), seed = structuredClone(f.fixture.input.intent);
    seed.days[0]!.activities[0]!.label = 'Прогулка по городу';
    seed.days[0]!.activities[0]!.intent_kind = 'route_walk';
    seed.shared.mobility = ['driving'];
    const view = f.sessions.create('owner', seed, f.context);
    expect(view.issues.map(issue => issue.code)).toContain('WALK_ROUTE_REQUIRES_WALKING');
    expect(() => f.sessions.confirm('owner', view.id, event())).toThrow('INCOMPLETE_DRAFT');
  });

  it('preserves an explicitly estimated budget and requires party size and price-basis consent', () => {
    const f = setup();
    const budget = { kind: 'limit', amount_rub: 3000, basis: 'whole_party', period: 'per_day', enforcement: 'estimated' };
    const changed = f.sessions.edit('owner', f.view.id, { ...event(), changes: [{ op: 'budget', value: budget }, { op: 'party', total: null }] });
    expect(changed.draft.shared.budget).toMatchObject({ enforcement: 'estimated' });
    expect(changed.issues.map(issue => issue.code)).toContain('BUDGET_PRICE_BASIS_REQUIRED');
    expect(changed.issues.map(issue => issue.code)).toContain('PARTY_REQUIRED');
    const agreed = f.sessions.edit('owner', f.view.id, { ...event(changed.version, 'consent-budget-2'), changes: [
      { op: 'budget', value: { ...budget, price_basis_assumption: 'per_person' } }, { op: 'party', total: 2 },
    ] });
    expect(agreed.issues.map(issue => issue.code)).not.toContain('BUDGET_PRICE_BASIS_REQUIRED');
    expect(agreed.issues.map(issue => issue.code)).not.toContain('PARTY_REQUIRED');
    expect(agreed.confirmed_version).toBeNull();
  });

  it('edits selected days atomically, preserves category restrictions/budget and invalidates confirmation', () => {
    const f = setup();
    const seed = structuredClone(f.fixture.input.intent);
    seed.days.push({ ...structuredClone(seed.days[0]!), day_id: 'd2', date: '2026-09-26' });
    const view = f.sessions.create('owner', seed, f.context);
    const confirmed = f.sessions.confirm('owner', view.id, event());
    const updated = f.sessions.edit('owner', view.id, { ...event(confirmed.version, 'event-0002'), changes: [
      { op: 'window', day_ids: ['d2'], start: '17:00', end: '20:00' },
      { op: 'budget', value: { kind: 'limit', amount_rub: 3000, basis: 'whole_party', period: 'whole_trip' } },
    ] });
    expect(updated.phase).toBe('DRAFT');
    expect(updated.draft.days[0]).toEqual(view.draft.days[0]);
    expect(updated.draft.days[1]!.window).toEqual({ start: '17:00', end: '20:00' });
    expect(updated.draft.days[1]!.activities).toEqual(view.draft.days[1]!.activities);
    expect(updated.provenance['days.d2.window']).toBe('user_form');
    expect(updated.confirmed_version).toBeNull();
  });

  it('does not apply half a patch and rejects stale versions, unknown days and extra authority fields', () => {
    const { sessions: s, view } = setup();
    expect(() => s.edit('owner', view.id, { ...event(), changes: [
      { op: 'mobility', mode: 'driving' }, { op: 'window', day_ids: ['missing'], start: '17:00', end: '20:00' },
    ] })).toThrow('UNKNOWN_DAY');
    expect(s.get('owner', view.id)).toEqual(view);
    expect(() => s.edit('owner', view.id, { ...event(), owner_id: 'other', changes: [] })).toThrow('INVALID_ACTION');
    s.edit('owner', view.id, { ...event(), changes: [{ op: 'mobility', mode: 'driving' }] });
    expect(() => s.confirm('owner', view.id, event(0, 'event-0002'))).toThrow('STALE_VERSION');
  });

  it('deduplicates an event without replaying old state and detects reuse with different content', () => {
    const { sessions: s, view } = setup();
    const edit = { ...event(), changes: [{ op: 'mobility', mode: 'driving' }] };
    const updated = s.edit('owner', view.id, edit);
    expect(s.edit('owner', view.id, edit)).toEqual(updated);
    expect(() => s.edit('owner', view.id, { ...edit, changes: [{ op: 'mobility', mode: 'walking' }] })).toThrow('EVENT_CONFLICT');
  });

  it('checks ownership before returning details; copies cannot mutate server state; expires memory state', () => {
    const f = setup();
    expect(() => f.sessions.get('stranger', f.view.id)).toThrow('DRAFT_NOT_FOUND');
    expect(() => f.sessions.confirm('stranger', f.view.id, event())).toThrow('DRAFT_NOT_FOUND');
    f.view.draft.days[0]!.activities.length = 0;
    expect(f.sessions.get('owner', f.view.id).draft.days[0]!.activities).toHaveLength(2);
    f.setNow(new Date(demoNow().getTime() + 31 * 60_000));
    expect(() => f.sessions.get('owner', f.view.id)).toThrow('DRAFT_NOT_FOUND');
  });

  it('rejects unsupported transport/point outside the trusted area without silently changing city', () => {
    const { sessions: s, view } = setup();
    expect(() => s.edit('owner', view.id, { ...event(), changes: [{ op: 'mobility', mode: 'public_transport' }] })).toThrow('UNSUPPORTED_TRANSPORT');
    expect(() => s.edit('owner', view.id, { ...event(), changes: [{ op: 'point', field: 'origin',
      point: { lat: 59, lon: 30, label: 'Начало', source: 'user_map' } }] })).toThrow('POINT_OUTSIDE_AREA');
    expect(s.get('owner', view.id).version).toBe(0);
  });

  it('returns activities in the explicitly selected order', () => {
    const { sessions: s, view } = setup();
    const updated = s.edit('owner', view.id, { ...event(), changes: [{ op: 'order', day_id: 'd1', activity_ids: ['food', 'culture'] }] });
    expect(updated.draft.days[0]!.activities.map(a => a.id)).toEqual(['food', 'culture']);
    expect(updated.draft.days[0]!.order).toEqual([['food', 'culture']]);
  });

  it('allows clearing an optional party count but then requires it for a per-person limit', () => {
    const { sessions: s, view } = setup();
    const updated = s.edit('owner', view.id, { ...event(), changes: [
      { op: 'party', total: 2 }, { op: 'budget', value: { kind: 'limit', amount_rub: 1000, basis: 'per_person', period: 'per_day' } },
    ] });
    const cleared = s.edit('owner', view.id, { ...event(updated.version, 'event-0002'), changes: [{ op: 'party', total: null }] });
    expect(cleared.draft.shared.party?.total).toBeUndefined();
    expect(cleared.issues.some(issue => issue.code === 'PARTY_REQUIRED')).toBe(true);
  });

  it('returns the recorded failure on duplicate delivery without another calculation', async () => {
    const f = setup();
    let calls = 0;
    const s = new PlanningSessions({ now: demoNow, plan: async () => { calls++; throw new Error('private-provider-error'); } });
    const view = s.create('owner', f.fixture.input.intent, f.context);
    const confirmed = s.confirm('owner', view.id, event());
    const request = event(confirmed.version, 'event-0002');
    await expect(s.calculate('owner', view.id, request)).rejects.toThrow('PLANNING_FAILED');
    await expect(s.calculate('owner', view.id, request)).rejects.toThrow('PLANNING_FAILED');
    expect(calls).toBe(1);
    expect(s.get('owner', view.id).phase).toBe('CONFIRMED');
  });

  it('allows partial draft edits but blocks confirmation of missing origin or past window', () => {
    const f = setup();
    const seed = structuredClone(f.fixture.input.intent);
    const incomplete = { ...seed, points: {} };
    const view = f.sessions.create('owner', incomplete, f.context);
    const updated = f.sessions.edit('owner', view.id, { ...event(), changes: [{ op: 'mobility', mode: 'driving' }] });
    expect(updated.issues.some(i => i.code === 'ORIGIN_REQUIRED')).toBe(true);
    expect(() => f.sessions.confirm('owner', view.id, event(updated.version, 'event-0002'))).toThrow('INCOMPLETE_DRAFT');
    expect(() => f.sessions.edit('owner', view.id, { ...event(updated.version, 'event-0003'),
      changes: [{ op: 'date', day_id: 'd1', date: '2026-09-23' }] })).not.toThrow();
    expect(f.sessions.get('owner', view.id).issues.some(i => i.code === 'WINDOW_EXPIRED')).toBe(true);
  });

  it('only calculates a confirmed revision and reuses its result on repeated delivery', async () => {
    const f = setup();
    await expect(f.sessions.calculate('owner', f.view.id, event())).rejects.toThrow('CONFIRMATION_REQUIRED');
    const confirmed = f.sessions.confirm('owner', f.view.id, event());
    const request = event(confirmed.version, 'event-0002');
    const result = await f.sessions.calculate('owner', f.view.id, request);
    expect(result.phase).toBe('RESULT');
    expect(result.result?.status).toBe('AVAILABLE');
    expect(result.result?.days[0]?.visits.map(v => v.name)).toEqual(['Учебный музей', 'Учебное кафе']);
    const requestCount = f.fixture.requests.length;
    expect(await f.sessions.calculate('owner', f.view.id, request)).toEqual(result);
    expect(f.fixture.requests.length).toBe(requestCount);
    await expect(f.sessions.calculate('owner', f.view.id, event(confirmed.version, 'event-0003'))).rejects.toThrow('RESULT_ALREADY_EXISTS');
  }, 30_000);

  it('uses a server-owned walk duration estimate without changing the cafe activity', async () => {
    const f = setup(); let submitted: Record<string, unknown> | undefined;
    const context = { ...f.context, visit_policy: { ...f.context.visit_policy, walkable_category_ids: ['100'] } };
    const s = new PlanningSessions({ now: demoNow, plan: job => {
      submitted = job;
      return planPlacesWithDgis(f.fixture.client(), job,
        { retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test', now: demoNow });
    } });
    const seed = structuredClone(f.fixture.input.intent);
    seed.days[0]!.activities[0]!.label = 'Прогулка';
    const view = s.create('owner', seed, context);
    const confirmed = s.confirm('owner', view.id, event());
    await s.calculate('owner', view.id, event(confirmed.version, 'event-0002'));
    expect(submitted?.visit_policy).toMatchObject({ by_activity: { culture: 5 },
      max_stops_by_activity: { culture: 36 } });
    const intent = submitted?.intent as typeof seed;
    expect(intent.days[0]!.activities[0]!.categories.include_any).toEqual(['100']);
  }, 30_000);

  it.each([true, false])('explicitly refreshes an unexpired result and preserves conditions (initial denial: %s)', async denied => {
    const f = setup(); let unavailable = denied;
    const plan = (job: Record<string, unknown>) => planPlacesWithDgis(f.fixture.client(async (url, init) => {
      if (unavailable && init?.body) return Response.json({}, { status: 429 });
      return f.fixture.defaultFetch(url, init);
    }), job, { retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test', now: demoNow });
    let sessions = new PlanningSessions({ now: demoNow, plan });
    const draft = sessions.create('owner', f.fixture.input.intent, f.context);
    const confirmed = sessions.confirm('owner', draft.id, event());
    const first = await sessions.calculate('owner', draft.id, event(confirmed.version, 'first-calculation'));
    expect(first.result?.status).toBe(denied ? 'ERROR' : 'AVAILABLE');
    unavailable = false;
    const refresh = { ...event(first.version, 'explicit-refresh'), refresh: true };
    const refreshed = await sessions.calculate('owner', draft.id, refresh);
    expect(refreshed.result?.status).toBe('AVAILABLE');
    expect(refreshed.draft).toEqual(confirmed.draft);
    expect(refreshed.version).toBe(first.version + 1);
    expect(refreshed.confirmed_version).toBe(refreshed.version);
    const paidCalls = f.fixture.requests.length;
    sessions = new PlanningSessions({ now: demoNow, plan, checkpoint: sessions.checkpoint() });
    expect(await sessions.calculate('owner', draft.id, refresh)).toEqual(refreshed);
    expect(f.fixture.requests.length).toBe(paidCalls);
    await expect(sessions.calculate('owner', draft.id, { ...refresh, event_id: 'stale-refresh' })).rejects.toThrow('STALE_VERSION');
    await expect(sessions.calculate('foreign-owner', draft.id, { ...refresh, base_version: refreshed.version }))
      .rejects.toThrow('DRAFT_NOT_FOUND');
    expect(f.fixture.requests.length).toBe(paidCalls);
  }, 30_000);

  it('derives the route-walk upper bound from the time window, not a fixed stop count', async () => {
    const f = setup(); let submitted: Record<string, unknown> | undefined;
    const context = { ...f.context, visit_policy: { ...f.context.visit_policy, walkable_category_ids: ['100'] } };
    const sessions = new PlanningSessions({ now: demoNow, plan: async job => { submitted = job;
      return { status: 'UNAVAILABLE', warnings: [], days: [{ day_id: 'd1', date: '2026-09-25',
        status: 'UNAVAILABLE', visits: [], missing_activity_ids: ['culture'] }] }; } });
    const seed = structuredClone(f.fixture.input.intent);
    seed.days[0]!.activities = [seed.days[0]!.activities[0]!];
    seed.days[0]!.order = [];
    seed.days[0]!.activities[0]!.label = 'Пешая экскурсия по городским улицам';
    seed.days[0]!.activities[0]!.intent_kind = 'route_walk';
    seed.days[0]!.activities[0]!.selection = { category_policy: 'related_allowed', named_types: [] };
    seed.days[0]!.activities[0]!.requirements = [];
    const view = sessions.create('owner', seed, context);
    const confirmed = sessions.confirm('owner', view.id, event());
    await sessions.calculate('owner', view.id, event(confirmed.version, 'event-0002'));
    expect(submitted?.visit_policy).toMatchObject({ by_activity: { culture: 5 },
      max_stops_by_activity: { culture: 36 } });
  });

  it.each([
    { end: '19:00', status: 'LIMITED', activityIds: ['culture', 'food'] },
    { end: '20:00', status: 'AVAILABLE', activityIds: ['culture', 'culture', 'food'] },
  ])('preserves walk durations and the later cafe until $end ($status)', async ({ end, status, activityIds }) => {
    const f = setup();
    f.fixture.items.find(item => item.id === 'far')!.point = { lat: 55.752, lon: 37.625 };
    const context = { ...f.context, visit_policy: { ...f.context.visit_policy, walkable_category_ids: ['100'] } };
    const sessions = new PlanningSessions({ now: demoNow, plan: job => planPlacesWithDgis(f.fixture.client(), job,
      { retrieval: { radiusMeters: 5000, maxPages: 1 }, dataMode: 'test', now: demoNow }) });
    const seed = structuredClone(f.fixture.input.intent);
    seed.days[0]!.activities[0]!.label = 'Прогуляться по городу';
    seed.days[0]!.activities[0]!.intent_kind = 'route_walk';
    seed.days[0]!.window.end = end;
    const view = sessions.create('owner', seed, context);
    const confirmed = sessions.confirm('owner', view.id, event());
    const planned = await sessions.calculate('owner', view.id, event(confirmed.version, 'event-0002'));
    expect(planned.result?.status).toBe(status);
    expect(planned.result?.days[0]?.visits.map(visit => visit.activity_id)).toEqual(activityIds);
    expect(planned.result?.days[0]?.missing_activity_ids).toEqual([]);
    expect(planned.result?.days[0]?.visits.map(visit => visit.ends_at - visit.starts_at))
      .toEqual(activityIds.map(id => id === 'culture' ? 60 : 45));
    expect(planned.result?.warnings.includes('WALK_WAYPOINTS_INCOMPLETE')).toBe(status === 'LIMITED');
    expect(new Set(planned.result?.days[0]?.visits.map(visit => visit.place_id)).size).toBe(activityIds.length);
  }, 30_000);

  it('does not let a broad model proposal route a walk to a hotel category', async () => {
    const f = setup(); let submitted: Record<string, unknown> | undefined;
    const context = { ...f.context, catalog: { ...f.context.catalog,
      leaf_ids: [...f.context.catalog.leaf_ids, 'hotel'] },
    visit_policy: { ...f.context.visit_policy, walkable_category_ids: ['100'] } };
    const s = new PlanningSessions({ now: demoNow, plan: async job => { submitted = job;
      return { status: 'UNAVAILABLE', warnings: [], days: [{ day_id: 'd1', date: '2026-09-25',
        status: 'UNAVAILABLE', visits: [], missing_activity_ids: ['culture'] }] }; } });
    const seed = structuredClone(f.fixture.input.intent);
    seed.days[0]!.activities[0]!.label = 'прогулка';
    seed.days[0]!.activities[0]!.categories.include_any = ['hotel', '100'];
    const view = s.create('owner', seed, context);
    const confirmed = s.confirm('owner', view.id, event());
    await s.calculate('owner', view.id, event(confirmed.version, 'event-0002'));
    const intent = submitted?.intent as typeof seed;
    expect(intent.days[0]!.activities[0]!.categories.include_any).toEqual(['100']);
  });

  it('keeps an explicit walk in a park within park categories, not other outdoor landmarks', async () => {
    const f = setup(); let submitted: Record<string, unknown> | undefined;
    const context = { ...f.context, catalog: { ...f.context.catalog,
      leaf_ids: [...f.context.catalog.leaf_ids, '168', '112668'] },
    visit_policy: { ...f.context.visit_policy, walkable_category_ids: ['168', '112668'], park_category_ids: ['168'] } };
    const s = new PlanningSessions({ now: demoNow, plan: async job => { submitted = job;
      return { status: 'UNAVAILABLE', warnings: [], days: [{ day_id: 'd1', date: '2026-09-25',
        status: 'UNAVAILABLE', visits: [], missing_activity_ids: ['culture'] }] }; } });
    const seed = structuredClone(f.fixture.input.intent);
    seed.days[0]!.activities[0]!.label = 'прогулка в парке';
    seed.days[0]!.activities[0]!.categories.include_any = ['112668'];
    const view = s.create('owner', seed, context);
    const confirmed = s.confirm('owner', view.id, event());
    await s.calculate('owner', view.id, event(confirmed.version, 'event-0002'));
    const intent = submitted?.intent as typeof seed;
    expect(intent.days[0]!.activities[0]!.categories.include_any).toEqual(['168']);
  });

  it('drops a late computation after a form edit, and rejects duplicate concurrent work', async () => {
    const f = setup();
    let finish!: (value: Record<string, unknown>) => void;
    const s = new PlanningSessions({ now: demoNow, plan: () => new Promise(resolve => { finish = resolve; }) });
    const view = s.create('owner', f.fixture.input.intent, f.context);
    const confirmed = s.confirm('owner', view.id, event());
    const request = event(confirmed.version, 'event-0002');
    const pending = s.calculate('owner', view.id, request);
    await expect(s.calculate('owner', view.id, request)).rejects.toThrow('PLAN_IN_PROGRESS');
    const edited = s.edit('owner', view.id, { ...event(confirmed.version, 'event-0003'), changes: [{ op: 'mobility', mode: 'driving' }] });
    finish({ status: 'UNAVAILABLE', days: [], warnings: [] });
    await expect(pending).rejects.toThrow('STALE_RESULT');
    expect(s.get('owner', view.id)).toEqual(edited);
  });
});
