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
  await expect(parseInitialIntent({ ...f.context, userText: f.text, inputId: 'invalid' }, async () => f.response))
    .rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE' });
  expect(new InitialIntentError('test')).toBeInstanceOf(Error);
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
