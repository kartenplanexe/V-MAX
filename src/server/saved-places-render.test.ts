import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanResult } from '../client/PlanResult';
import type { PlanningView } from '../shared/planning-form';
import { planningFixture, demoNow } from './place-planning.fixture';
import { PlanningSessions } from './planning-sessions';

it('keeps saved places visible across the thirty-minute warning boundary without renewing facts', async () => {
  const f = planningFixture(), observed = demoNow().toISOString();
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => ({ status: 'PLACES_FOUND', days: [], warnings: [],
    valid_until: new Date(+demoNow() + 300000).toISOString(), candidate_preview: { groups: [{ day_id: f.input.intent.days[0]!.day_id,
      activity_id: 'culture', places: [{ place_id: '1', name: 'Сохранённый музей', location_label: null,
        source: { provider: '2gis', url: null, fetched_at: observed, valid_until: new Date(+demoNow() + 300000).toISOString(), data_mode: 'test' } }] }] } }) });
  const created = sessions.create('owner', f.input.intent, { catalog: f.input.catalog, visit_policy: f.input.visit_policy, data_mode: 'test', modes: ['walking'] });
  const confirmed = sessions.confirm('owner', created.id, { base_version: 0, event_id: 'confirm-retained' });
  const view = await sessions.calculate('owner', created.id, { base_version: confirmed.version, event_id: 'calculate-retained' });
  const render = (value: PlanningView) => renderToStaticMarkup(createElement(PlanResult, { view: value, mapsAvailable: false, busy: false,
    edit() {}, editSearch() {}, retry() {}, replace() {}, share() {}, chooseEvent() {}, warningText: code => code, humanError: code => code }));
  const clock = vi.spyOn(Date, 'now');
  try {
    clock.mockReturnValue(+demoNow() + 30 * 60000 - 1);
    expect(render(view)).not.toContain('подборке больше 30 минут');
    clock.mockReturnValue(+demoNow() + 30 * 60000);
    const restarted = new PlanningSessions({ now: () => new Date(Date.now()), checkpoint: sessions.checkpoint(),
      plan: async () => { throw Error('NO_RECALC'); } });
    const reopened = restarted.get('owner', view.id), html = render(reopened);
    expect(html).toContain('Места найдены больше 30 минут назад');
    expect(html).toContain('Сохранённый музей');
    expect(html).toContain('Обновить места');
    expect(reopened.result).toEqual(view.result);
  } finally { clock.mockRestore(); }
});
