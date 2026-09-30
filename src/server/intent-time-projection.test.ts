import { expect, it } from 'vitest';
import { parseInitialIntent } from './intent-start.js';
import { intentFixture } from './intent-start.fixture.js';

const time = (field: string, value: string, evidence: string) => ({ op: 'set', field, value, evidence });
function scenario(clause: string, updates: ReturnType<typeof time>[]) {
  const f = intentFixture();
  f.text = f.text.replace('с 16 до 19', clause);
  f.response.days[0]!.time_updates = updates;
  return f;
}

it.each([
  ['утром', 'morning', '09:00', '12:00'],
  ['днём', 'day', '13:00', '16:00'],
  ['вечером', 'evening', '17:00', '20:00'],
])('suggests three hours for %s without attributing the clocks to the user', async (clause, period, start, end) => {
  const f = scenario(clause, [time('period', period, clause)]);
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'period-default' }, async () => f.response);
  expect(result.status).toBe('draft'); if (result.status !== 'draft') return;
  expect(result.draft.days[0]!.window).toEqual({ start, end });
  expect(result.provenance['days.day-1.window.start']).toBe('suggested');
  expect(result.provenance['days.day-1.window.end']).toBe('suggested');
});

// Complete authored proposals exercise the real evidence guard and projection.
// The initial-extraction envelope additionally exercises the category-call gate.
it.each([
  ['after-midnight default', 'после 23:00', 'start', '23:00'],
  ['before-midnight default', 'до 01:00', 'end', '01:00'],
])('requires clarification instead of losing an explicit bound: %s', async (_label, clause, field, value) => {
  for (const extraction of [false, true]) {
    const f = scenario(clause, [time(field, value, clause)]);
    const before = structuredClone(f.response);
    let calls = 0;
    await expect(parseInitialIntent({ ...f.context, userText: f.text, inputId: 'time-projection' }, async () => {
      calls++;
      return extraction && calls === 1 ? { kind: 'initial_extraction_v1', proposal: f.response } : f.response;
    })).rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION', diagnostic: {
      status: 'needs_clarification', errors: [], reasons: ['TIME_WINDOW_UNREPRESENTABLE', 'MIDNIGHT_CROSSING'],
    } });
    expect(calls).toBe(1);
    expect(f.response).toEqual(before);
  }
});

it('retains an explicit start when the ordinary suggested end is representable', async () => {
  const f = scenario('после 18:00', [time('start', '18:00', 'после 18:00')]);
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'time-projection' }, async () => f.response);
  expect(result.status).toBe('draft'); if (result.status !== 'draft') return;
  expect(result.draft.days[0]!.window).toEqual({ start: '18:00', end: '21:00' });
  expect(result.provenance['days.day-1.window.start']).toBe('user');
  expect(result.provenance['days.day-1.window.end']).toBe('suggested');
  expect(result.draft.days[0]!.duration_constraint_minutes).toBeUndefined();
});

it('keeps an underspecified-time draft available for ordinary form entry', async () => {
  const f = scenario('', []);
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'time-projection' }, async () => f.response);
  expect(result.status).toBe('draft'); if (result.status !== 'draft') return;
  expect(result.draft.days[0]!.window).toBeUndefined();
  expect(result.draft.days[0]!.activities).toHaveLength(2);
});

it('retains both literal bounds of a short window for later feasibility checks', async () => {
  const clause = 'с 16:00 до 16:20';
  const f = scenario(clause, [time('start', '16:00', clause), time('end', '16:20', clause)]);
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'time-projection' }, async () => f.response);
  expect(result.status).toBe('draft'); if (result.status !== 'draft') return;
  expect(result.draft.days[0]!.window).toEqual({ start: '16:00', end: '16:20' });
  expect(result.draft.days[0]!.activities).toHaveLength(2);
});

it('does not relabel invalid provider clocks as a projection limitation', async () => {
  const f = scenario('после 23:00', [time('start', '25:00', 'после 23:00')]);
  await expect(parseInitialIntent({ ...f.context, userText: f.text, inputId: 'time-projection' }, async () => f.response))
    .rejects.toMatchObject({ code: 'INTENT_INVALID_RESPONSE', diagnostic: { errors: ['SCHEMA'], reasons: [] } });
});
