import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CandidatePlaces } from '../client/CandidatePlaces.js';
import { dgisDayDirectionsLink } from '../shared/dgis-links.js';
import { PlanningSessions } from './planning-sessions.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';

function fixture() {
  const f = planningFixture();
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => { throw Error('NO_RECALC'); } });
  const view = sessions.create('synthetic', f.input.intent, { catalog: f.input.catalog,
    visit_policy: f.input.visit_policy, data_mode: 'test', modes: ['walking'] });
  const first = view.draft.days[0]!;
  view.draft.days.push({ ...first, day_id: 'other-day', date: '2026-10-01' });
  const place = (id: string, lon: number) => ({ place_id: id, name: `Учебное место ${id}`, location_label: null,
    point: { lon, lat: 56.32 }, source: { provider: '2gis' as const, url: null, data_mode: 'test' as const,
      fetched_at: demoNow().toISOString(), valid_until: new Date(+demoNow() + 300000).toISOString() } });
  view.draft.points.origin = { locality_id: view.draft.locality.id, lon: 44, lat: 56.33 };
  view.draft.points.destination = { locality_id: view.draft.locality.id, lon: 44.2, lat: 56.33 };
  view.result = { status: 'PLACES_FOUND', warnings: [], days: [], selection_policy: 'external-compact.v4', candidate_preview: { groups: [
    { day_id: first.day_id, activity_id: first.activities[0]!.id, places: [place('a', 44.01), place('b', 44.02)] },
    { day_id: 'other-day', activity_id: first.activities[0]!.id, places: [place('other', 45)] },
    { day_id: first.day_id, activity_id: first.activities[1]!.id, places: [place('meal', 44.03)] },
  ] } };
  return view;
}

it('renders one whole-day action without MapGL and includes all its stops, origin and finish', () => {
  const view = fixture();
  const link = dgisDayDirectionsLink(view, view.draft.days[0]!.day_id);
  expect(link).toBe('https://2gis.ru/directions/tab/pedestrian/points/44,56.33|44.01,56.32|44.02,56.32|44.03,56.32|44.2,56.33');
  const html = renderToStaticMarkup(createElement(CandidatePlaces, { view, mapsAvailable: false }));
  expect(html).toContain(`class="all-stops-link" href="${link}"`);
  expect(html).toContain('Посмотреть на карте ↗');
  expect(html).toContain('Перейти в 2ГИС ↗');
  expect(html).not.toContain('45,56.32');
  expect(dgisDayDirectionsLink(view, 'other-day')).toBe('https://2gis.ru/directions/tab/pedestrian/points/44,56.33|45,56.32|44.2,56.33');
  expect(dgisDayDirectionsLink(view, 'missing-day')).toBeNull();
});

it('keeps individual links and explains why an incomplete compact day cannot be opened whole', () => {
  const view = fixture();
  delete view.result!.candidate_preview!.groups[0]!.places[1]!.point;
  expect(dgisDayDirectionsLink(view, view.draft.days[0]!.day_id)).toBeNull();
  const html = renderToStaticMarkup(createElement(CandidatePlaces, { view }));
  expect(html).not.toContain('class="all-stops-link"');
  expect(html).toContain('Для этого дня нет общего маршрута в 2ГИС');
  expect(html).toContain('Перейти в 2ГИС ↗');
});

it('never presents old alternative previews as an ordered selected route', () => {
  const view = fixture(); delete view.result!.selection_policy;
  expect(dgisDayDirectionsLink(view, view.draft.days[0]!.day_id)).toBeNull();
  expect(renderToStaticMarkup(createElement(CandidatePlaces, { view }))).not.toContain('class="all-stops-link"');
});
