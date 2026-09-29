import { describe, expect, it } from 'vitest';
import type { PlanningView } from '../shared/planning-form';
import { resultValidUntil, placesStaleAt } from './result-freshness';

function view(): Pick<PlanningView, 'expires_at' | 'result'> {
  return { expires_at: '2026-09-27T12:30:00.000Z', result: { status: 'AVAILABLE', warnings: [], days: [{ day_id: 'day', date: '2026-09-27', status: 'AVAILABLE', missing_activity_ids: [], visits: [{
    activity_id: 'a', place_id: 'p', name: 'Synthetic place', starts_at: 600, ends_at: 660, travel_before_minutes: 10, arrival_buffer_minutes: 5, price_expected_minor: null, warnings: [],
    source: { provider: 'fixture', fetched_at: '2026-09-27T12:00:00.000Z', valid_until: '2026-09-27T12:10:00.000Z', data_mode: 'test' },
  }] }] } };
}
describe('client result freshness across legacy checkpoints', () => {
  it('warns for saved places after thirty minutes without extending original source dates', () => {
    const plan: PlanningView['result'] = { status: 'PLACES_FOUND', days: [], warnings: [], candidate_preview: { groups: [
      { day_id: 'd', activity_id: 'a', places: [{ place_id: 'p', name: 'Place', location_label: null,
        source: { provider: '2gis', url: null, data_mode: 'test', fetched_at: '2026-09-27T12:00:00Z', valid_until: '2026-09-27T12:05:00Z' } }] },
    ] } };
    expect(placesStaleAt(plan)).toBe('2026-09-27T12:30:00.000Z');
    expect(plan.candidate_preview!.groups[0]!.places[0]!.source.valid_until).toBe('2026-09-27T12:05:00Z');
  });
  it('does not renew a legacy result to the longer draft or source deadline', () => {
    expect(resultValidUntil(view())).toBe('2026-09-27T12:05:00.000Z');
  });
  it('honours an earlier aggregate deadline from hidden matrix observations', () => {
    const value = view(); value.result!.valid_until = '2026-09-27T12:02:00.000Z';
    expect(resultValidUntil(value)).toBe('2026-09-27T12:02:00.000Z');
  });
  it('an aggregate deadline cannot extend an earlier visible source expiry', () => {
    const value = view(); value.result!.valid_until = '2026-09-27T12:04:00.000Z';
    value.result!.days[0]!.visits[0]!.source!.valid_until = '2026-09-27T12:01:00.000Z';
    expect(resultValidUntil(value)).toBe('2026-09-27T12:01:00.000Z');
  });
  it('closes provider facts when their source timestamp is corrupt or absent', () => {
    const value = view(); value.result!.days[0]!.visits[0]!.source!.fetched_at = 'invalid';
    expect(Date.parse(resultValidUntil(value))).toBe(0);
    delete value.result!.days[0]!.visits[0]!.source;
    expect(Date.parse(resultValidUntil(value))).toBe(0);
  });
  it('retains a source-free failure explanation until the draft expires', () => {
    const value = view(); value.result = { status: 'ERROR', warnings: [], issues: ['PLANNER_UNAVAILABLE'], days: [] };
    expect(resultValidUntil(value)).toBe(value.expires_at);
  });
});
