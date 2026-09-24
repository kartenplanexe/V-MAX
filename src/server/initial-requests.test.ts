import { expect, it } from 'vitest';
import { InitialRequests } from './initial-requests.js';
import { PlanningSessions } from './planning-sessions.js';
import { intentFixture } from './intent-start.fixture.js';
import { demoNow, planningFixture } from './place-planning.fixture.js';

function setup(provider: () => Promise<unknown>) {
  const f = intentFixture(), seed = planningFixture();
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => { throw Error('not expected'); } });
  const initial = new InitialRequests({ sessions, now: demoNow, provider,
    context: () => ({ ...f.context, planning: { catalog: seed.input.catalog, visit_policy: seed.input.visit_policy, modes: ['walking'], data_mode: 'test' } }) });
  return { initial, sessions, f };
}
it('deduplicates an in-flight initial request, isolates owners and does not repeat a failed provider call', async () => {
  let calls = 0;
  let release!: (value: unknown) => void;
  const { initial, f } = setup(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const body = { event_id: 'event-one', user_text: f.text };
  const first = initial.start('owner-a', body), second = initial.start('owner-a', body);
  await Promise.resolve(); await Promise.resolve();
  release(f.response);
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b); expect(calls).toBe(1);
  await expect(initial.start('owner-a', { ...body, user_text: 'other' })).rejects.toMatchObject({ code: 'EVENT_CONFLICT' });
  const failing = setup(async () => { throw Error('secret upstream error'); });
  for (let i = 0; i < 2; i++) await expect(failing.initial.start('owner-b', body)).rejects.toMatchObject({ code: 'INTENT_PROVIDER_FAILED' });
});
it('requires typed fields and explicit confirmation after extraction; unknown budget cannot be confirmed', async () => {
  const f = intentFixture();
  f.response.shared_updates.push({ op: 'set', field: 'budget', value: { kind: 'limit', amount_rub: 5000, basis: 'unknown', period: 'unknown' }, evidence: '5000' });
  const { initial, sessions } = setup(async () => f.response);
  const result = await initial.start('owner-a', { event_id: 'event-two', user_text: f.text + ' 5000' });
  expect(result.status).toBe('draft'); if (result.status !== 'draft') return;
  expect(result.view.phase).toBe('DRAFT'); expect(result.view.confirmed_version).toBeNull();
  expect(result.view.issues.map(i => i.code)).toContain('BUDGET_SCOPE_REQUIRED');
  expect(() => sessions.confirm('owner-a', result.view.id, { base_version: 0, event_id: 'confirmation' })).toThrow('INCOMPLETE_DRAFT');
  expect(() => sessions.get('owner-b', result.view.id)).toThrow('DRAFT_NOT_FOUND');
});
