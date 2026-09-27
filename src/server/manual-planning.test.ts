import { describe, expect, it } from 'vitest';
import { manualOptions, manualSeed } from './manual-planning.js';
import { intentFixture } from './intent-start.fixture.js';
import { PlanningSessions } from './planning-sessions.js';
import { projectSavedConditions, remapSavedConditions } from './saved-conditions.js';

export function manualFixture() {
  const f = intentFixture(), context = { ...f.context, planning: {
    catalog: { version: f.context.catalog.version, region_id: '32', leaf_ids: ['100', '200', '300'] },
    visit_policy: { version: 'synthetic.v1', by_category: { '100': 60, '200': 45, '300': 45 },
      walkable_category_ids: ['300'], arrival_buffer_minutes: 5 }, modes: ['walking', 'driving'] as const, data_mode: 'test' as const,
  } };
  context.catalog.rows.push(['300', 'Набережные', []], ['999', 'Неподдержанный тип', []]);
  const input = { event_id: 'manual-event-001', locality_token: 'synthetic', catalog_version: 'synthetic.v1', mobility: 'walking',
    days: [{ date: '2026-09-25', start: '16:00', end: '20:00', ordered: true,
      activities: [{ kind: 'walk' }, { kind: 'place', category_ids: ['200'] }] }] };
  return { context, input };
}
describe('manual choices to confirmed-intent draft without a language model', () => {
  it('preserves walking, eating and explicit order; saved own conditions remap without LLM', () => {
    const { context, input } = manualFixture(), { seed, provenance } = manualSeed(input, context);
    expect(seed.days[0]!.activities.map(a => [a.intent_kind, a.categories.include_any])).toEqual([
      ['route_walk', ['300']], ['place_visit', ['200']],
    ]);
    expect(seed.days[0]!.order).toEqual([['day-1-activity-1', 'day-1-activity-2']]);
    const sessions = new PlanningSessions({ now: () => new Date(context.now), plan: async () => { throw new Error('Planner must not run'); } });
    const view = sessions.create('synthetic-owner', seed, context.planning, provenance);
    expect(view).toMatchObject({ confirmed_version: null, result: null, phase: 'DRAFT' });
    expect(view.issues).toEqual([{ code: 'ORIGIN_REQUIRED', field: 'points.origin' }]);
    const saved = projectSavedConditions(view, { now: new Date(context.now) });
    expect(saved.days[0]!.activities[1]!.selection.named_types).toEqual(['Кафе']);
    const remapped = remapSavedConditions(saved, context);
    expect(remapped.status).toBe('RESTORABLE');
    expect(JSON.stringify(saved)).not.toMatch(/include_any|catalog_version|leaf_ids|synthetic-owner/);
  });
  it('offers only known catalog leaves with an explicit duration estimate', () => {
    const { context } = manualFixture(), choices = manualOptions(context);
    expect(choices.categories.map(c => c.id).sort()).toEqual(['100', '200', '300']);
    expect(choices.walking_available).toBe(true);
  });
  it.each(['wrong-category', 'old-catalog', 'overlap', 'client-facts', 'walk-driving'])('rejects %s before creating a draft', reason => {
    const { context, input } = manualFixture();
    if (reason === 'wrong-category') input.days[0]!.activities[1]!.category_ids = ['999'];
    if (reason === 'old-catalog') input.catalog_version = 'old';
    if (reason === 'overlap') input.days[0]!.end = '15:00';
    if (reason === 'client-facts') Object.assign(input, { result: { status: 'AVAILABLE' } });
    if (reason === 'walk-driving') input.mobility = 'driving';
    expect(() => manualSeed(input, context)).toThrow();
  });
  it('retains separate days and only the order chosen by the user', () => {
    const { context, input } = manualFixture();
    input.days.push({ ...structuredClone(input.days[0]!), date: '2026-09-26', ordered: false });
    const { seed } = manualSeed(input, context);
    expect(seed.days).toHaveLength(2);
    expect(seed.days[1]!.order).toEqual([]);
    expect(seed.days[1]!.activities[0]!.id).not.toBe(seed.days[0]!.activities[0]!.id);
  });
});
