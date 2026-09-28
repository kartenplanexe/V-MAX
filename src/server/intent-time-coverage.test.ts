import { expect, it } from 'vitest';
import { inspectTimeLiteralCoverage } from './intent/time-literal-coverage.mjs';
import { parseInitialIntent } from './intent-start.js';
import { intentFixture } from './intent-start.fixture.js';

const time = (field: string, value: string, evidence: string) => ({ op: 'set', field, value, evidence });
const proposal = (updates: unknown[]) => ({ action: 'new_request', days: [{ time_updates: updates }] });

it.each(['Завтра с 16:00 до 16:20 погулять', 'Время с 9 до 11', 'Можно после 18', 'Свободен до 20 часов',
  'Гулять в 8 часов', 'Время 10:00–12:00', 'Прогулка после 18.', 'После 18, потом поесть'])('detects numeric clock omissions without supplying a window: %s', text => {
  const p = proposal([]), before = structuredClone(p);
  expect(inspectTimeLiteralCoverage(p, text).errors).toEqual(['TIME_LITERAL_MISSING']);
  expect(p).toEqual(before);
});
it.each(['хочу погулять', '28.09 музей', '12.10.2026 музей', 'Бюджет до 20 рублей', 'с 2 детьми',
  'Ребёнку 8 лет', 'Группа от 10 до 12 человек', 'дом 16 корпус 20', 'Пройти 10–12 километров', 'Поездка с 9 до 11.10', 'После 12.10.2026',
  'Бюджет с 5 до 10 тысяч рублей', 'Бюджет с 10 до 20 €', 'Погулять 1–2 часа'])
('does not invent clock mentions in other numbers: %s', text => {
  expect(inspectTimeLiteralCoverage(proposal([]), text).errors).toEqual([]);
});
it('requires each bound value, not merely a quotation containing both numbers', () => {
  const text = 'С 16:00 до 16:20';
  expect(inspectTimeLiteralCoverage(proposal([time('start', '16:00', text)]), text).errors).toEqual(['TIME_LITERAL_MISSING']);
  expect(inspectTimeLiteralCoverage(proposal([time('start', '16:00', text), time('end', '16:20', text)]), text).errors).toEqual([]);
});
it('checks numeric values and their own evidence without treating date/requirement quotes as a window', () => {
  const text = 'С 16:00 до 17:00';
  expect(inspectTimeLiteralCoverage(proposal([time('start', '16:00', '16:00'), time('end', '19:00', text)]), text).errors).toEqual(['TIME_LITERAL_MISSING']);
  expect(inspectTimeLiteralCoverage(proposal([time('start', '16:00', '17:00'), time('end', '17:00', '17:00')]), text).errors).toEqual(['TIME_LITERAL_MISSING']);
});
it('never turns a busy interval into an available interval', () => {
  const text = 'С 16:00 до 18:00 работаю, гулять после 18:00';
  const p = proposal([time('start', '18:00', 'после 18:00')]);
  expect(inspectTimeLiteralCoverage(p, text).errors).toEqual(['TIME_LITERAL_MISSING']);
  expect(p.days[0]!.time_updates).toHaveLength(1);
});
it.each(['после 6 вечера', 'вечером после 6', 'с 6 до 8 вечера', 'с 6:00 до 8:00 вечера'])
('does not reject valid 12-hour normalization outside literal-only coverage: %s', text => {
  const p = proposal([time('start', '18:00', text), time('end', '20:00', text)]);
  expect(inspectTimeLiteralCoverage(p, text).errors).toEqual([]);
});
it('repairs missing times before any category mapping, and revalidates the corrected draft', async () => {
  const f = intentFixture();
  const missing = structuredClone(f.response); missing.days[0]!.time_updates = [];
  let calls = 0;
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'time-repair' }, async () => ++calls === 1 ? missing : f.response);
  expect(calls).toBe(2); expect(result.status).toBe('draft');
  if (result.status === 'draft') expect(result.draft.days[0]!.window).toEqual({ start: '16:00', end: '19:00' });
});
it('rejects repeated missing time within the two-call limit', async () => {
  const f = intentFixture(); f.response.days[0]!.time_updates.pop(); let calls = 0;
  await expect(parseInitialIntent({ ...f.context, userText: f.text, inputId: 'time-reject' }, async () => { calls++; return f.response; }))
    .rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION', diagnostic: { errors: ['TIME_LITERAL_MISSING'] } });
  expect(calls).toBe(2);
});
it('maps a generic activity after a corrected extraction without a third provider call', async () => {
  const f = intentFixture(); f.text = 'Завтра с 16 до 19 хочу погулять';
  f.response.shared_updates = [];
  f.context.catalog.rows = [['168', 'Парки', []]];
  const day = f.response.days[0]!;
  day.activity_edits = [{ op: 'add', activity_id: 'new:1', label: 'прогулка', evidence: 'погулять',
    selection: { category_policy: 'related_allowed', named_types: [], evidence: 'погулять' }, requirements: [] }];
  day.category_matches = [{ activity_id: 'new:1', state: 'no_match', include_any: [], exclude: [], evidence: 'погулять' }];
  day.order_changes = [];
  const missing = structuredClone(f.response); missing.days[0]!.time_updates = []; let calls = 0;
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'generic-time-repair' }, async () => ({
    kind: 'initial_extraction_v1', proposal: ++calls === 1 ? missing : f.response,
  }));
  expect(calls).toBe(2); expect(result.status).toBe('draft');
  if (result.status === 'draft') {
    expect(result.draft.days[0]!.window).toEqual({ start: '16:00', end: '19:00' });
    expect(result.draft.days[0]!.activities[0]!.categories.include_any).toEqual(['168']);
  }
});
it('keeps specific activities for typed selection after time repair without an extra paid mapping call', async () => {
  const f = intentFixture();
  for (const match of f.response.days[0]!.category_matches) { match.state = 'no_match'; match.include_any = []; }
  const missing = structuredClone(f.response); missing.days[0]!.time_updates = []; let calls = 0;
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'specific-time-repair' }, async () => ({
    kind: 'initial_extraction_v1', proposal: ++calls === 1 ? missing : f.response,
  }));
  expect(calls).toBe(2);
  expect(result.status).toBe('draft'); if (result.status !== 'draft') throw Error('Expected partial draft');
  expect(result.draft.days[0]!.activities.map(a => [a.label, a.categories.state])).toEqual([['музей', 'no_match'], ['кафе', 'no_match']]);
  expect(result.draft.days[0]!.window).toEqual({ start: '16:00', end: '19:00' });
});
