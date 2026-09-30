import { expect, it } from 'vitest';
import { parseInitialIntent } from './intent-start.js';
import { intentFixture } from './intent-start.fixture.js';
import { YandexIntentClient } from './yandex-intent.js';

function fixture(count = 1) {
  const f = intentFixture(count);
  f.context.catalog.rows.push(['300', 'Места', [], { type: 'general_rubric' }], ['901', 'Сельхозкорма', []]);
  const names = new Map(f.context.catalog.rows.map(row => [row[0], row[1]]));
  const wire = { schema_version: 'initial-intent.v1', action: 'new_request',
    date_anchor: f.response.date_anchor, shared_updates: f.response.shared_updates,
    days: f.response.days.map(d => ({ date: d.date, date_evidence: d.date_evidence, time_updates: d.time_updates,
      activities: d.activity_edits.map((a, index) => ({ label: a.label, evidence: a.evidence,
        selection: a.selection, requirements: a.requirements,
        categories: { state: 'matched', include_any: d.category_matches[index]!.include_any.map(id => names.get(id)!), exclude: [] as string[] } })),
      order: [{ before: 1, after: 2, evidence: 'музей, потом в кафе' }] })), unresolved: [] as { field: string; day_indices: number[]; text: string; reason: string }[] };
  return { ...f, wire };
}
function run(f: ReturnType<typeof fixture>, response = f.wire, inspect?: (body: any) => void) {
  const provider = new YandexIntentClient({ apiKey: 'synthetic-not-a-key', folderId: 'test-folder', maxCalls: 2, maxEstimatedRub: 16,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); inspect?.(body);
      const output = body.response_format.json_schema.name === 'initial_categories_v1'
        ? { schema_version: 'initial-categories.v1', matches: { group_1: response.days[0]!.activities[0]!.categories,
          group_2: response.days[0]!.activities[1]!.categories } }
        : { ...response, days: response.days.map(({ time_updates, ...day }) => ({ ...day,
          time: Object.fromEntries(['start', 'end', 'period', 'duration_minutes'].map(field => {
            const update = time_updates.find(t => t.field === field);
            return [field, update ? { value: update.value, evidence: update.evidence } : null];
          })), activities: day.activities.map(({ categories: _categories, ...activity }) => activity) })) };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
    } });
  return parseInitialIntent({ ...f.context, userText: f.text, inputId: 'wire-test' }, request => provider.generate(request));
}
it('retains the literal-quote repair instruction through the real adapter without weakening the guard', async () => {
  const f = fixture(); f.text += ' в Учебном городе';
  f.wire.unresolved = [{ field: 'locality', day_indices: [1], text: 'Учебный город', reason: 'ambiguous' }];
  let attempts = 0;
  await expect(run(f, f.wire, body => {
    if (++attempts === 2) expect(body.messages[0].content).toContain('Проверь особенно unresolved.text');
  })).rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE', diagnostic: { errors: ['UNSUPPORTED_EVIDENCE'] } });
  expect(attempts).toBe(2);
  attempts = 0;
  const repaired = await run(f, f.wire, () => {
    if (++attempts === 2) f.wire.unresolved[0]!.text = 'Учебном городе';
  });
  expect(repaired.status).toBe('draft');
  if (repaired.status === 'draft') expect(repaired.draft.clarifications?.[0]?.text).toBe('Учебном городе');
  expect(attempts).toBe(2);
});
it('assigns IDs on the server and resolves exact names from the complete regional catalog', async () => {
  const f = fixture();
  const result = await run(f, f.wire, body => {
    if (body.response_format.json_schema.name === 'initial_intent_v1') {
      expect(JSON.parse(body.messages[1].content)).not.toHaveProperty('catalog'); return;
    }
    expect(body.response_format.json_schema.name).toBe('initial_categories_v1');
    const names = body.response_format.json_schema.schema.$defs.catalogName.enum;
    expect(names).toContain('Сельхозкорма');
    expect(names).not.toContain('Места');
  });
  expect(result.status).toBe('draft'); if (result.status !== 'draft') return;
  expect(result.draft.days[0]!.activities.map(a => [a.id, a.label, a.categories.include_any])).toEqual([
    ['day-1-activity-1', 'музей', ['100']], ['day-1-activity-2', 'кафе', ['200']],
  ]);
  expect(result.draft.days[0]!.order).toEqual([['day-1-activity-1', 'day-1-activity-2']]);
});
it('keeps all days and the whole-trip budget with distinct server identifiers', async () => {
  const f = fixture(3), result = await run(f);
  expect(result.status).toBe('draft'); if (result.status !== 'draft') return;
  expect(result.draft.days.map(d => d.date)).toEqual(['2026-09-25', '2026-09-26', '2026-09-27']);
  expect(new Set(result.draft.days.flatMap(d => d.activities.map(a => a.id))).size).toBe(6);
  expect(result.draft.shared.budget).toEqual({ kind: 'limit', amount_rub: 5000, basis: 'whole_party', period: 'whole_trip' });
});
it('preserves a short time window and both activities without asking the model to judge feasibility', async () => {
  const f = fixture(); f.text = f.text.replace('до 19', 'до 16:20');
  for (const t of f.wire.days[0]!.time_updates) { t.evidence = 'с 16 до 16:20'; if (t.field === 'end') t.value = '16:20'; }
  const result = await run(f); expect(result.status).toBe('draft'); if (result.status !== 'draft') return;
  expect(result.draft.days[0]!.window).toEqual({ start: '16:00', end: '16:20' });
  expect(result.draft.days[0]!.activities).toHaveLength(2);
});
it('does not invent ordering when the request contains no sequence', async () => {
  const f = fixture(); f.text = f.text.replace('потом', 'и'); f.wire.days[0]!.order = [];
  const result = await run(f); expect(result.status).toBe('draft'); if (result.status === 'draft') expect(result.draft.days[0]!.order).toEqual([]);
});
it('preserves explicitly reversed order using day-local indexes', async () => {
  const f = fixture(); f.text = f.text.replace('музей, потом в кафе', 'кафе, потом в музей');
  f.wire.days[0]!.order = [{ before: 2, after: 1, evidence: 'кафе, потом в музей' }];
  const result = await run(f); expect(result.status).toBe('draft');
  if (result.status === 'draft') expect(result.draft.days[0]!.order).toEqual([['day-1-activity-2', 'day-1-activity-1']]);
});
it('retains every concrete rubric with the same exact name without selecting its parent section', async () => {
  const f = fixture(); f.context.catalog.rows.push(['201', 'Кафе', ['300']], ['202', 'Кафе', [], { type: 'general_rubric' }]);
  const result = await run(f); expect(result.status).toBe('draft');
  if (result.status === 'draft') expect(result.draft.days[0]!.activities[1]!.categories.include_any).toEqual(['200', '201']);
});
it.each(['invented', 'Места', '300'])('rejects an invalid/parent/name-as-ID selection: %s', async bad => {
  const f = fixture(); f.wire.days[0]!.activities[0]!.categories.include_any = [bad];
  await expect(run(f)).rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE' });
});
it.each([0, 3, 1.5])('rejects an out-of-range or non-integer order reference: %s', async bad => {
  const f = fixture(); f.wire.days[0]!.order[0]!.after = bad;
  await expect(run(f)).rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE' });
});
it('does not merge duplicate dates or let a new wire bypass downstream evidence checks', async () => {
  const duplicate = fixture(); duplicate.wire.days.push(structuredClone(duplicate.wire.days[0]!));
  await expect(run(duplicate)).rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE' });
  const fake = fixture(); fake.wire.days[0]!.activities[0]!.evidence = 'invented quotation';
  await expect(run(fake)).rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE' });
});
it('keeps a no-match activity for clarification instead of deleting it', async () => {
  const f = fixture(); f.wire.days[0]!.activities[1]!.categories = { state: 'no_match', include_any: [], exclude: [] };
  const result = await run(f); expect(result.status).toBe('draft');
  if (result.status === 'draft') expect(result.draft.days[0]!.activities[1]).toMatchObject({ label: 'кафе', categories: { state: 'no_match', include_any: [] } });
});

it.each([['погулять', 'поесть'], ['побродить', 'перекусить'], ['пройтись', 'поужинать'], ['прогуляться', 'пообедать']])(
  'resolves broad action clauses through the full catalog without a second paid mapping: %s → %s', async (walk, eat) => {
    const f = fixture(); f.text = `Завтра с 16 до 19 хочу ${walk}, потом ${eat}. Пешком.`;
    f.context.catalog.rows.push(['168', 'Парки', []], ['169', 'Парки', [], { type: 'general_rubric' }], ['777', 'Уличные тренажёры', []]);
    for (const [index, quote] of [walk, eat].entries()) {
      const a = f.wire.days[0]!.activities[index]!;
      a.label = index === 0 ? 'прогулка' : 'еда'; a.evidence = quote;
      a.selection = { category_policy: 'related_allowed', named_types: [], evidence: quote };
    }
    f.wire.days[0]!.order[0]!.evidence = `${walk}, потом ${eat}`;
    const requests: string[] = [];
    const result = await run(f, f.wire, body => { requests.push(body.response_format.json_schema.name); });
    expect(result.status).toBe('draft'); if (result.status !== 'draft') return;
    expect(result.draft.days[0]!.activities.map(a => a.categories.include_any)).toEqual([['168'], ['200']]);
    expect(result.draft.days[0]!.order).toEqual([['day-1-activity-1', 'day-1-activity-2']]);
    expect(requests).toEqual(['initial_intent_v1']);
  });
