import { expect, it } from 'vitest';
import { projectCandidatePreview } from './candidate-preview.js';
import { PublicPlan } from '../shared/planning-form.js';
import { PlanningSessions } from './planning-sessions.js';
import { planningFixture, demoNow } from './place-planning.fixture.js';
import { formatChatPlanMessages } from './max-chat.js';
import { resultValidUntil } from '../client/result-freshness.js';

function canonicalJob() {
  const place = (id: string) => ({ id, name: `Место ${id}`, location_label: 'Учебный адрес',
    provider_secret: 'must-not-leak', price: { upper_minor: 1234 },
    source: { provider: '2gis', url: `https://2gis.ru/moscow/firm/${id}`, fetched_at: '2026-09-24T09:30:00Z',
      valid_until: '2026-09-24T09:45:00Z', data_mode: 'test' } });
  return { places: [place('1'), place('2'), place('3')], candidate_pool: [
    { day_id: 'd1', activity_id: 'culture', place_id: '1' },
    { day_id: 'd1', activity_id: 'food', place_id: '2' },
    { day_id: 'd1', activity_id: 'food', place_id: '2' },
  ] };
}

it('projects only selected, fresh own-operation candidates without raw fields or route promises', () => {
  const job = canonicalJob();
  const result = projectCandidatePreview(job, demoNow());
  expect(result.candidate_preview?.groups.map(g => g.places.map(p => p.place_id))).toEqual([['1'], ['2']]);
  expect(JSON.stringify(result)).not.toMatch(/must-not-leak|price|starts_at|travel_before/);
  expect(result.valid_until).toBe('2026-09-24T09:35:00.000Z');
  expect(projectCandidatePreview(job, new Date('2026-09-24T09:35:00Z'))).toEqual({});
  expect(projectCandidatePreview(undefined, demoNow())).toEqual({});
  expect(projectCandidatePreview({ ...job, candidate_pool: [] }, demoNow())).toEqual({});
});

it('drops invalid or future observations and removes untrusted provider links', () => {
  const job = canonicalJob();
  job.places[0]!.source.url = 'https://2gis.ru.evil.example/moscow/firm/1';
  job.places[1]!.source.fetched_at = '2026-09-24T10:00:00Z';
  const result = projectCandidatePreview(job, demoNow());
  expect(result.candidate_preview!.groups).toHaveLength(1);
  expect(result.candidate_preview!.groups[0]!.places[0]!.source.url).toBeNull();
  job.places[0]!.source.fetched_at = 'invalid';
  expect(projectCandidatePreview(job, demoNow())).toEqual({});
});

it('only adds valid coordinates to candidate map markers', () => {
  const job = canonicalJob();
  Object.assign(job.places[0]!, { point: { lat: 56.32, lon: 44 } });
  Object.assign(job.places[1]!, { point: { lat: 190, lon: 44 } });
  const preview = projectCandidatePreview(job, demoNow()).candidate_preview!;
  expect(preview.groups[0]!.places[0]!.point).toEqual({ lat: 56.32, lon: 44 });
  expect(preview.groups[1]!.places[0]!.point).toBeUndefined();
});

it('survives public result and checkpoint boundaries, then presents unverified choices in chat', async () => {
  const f = planningFixture(), raw = { status: 'ERROR', issues: ['ROUTING_PROVIDER_UNAVAILABLE'], warnings: [], days: [],
    ...projectCandidatePreview(canonicalJob(), demoNow()) };
  const result = PublicPlan.parse(raw);
  const sessions = new PlanningSessions({ now: demoNow, plan: async () => result });
  const created = sessions.create('owner', f.input.intent, { catalog: f.input.catalog, visit_policy: f.input.visit_policy,
    data_mode: 'test', modes: ['walking'] });
  const confirmed = sessions.confirm('owner', created.id, { base_version: created.version, event_id: 'confirm-preview' });
  const planned = await sessions.calculate('owner', created.id, { base_version: confirmed.version, event_id: 'calculate-preview' });
  const restarted = new PlanningSessions({ now: demoNow, checkpoint: sessions.checkpoint(), plan: async () => { throw Error('Must not recalculate'); } });
  const restored = restarted.get('owner', created.id);
  expect(restored.result).toEqual(planned.result); expect(restored.result!.days).toEqual([]);
  const messages = formatChatPlanMessages(restored), text = messages.map(message => message.text).join('\n');
  expect(text).toContain('Место 1'); expect(text).toContain('Место 2');
  expect(text).toContain('https://2gis.ru/moscow/firm/1');
  expect(text).toContain('Время дороги уточните в 2ГИС'); expect(text).toContain('учебные');
  expect(text).not.toMatch(/В пути \d|Ожидаемые расходы|План помещается/);
  expect(messages.every(message => message.text.length <= 4000)).toBe(true);
  expect(resultValidUntil(restored)).toBe('2026-09-24T09:35:00.000Z');
  delete restored.result!.valid_until;
  restored.result!.candidate_preview!.groups[0]!.places[0]!.source.valid_until = '2026-09-24T09:31:00Z';
  expect(resultValidUntil(restored)).toBe('2026-09-24T09:31:00.000Z');
});
