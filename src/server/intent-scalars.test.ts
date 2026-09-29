import { expect, it } from 'vitest';
import { intentFixture } from './intent-start.fixture.js';
import { parseInitialIntent } from './intent-start.js';
import { reviewBudgetAssertion } from './budget-assertion.js';

it('does not trust a larger numeric budget in a schema-valid LLM response', async () => {
  const f = intentFixture(); const quote = 'Бюджет на всех на день 1000 рублей';
  f.response.shared_updates.push({ op: 'set', field: 'budget', value: { kind: 'limit', amount_rub: 10000,
    basis: 'whole_party', period: 'per_day' }, evidence: quote });
  const result = await parseInitialIntent({ ...f.context, userText: `${f.text} ${quote}.`, inputId: 'wrong-money' }, async () => f.response);
  expect(result.status).toBe('draft');
  if (result.status === 'draft') {
    expect(result.draft.shared.budget).toBeUndefined();
    expect(result.draft.clarifications?.some(q => q.field === 'budget')).toBe(true);
    expect(result.draft.days[0]?.activities).toHaveLength(2);
  }
});
it('binds a relative date to the user evidence instead of trusting a valid but wrong day count', async () => {
  const f = intentFixture(); f.response.date_anchor.value.days = 5;
  const result = await parseInitialIntent({ ...f.context, userText: f.text, inputId: 'wrong-date' }, async () => f.response);
  expect(result.status === 'draft' && result.draft.days[0]?.date).toBe('2026-09-25');
});
it('does not turn a work interval into available time, keeping other intentions', async () => {
  const f = intentFixture();
  const result = await parseInitialIntent({ ...f.context, userText: f.text.replace('Завтра с 16 до 19', 'Завтра работаю с 16 до 19,'), inputId: 'busy-time' }, async () => f.response);
  expect(result.status).toBe('draft');
  if (result.status === 'draft') {
    expect(result.draft.days[0]?.window).toBeUndefined();
    expect(result.draft.clarifications?.some(q => q.field === 'time')).toBe(true);
    expect(result.draft.days[0]?.activities).toHaveLength(2);
  }
});
it.each([['1 000 рублей', 1000], ['1,5 тыс. рублей', 1500], ['1000 ₽', 1000]])('preserves correctly evidenced amounts %s', (quote, amount) => {
  expect(reviewBudgetAssertion({ userText: quote, evidence: quote, budgetKind: 'limit', amountRub: amount, hasBudgetQuestion: false }).discardBudget).toBe(false);
});
