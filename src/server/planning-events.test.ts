import { expect, it } from 'vitest';
import { PlanningSessions } from './planning-sessions.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { FormDraft } from '../shared/planning-form.js';

function fixture() {
  let clock = +demoNow();
  const f = planningFixture(), now = () => new Date(clock);
  const options = { now, plan: async (): Promise<never> => { throw Error('Selection must not calculate a route'); } };
  const sessions = new PlanningSessions(options), context = { catalog: f.input.catalog, visit_policy: f.input.visit_policy,
    modes: ['walking'] as const, data_mode: 'test' as const };
  const view = sessions.create('owner', f.input.intent, context);
  const target = { kind: 'event' as const, provider: 'kudago' as const, event_id: '17', occurrence_key: 'a'.repeat(64) };
  const evidence = () => ({ date: '2026-09-25', valid_until: new Date(clock + 300_000).toISOString(),
    point: { lat: 55.751, lon: 37.621 }, display: { event_ref: { provider: target.provider, event_id: target.event_id, occurrence_key: target.occurrence_key },
      title: 'Синтетический сеанс', date: '2026-09-25', schedule: { kind: 'fixed' as const,
        windows_utc: [{ start_utc: Date.parse('2026-09-25T13:30:00Z') / 1000, end_utc: Date.parse('2026-09-25T14:30:00Z') / 1000 }] },
      point: { lat: 55.751, lon: 37.621 }, venue_name: 'Учебная площадка', location_label: null,
      source: { provider: 'kudago' as const, url: 'https://kudago.com/nnv/event/synthetic-test-only/',
        data_mode: 'test' as const, fetched_at: now().toISOString(), valid_until: new Date(clock + 300_000).toISOString() },
      age: { state: 'known' as const, minimum: 0 }, price: { display: 'Бесплатно', kind: 'free' as const,
        admission_upper_minor: 0 as const, basis: 'admission' as const, strict_eligible: true }, warnings: [],
      duration: { minutes: 60, basis: 'provider_session' as const } } });
  const input = { base_version: view.version, event_id: 'select-event-001', day_id: 'd1', replace_activity_id: 'culture', target, evidence: evidence() };
  return { f, sessions, options, context, view, target, evidence, input, advance(ms: number) { clock += ms; } };
}

it('selects an event as a distinct activity, preserves food/order, and keeps provider display outside own draft', () => {
  const f = fixture();
  const selected = f.sessions.selectEvent('owner', f.view.id, f.input);
  expect(selected.draft.days[0]!.activities[0]).toEqual({ id: 'culture', label: 'Выбранное событие', requirements: [],
    intent_kind: 'event_visit', target: f.target });
  expect(selected.draft.days[0]!.activities[1]).toEqual(f.view.draft.days[0]!.activities[1]);
  expect(selected.draft.days[0]!.order).toEqual([['culture', 'food']]);
  expect(JSON.stringify(selected.draft)).not.toContain('Синтетический сеанс');
  expect(selected.event_previews?.[JSON.stringify(['d1', 'culture'])]?.title).toBe('Синтетический сеанс');
  expect(selected).toMatchObject({ phase: 'DRAFT', result: null, confirmed_version: null, version: 1, issues: [] });
  expect(f.sessions.selectEvent('owner', f.view.id, f.input)).toEqual(selected);
  expect(f.sessions.confirm('owner', f.view.id, { base_version: 1, event_id: 'confirm-event-001' }).phase).toBe('CONFIRMED');
});

it('rejects foreign, stale, mismatched, expired and disguised event inputs before changing conditions', () => {
  const f = fixture();
  expect(() => f.sessions.selectEvent('foreign', f.view.id, f.input)).toThrow('DRAFT_NOT_FOUND');
  expect(() => f.sessions.selectEvent('owner', f.view.id, { ...f.input, base_version: 9 })).toThrow('STALE_VERSION');
  expect(() => f.sessions.selectEvent('owner', f.view.id, { ...f.input, target: { ...f.target, occurrence_key: 'b'.repeat(64) } })).toThrow('EVENT_SELECTION_CHANGED');
  expect(() => f.sessions.selectEvent('owner', f.view.id, { ...f.input, target: { ...f.target, visit_duration_minutes: 30 } })).toThrow('EVENT_DURATION_REQUIRED');
  expect(() => f.sessions.selectEvent('owner', f.view.id, { ...f.input, evidence: { ...f.input.evidence, valid_until: demoNow().toISOString() } })).toThrow('EVENT_PREVIEW_EXPIRED');
  const mixed = structuredClone(f.view.draft);
  Object.assign(mixed.days[0]!.activities[0]!, { target: f.target, intent_kind: 'event_visit' });
  expect(FormDraft.safeParse(mixed).success).toBe(false);
  expect(() => f.sessions.edit('owner', f.view.id, { base_version: 0, event_id: 'raw-http-selection',
    changes: [{ op: 'selectEvent', ...f.input }] })).toThrow('INVALID_ACTION');
  expect(f.sessions.get('owner', f.view.id)).toEqual(f.view);
});

it('requires a fresh explicit recheck after expiry, restart without evidence, or a changed day', () => {
  const f = fixture(), selected = f.sessions.selectEvent('owner', f.view.id, f.input);
  f.advance(300_001);
  const expired = f.sessions.get('owner', f.view.id);
  expect(expired.event_previews).toBeUndefined();
  expect(expired.issues).toContainEqual({ code: 'EVENT_RECHECK_REQUIRED', field: 'days.d1.activities.culture' });
  expect(expired.draft).toEqual(selected.draft);
  expect(() => f.sessions.confirm('owner', f.view.id, { base_version: 1, event_id: 'expired-confirm' })).toThrow('INCOMPLETE_DRAFT');
  const refreshed = f.sessions.recheckEvent('owner', f.view.id, { base_version: 1, event_id: 'fresh-recheck-001',
    day_id: 'd1', activity_id: 'culture', evidence: f.evidence() });
  expect(refreshed.issues).toEqual([]); expect(refreshed.version).toBe(2);
  const changed = f.sessions.edit('owner', f.view.id, { base_version: 2, event_id: 'event-date-change',
    changes: [{ op: 'date', day_id: 'd1', date: '2026-09-26' }] });
  expect(changed.event_previews).toBeUndefined();
  expect(changed.issues.some(issue => issue.code === 'EVENT_RECHECK_REQUIRED')).toBe(true);
  const restored = new PlanningSessions(f.options).create('owner', selected.draft, f.context);
  expect(restored.event_previews).toBeUndefined();
  expect(restored.issues.some(issue => issue.code === 'EVENT_RECHECK_REQUIRED')).toBe(true);
});

it('binds event evidence by both day and activity and requires an explicit duration for visit windows', () => {
  const f = fixture(), evidence = f.evidence();
  const target = { ...f.target, visit_duration_minutes: 45 };
  const flexible = { ...evidence, display: { ...evidence.display, schedule: { ...evidence.display.schedule, kind: 'visit_window' as const },
    duration: { minutes: 45, basis: 'user_estimate' as const } } };
  const selected = f.sessions.selectEvent('owner', f.view.id, { ...f.input, target, evidence: flexible });
  expect(selected.event_previews?.[JSON.stringify(['d1', 'culture'])]?.duration).toEqual({ minutes: 45, basis: 'user_estimate' });
  const anotherDay = structuredClone(selected.draft.days[0]!); anotherDay.day_id = 'd2'; anotherDay.date = '2026-09-26';
  const checkpoint = f.sessions.checkpoint(); checkpoint.records[0]!.view.draft.days.push(anotherDay);
  const restarted = new PlanningSessions({ ...f.options, checkpoint }).get('owner', f.view.id);
  expect(restarted.event_previews?.[JSON.stringify(['d2', 'culture'])]).toBeUndefined();
  expect(restarted.issues).toContainEqual({ code: 'EVENT_RECHECK_REQUIRED', field: 'days.d2.activities.culture' });
});
