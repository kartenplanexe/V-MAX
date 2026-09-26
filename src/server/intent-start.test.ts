import { expect, it } from 'vitest';
import { parseInitialIntent, InitialIntentError } from './intent-start.js';
import { intentFixture } from './intent-start.fixture.js';

it('turns one three-day proposal into editable days, preserving the whole-trip budget and order', async () => {
  const f = intentFixture(3);
  let calls = 0;
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'start-test' }, async () => { calls++; return f.response; });
  expect(calls).toBe(1);
  expect(result.status).toBe('draft');
  if (result.status !== 'draft') return;
  expect(result.draft.days.map(d => d.date)).toEqual(['2026-09-25', '2026-09-26', '2026-09-27']);
  expect(result.draft.days.every(d => d.window?.start === '16:00' && d.window.end === '19:00')).toBe(true);
  expect(result.draft.shared.budget).toEqual({ kind: 'limit', amount_rub: 5000, basis: 'whole_party', period: 'whole_trip' });
  expect(result.draft.days.every(d => d.order.length === 1)).toBe(true);
  expect(new Set(result.draft.days.flatMap(d => d.activities.map(a => a.id))).size).toBe(6);
  expect(result.draft.points).toEqual({});
});

it('only prefilters exact small talk; a greeting plus a request still reaches the parser', async () => {
  const f = intentFixture(); let calls = 0;
  const provider = async () => { calls++; return f.response; };
  expect((await parseInitialIntent({ ...f.context, userText: 'Как дела?', inputId: 'greeting' }, provider)).status).toBe('off_topic');
  expect(calls).toBe(0);
  expect((await parseInitialIntent({ ...f.context, userText: 'Привет! ' + f.text, inputId: 'request' }, provider)).status).toBe('draft');
  expect(calls).toBe(1);
});

it('rejects invented categories and never converts a malformed model response to a plan', async () => {
  const f = intentFixture(); f.response.days[0]!.category_matches[0]!.include_any = ['invented'];
  let calls = 0;
  await expect(parseInitialIntent({ ...f.context, userText: f.text, inputId: 'invalid' }, async () => { calls++; return f.response; }))
    .rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE' });
  expect(calls).toBe(2);
  expect(new InitialIntentError('test')).toBeInstanceOf(Error);
});

it('makes at most one paid correction attempt for invalid catalog IDs and date offsets', async () => {
  const f = intentFixture();
  f.context.catalog.rows.push(['300', 'Места', [], { type: 'general_rubric' }],
    ['301', 'Интересные здания', ['300']]);
  const invalid = structuredClone(f.response);
  invalid.days[0]!.category_matches[0]!.include_any = ['300'];
  invalid.date_anchor = null as unknown as typeof invalid.date_anchor;
  invalid.days[0]!.date.days = 1;
  const requests: Record<string, unknown>[] = [];
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'repair' }, async request => {
    requests.push(request);
    return requests.length === 1 ? invalid : f.response;
  });
  expect(result.status).toBe('draft');
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain('CATEGORY_ID');
  expect(JSON.stringify(requests[1])).toContain('Интересные здания');
});

it('removes a redundant single-day anchor before repairing invalid category IDs', async () => {
  const f = intentFixture();
  const invalid = structuredClone(f.response);
  invalid.days[0]!.date = { kind: 'relative', days: 1 };
  invalid.days[0]!.date_evidence = 'Завтра';
  invalid.days[0]!.category_matches[0]!.include_any = ['not-in-catalog'];
  const requests: Record<string, unknown>[] = [];
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'combined-repair' }, async request => {
    requests.push(request);
    return requests.length === 1 ? invalid : f.response;
  });
  expect(result.status).toBe('draft');
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain('CATEGORY_ID');
});

it('accepts an explicit tomorrow even if the model repeats it as a one-day offset', async () => {
  for (const anchor of [null, { value: { kind: 'relative', days: 1 }, evidence: 'Завтра' }]) {
    const f = intentFixture();
    f.response.date_anchor = anchor as typeof f.response.date_anchor;
    f.response.days[0]!.date.days = 1;
    let calls = 0;
    const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'tomorrow-offset' }, async () => {
      calls++; return f.response;
    });
    expect(result.status).toBe('draft');
    if (result.status === 'draft') expect(result.draft.days[0]!.date).toBe('2026-09-25');
    expect(calls).toBe(1);
  }
});

it('builds a draft for the exact simple walking request after a wrong model date offset', async () => {
  const f = intentFixture();
  const userText = 'Хочу погулять завтра в Нижнем Новгороде после 16';
  f.context.locality.name = 'Нижний Новгород';
  f.context.catalog.rows = [['168', 'Парки', []]];
  f.response.date_anchor = null as unknown as typeof f.response.date_anchor;
  f.response.days[0]!.date.days = 1;
  f.response.days[0]!.time_updates = [{ op: 'set', field: 'start', value: '16:00', evidence: 'после 16' }];
  f.response.days[0]!.activity_edits = [{ op: 'add', activity_id: 'new:1', label: 'прогулка',
    selection: { category_policy: 'related_allowed', named_types: [], evidence: 'погулять' },
    requirements: [], evidence: 'погулять' }];
  f.response.days[0]!.category_matches = [{ activity_id: 'new:1', state: 'matched',
    include_any: ['168'], exclude: [], evidence: 'погулять' }];
  f.response.days[0]!.order_changes = [];
  f.response.shared_updates = [];
  const result = await parseInitialIntent({ ...f.context, userText, inputId: 'literal-walk' }, async () => f.response);
  expect(result.status).toBe('draft');
  if (result.status !== 'draft') return;
  expect(result.draft.days[0]!.date).toBe('2026-09-25');
  expect(result.draft.shared.mobility).toEqual(['walking']);
  expect(result.draft.days[0]!.activities[0]!.label).toBe('прогулка');
});

it('does not collapse an explicitly multi-day request into tomorrow', async () => {
  const f = intentFixture();
  f.response.date_anchor = null as unknown as typeof f.response.date_anchor;
  f.response.days[0]!.date.days = 1;
  await expect(parseInitialIntent({ ...f.context, userText: f.text + ' На 3 дня.', inputId: 'multi-day' },
    async () => f.response)).rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE' });
});

it('does not interpret «после завтра» as the single explicit tomorrow', async () => {
  const f = intentFixture();
  f.response.date_anchor = null as unknown as typeof f.response.date_anchor;
  f.response.days[0]!.date.days = 1;
  await expect(parseInitialIntent({ ...f.context, userText: 'Хочу погулять после завтра в Нижнем Новгороде после 16', inputId: 'after-tomorrow' },
    async () => f.response)).rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE' });
});

it('marks server-suggested evening separately and preserves unknown budget units for the form', async () => {
  const f = intentFixture();
  f.response.days[0]!.time_updates = [{ op: 'set', field: 'period', value: 'evening', evidence: 'вечером' }];
  f.response.shared_updates = [{ op: 'set', field: 'budget', value: { kind: 'limit', amount_rub: 5000, basis: 'unknown', period: 'unknown' }, evidence: '5000' }];
  const result = await parseInitialIntent({ ...f.context, userText: f.text + ' вечером 5000', inputId: 'defaults' }, async () => f.response);
  expect(result.status).toBe('draft'); if (result.status !== 'draft') return;
  expect(result.draft.days[0]!.window).toEqual({ start: '18:00', end: '20:00' });
  expect(result.provenance['days.day-1.window.start']).toBe('suggested');
  expect(result.draft.shared.budget).toMatchObject({ basis: 'unknown', period: 'unknown' });
});

it('does not reinterpret a different requested city as the trusted city', async () => {
  const f = intentFixture();
  f.response.shared_updates.push({ op: 'set', field: 'locality_text', value: 'Казань', evidence: 'Казань' });
  await expect(parseInitialIntent({ ...f.context, userText: f.text + ' Казань', inputId: 'city' }, async () => f.response))
    .rejects.toMatchObject({ code: 'LOCALITY_RESOLUTION_REQUIRED' });
});

it('accepts an explicitly repeated trusted city without discarding the regional catalog', async () => {
  const f = intentFixture();
  f.context.locality.name = 'Москва';
  f.response.shared_updates.push({ op: 'set', field: 'locality_text', value: 'Москва', evidence: 'Москва' });
  const result = await parseInitialIntent({ ...f.context, userText: 'Москва. ' + f.text, inputId: 'same-city' }, async () => f.response);
  expect(result.status).toBe('draft');
});

it('infers walking for an outing but never overrides an explicit transport mode', async () => {
  const f = intentFixture();
  f.response.shared_updates = [];
  const walk = await parseInitialIntent({ ...f.context, userText: 'Завтра с 16 до 19 хочу в музей, потом в кафе. Хочу погулять.', inputId: 'walk' }, async () => f.response);
  expect(walk.status).toBe('draft');
  if (walk.status === 'draft') {
    expect(walk.draft.shared.mobility).toEqual(['walking']);
    expect(walk.provenance['shared.mobility']).toBe('inferred_walk');
  }
  const car = await parseInitialIntent({ ...f.context, userText: 'Завтра с 16 до 19 хочу в музей, потом в кафе. Хочу погулять, поеду на машине.', inputId: 'car' }, async () => f.response);
  expect(car.status).toBe('draft');
  if (car.status === 'draft') expect(car.draft.shared.mobility).toBeUndefined();
});
