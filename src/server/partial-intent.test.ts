import { expect, it } from 'vitest';
import { parseInitialIntent } from './intent-start.js';
import { intentFixture } from './intent-start.fixture.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { PlanningSessions } from './planning-sessions.js';
import { projectSavedConditions, remapSavedConditions } from './saved-conditions.js';
import { projectSharedConditions } from './route-sharing-projection.js';

it('retains verified activities, time and order while one budget question is unresolved', async () => {
  const f = intentFixture(), places = planningFixture();
  const text = f.text + ', бюджет примерно как обычно';
  const response = { ...structuredClone(f.response), unresolved: [{ field: 'budget', day_ids: [], text: 'бюджет примерно как обычно', reason: 'ambiguous' }] };
  let calls = 0;
  const parsed = await parseInitialIntent({ ...f.context, userText: text, inputId: 'partial-budget' }, async () => { calls++; return response; });
  expect(parsed.status).toBe('draft'); if (parsed.status !== 'draft') throw Error('Expected partial draft');
  expect(parsed.draft.days[0]?.activities.map(a => a.label)).toEqual(['музей', 'кафе']);
  expect(parsed.draft.days[0]?.window).toEqual({ start: '16:00', end: '19:00' });
  expect(parsed.draft.days[0]?.order).toHaveLength(1);
  expect(parsed.draft.clarifications).toEqual([expect.objectContaining({ field: 'budget', text: 'бюджет примерно как обычно' })]);
  const context = { catalog: places.input.catalog, visit_policy: places.input.visit_policy, modes: ['walking'] as const, data_mode: 'test' as const };
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => { throw Error('No calculation before clarification'); } });
  const view = sessions.create('owner', parsed.draft, context, parsed.provenance);
  expect(sessions.checkpoint().version).toBe(2);
  const restoredSessions = new PlanningSessions({ now: demoNow, plan: async () => { throw Error('Must not calculate'); },
    checkpoint: sessions.checkpoint() });
  expect(restoredSessions.get('owner', view.id).draft.clarifications).toEqual(parsed.draft.clarifications);
  expect(view.issues.some(issue => issue.code === 'INPUT_CLARIFICATION_REQUIRED')).toBe(true);
  expect(() => sessions.confirm('owner', view.id, { base_version: view.version, event_id: 'premature-confirm' })).toThrow('INCOMPLETE_DRAFT');
  const saved = projectSavedConditions(view, { now: demoNow() });
  expect(saved.clarifications).toEqual(parsed.draft.clarifications);
  const remapped = remapSavedConditions(saved, { ...f.context, planning: context });
  expect(remapped.status).toBe('RESTORABLE');
  if (remapped.status === 'RESTORABLE') expect(remapped.draft.clarifications).toEqual(parsed.draft.clarifications);
  expect(() => projectSharedConditions(saved, false)).toThrow('SHARE_CLARIFICATION_REQUIRED');
  const qid = parsed.draft.clarifications![0]!.id;
  expect(() => sessions.edit('owner', view.id, { base_version: view.version, event_id: 'empty-budget-answer',
    changes: [{ op: 'resolve_clarification', clarification_id: qid }] })).toThrow('CLARIFICATION_VALUE_REQUIRED');
  const answered = sessions.edit('owner', view.id, { base_version: view.version, event_id: 'choose-unlimited-budget',
    changes: [{ op: 'budget', value: { kind: 'unlimited' } }] });
  expect(answered.draft.clarifications).toEqual(parsed.draft.clarifications);
  const action = { base_version: answered.version, event_id: 'confirm-budget-answer', changes: [{ op: 'resolve_clarification', clarification_id: qid }] };
  const resolved = sessions.edit('owner', view.id, action);
  expect(resolved.draft.clarifications).toBeUndefined();
  expect(sessions.checkpoint().version).toBe(1);
  expect(resolved.draft.days).toEqual(parsed.draft.days);
  expect(resolved.confirmed_version).toBeNull();
  expect(sessions.edit('owner', view.id, action)).toEqual(resolved);
  expect(() => sessions.edit('foreign', view.id, action)).toThrow('DRAFT_NOT_FOUND');
  expect(() => sessions.edit('owner', view.id, { ...action, event_id: 'stale-budget-answer' })).toThrow('STALE_VERSION');
  expect(calls).toBe(1);
});

it('preserves an unmatched activity through saving and a typed category choice, including its ID, requirements and order', () => {
  const f = planningFixture(), intent = structuredClone(f.input.intent);
  intent.days[0]!.activities[0]!.label = 'музей';
  intent.days[0]!.activities[0]!.selection.named_types = ['Музеи'];
  intent.days[0]!.activities[1]!.categories = { ...intent.days[0]!.activities[1]!.categories, state: 'no_match', include_any: [] };
  const context = { catalog: { ...f.input.catalog, category_names: { '100': 'Музеи', '200': 'Кафе' } },
    visit_policy: f.input.visit_policy, modes: ['walking'] as const, data_mode: 'test' as const };
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => { throw Error('Must not calculate'); } });
  const view = sessions.create('owner', intent, context);
  const old = view.draft.days[0]!.activities[1]!;
  old.requirements = [{ text: 'тихо', strength: 'preferred' }];
  const withRequirement = sessions.create('owner', view.draft, context);
  const saved = projectSavedConditions(withRequirement, { now: demoNow() });
  const restored = remapSavedConditions(saved, { ...intentFixture().context, planning: context });
  expect(restored.status).toBe('RESTORABLE');
  if (restored.status !== 'RESTORABLE') throw Error('Partial request must reopen');
  const recreated = sessions.create('owner', restored.draft, context);
  const chosen = sessions.edit('owner', recreated.id, { base_version: recreated.version, event_id: 'choose-food-category',
    changes: [{ op: 'activity_choice', day_id: 'd1', activity_id: 'food', catalog_version: context.catalog.version,
      choice: { kind: 'place', category_ids: ['200'] } }] });
  expect(chosen.draft.days[0]!.activities[1]).toMatchObject({ id: 'food', requirements: old.requirements,
    categories: { state: 'matched', include_any: ['200'] } });
  expect(chosen.draft.days[0]!.order).toEqual(view.draft.days[0]!.order);
});

it('does not let a generic confirmation dismiss an unsupported requirement or remove unrelated questions', () => {
  const f = planningFixture();
  const context = { catalog: f.input.catalog, visit_policy: f.input.visit_policy, modes: ['walking'] as const, data_mode: 'test' as const };
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => { throw Error('Must not calculate'); } });
  const view = sessions.create('owner', { ...f.input.intent, clarifications: [
    { id: 'q1', field: 'requirements', text: 'без лестниц', reason: 'not_representable', day_ids: ['d1'] },
    { id: 'q2', field: 'activities', text: 'есть не хочу', reason: 'ambiguous', day_ids: ['d1'] },
  ] }, context);
  expect(() => sessions.edit('owner', view.id, { base_version: 0, event_id: 'unsupported-answer', changes: [{ op: 'resolve_clarification', clarification_id: 'q1' }] })).toThrow('CLARIFICATION_VALUE_REQUIRED');
  const reviewed = sessions.edit('owner', view.id, { base_version: 0, event_id: 'explicit-activity-review', changes: [{ op: 'resolve_clarification', clarification_id: 'q2' }] });
  expect(reviewed.draft.clarifications?.map(q => q.id)).toEqual(['q1']);
  expect(() => sessions.confirm('owner', view.id, { base_version: reviewed.version, event_id: 'cannot-dismiss-rest' })).toThrow('INCOMPLETE_DRAFT');
});

it('preserves category exclusions and refuses a replacement that contradicts them', () => {
  const f = planningFixture();
  const context = { catalog: { ...f.input.catalog, leaf_ids: ['100', '200', '201'],
    category_names: { '100': 'Музеи', '200': 'Кафе', '201': 'Столовые' } },
    visit_policy: { ...f.input.visit_policy, by_category: { ...f.input.visit_policy.by_category, '201': 45 } },
    modes: ['walking'] as const, data_mode: 'test' as const };
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => { throw Error('Must not calculate'); } });
  const initial = sessions.create('owner', f.input.intent, context).draft;
  initial.days[0]!.activities[1]!.categories.exclude = ['201'];
  initial.days[0]!.activities[1]!.requirements = [{ text: 'без столовых', strength: 'required' }];
  const view = sessions.create('owner', initial, context);
  const action = (category: string) => ({ base_version: view.version, event_id: `choose-${category}`,
    changes: [{ op: 'activity_choice', day_id: 'd1', activity_id: 'food', catalog_version: context.catalog.version,
      choice: { kind: 'place', category_ids: [category] } }] });
  expect(() => sessions.edit('owner', view.id, action('201'))).toThrow('ACTIVITY_EXCLUSIONS_REVIEW_REQUIRED');
  const chosen = sessions.edit('owner', view.id, action('200'));
  expect(chosen.draft.days[0]!.activities[1]).toMatchObject({ id: 'food', requirements: initial.days[0]!.activities[1]!.requirements,
    categories: { include_any: ['200'], exclude: ['201'] } });
  expect(chosen.draft.days[0]!.order).toEqual(initial.days[0]!.order);
});

it('retains the repaired request for typed category selection after the two-call budget is spent', async () => {
  const f = intentFixture();
  const valid = structuredClone(f.response);
  for (const match of valid.days[0]!.category_matches) { match.state = 'no_match'; match.include_any = []; }
  const invalid = structuredClone(valid);
  invalid.days[0]!.activity_edits[0]!.evidence = 'invented quotation';
  let calls = 0;
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'partial-after-repair' }, async () => {
    calls++;
    if (calls > 2) throw Error('Paid call budget exceeded');
    return { kind: 'initial_extraction_v1', proposal: calls === 1 ? invalid : valid };
  });
  expect(calls).toBe(2);
  expect(result.status).toBe('draft'); if (result.status !== 'draft') throw Error('Expected partial draft');
  expect(result.draft.days[0]!.window).toEqual({ start: '16:00', end: '19:00' });
  expect(result.draft.days[0]!.activities.map(activity => [activity.label, activity.categories.state])).toEqual([
    ['музей', 'no_match'], ['кафе', 'no_match'],
  ]);
  expect(result.draft.days[0]!.order).toEqual([['day-1-activity-1', 'day-1-activity-2']]);
});

it('still rejects unsupported evidence and lost activities in a supposedly partial response', async () => {
  const f = intentFixture();
  const response = { ...structuredClone(f.response), unresolved: [{ field: 'budget', day_ids: [], text: 'invented quote', reason: 'ambiguous' }] };
  await expect(parseInitialIntent({ ...f.context, userText: f.text, inputId: 'bad-partial' }, async () => response)).rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE' });
  response.unresolved[0]!.text = f.text;
  response.days[0]!.activity_edits = response.days[0]!.activity_edits.slice(0, 1);
  response.days[0]!.category_matches = response.days[0]!.category_matches.slice(0, 1);
  response.days[0]!.order_changes = [];
  await expect(parseInitialIntent({ ...f.context, userText: f.text, inputId: 'lost-partial' }, async () => response)).rejects.toBeDefined();
});

it.each(['бюджет как обычно', 'денег немного', 'бюджет на твоё усмотрение', 'сумму пока не решил'])
('does not turn an ambiguous budget into unlimited spending: %s', async quote => {
  const f = intentFixture(), response = structuredClone(f.response);
  response.shared_updates.push({ op: 'set', field: 'budget', value: { kind: 'unlimited' }, evidence: quote });
  let calls = 0;
  const result = await parseInitialIntent({ ...f.context, userText: `${f.text} ${quote}`, inputId: 'unproven-unlimited' }, async () => { calls++; return response; });
  expect(result.status).toBe('draft'); if (result.status !== 'draft') throw Error('Expected partial draft');
  expect(result.draft.shared.budget).toBeUndefined();
  expect(result.draft.clarifications).toContainEqual(expect.objectContaining({ field: 'budget', text: quote }));
  expect(result.draft.days[0]!.activities.map(a => a.label)).toEqual(['музей', 'кафе']);
  expect(result.draft.days[0]!.window).toEqual({ start: '16:00', end: '19:00' });
  expect(calls).toBe(1);
});

it.each(['Бюджет не ограничен', 'Без ограничения бюджета', 'На расходы ограничений нет', 'Цена не имеет значения', 'Бюджет любой'])
('accepts explicitly unlimited spending without a spurious question: %s', async quote => {
  const f = intentFixture(), response = structuredClone(f.response);
  response.shared_updates.push({ op: 'set', field: 'budget', value: { kind: 'unlimited' }, evidence: quote });
  const result = await parseInitialIntent({ ...f.context, userText: `${f.text} ${quote}`, inputId: 'explicit-unlimited' }, async () => response);
  expect(result.status).toBe('draft'); if (result.status !== 'draft') throw Error('Expected draft');
  expect(result.draft.shared.budget).toEqual({ kind: 'unlimited' });
  expect(result.draft.clarifications).toBeUndefined();
});

it('keeps an omitted budget mention as a question without inferring an amount or duplicating an existing question', async () => {
  const f = intentFixture(), text = `${f.text} Бюджет обсудим отдельно.`;
  const omitted = await parseInitialIntent({ ...f.context, userText: text, inputId: 'omitted-budget' }, async () => f.response);
  expect(omitted.status).toBe('draft'); if (omitted.status !== 'draft') throw Error('Expected partial draft');
  expect(omitted.draft.shared.budget).toBeUndefined();
  expect(omitted.draft.clarifications).toEqual([expect.objectContaining({ field: 'budget' })]);
  const response = { ...f.response, unresolved: [{ field: 'budget', text: 'Бюджет обсудим отдельно', reason: 'ambiguous', day_ids: [] }] };
  const questioned = await parseInitialIntent({ ...f.context, userText: text, inputId: 'existing-budget-question' }, async () => response);
  if (questioned.status !== 'draft') throw Error('Expected partial draft');
  expect(questioned.draft.clarifications).toHaveLength(1);
});
