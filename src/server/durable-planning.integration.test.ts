import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { PlanningDatabase } from './planning-database.js';
import { DurablePlanning } from './durable-planning.js';
import { intentFixture } from './intent-start.fixture.js';
import { planningFixture } from './place-planning.fixture.js';
import { planPlacesWithDgis } from './place-planning.js';

it.skipIf(!process.env.TEST_DATABASE_URL)('resumes on another instance, uses one parser call and real Python after typed edits', async () => {
  const db = PlanningDatabase.connect(process.env.TEST_DATABASE_URL!), owner = 'integration:' + randomUUID();
  await db.migrate();
  const intent = intentFixture(), places = planningFixture(); let calls = 0;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  places.items.forEach(item => { for (const key of ['Mon', 'Tue', 'Wed', 'Thu', 'Sat', 'Sun']) Object.assign(item.schedule, { [key]: item.schedule.Fri }); });
  const options = { database: db,
    context: async () => ({ ...intent.context, planning: { catalog: places.input.catalog, visit_policy: places.input.visit_policy,
      point_area: { south: 55, north: 56, west: 37, east: 38 }, modes: ['walking'] as const, data_mode: 'test' as const } }),
    provider: async () => { calls++; return intent.response; },
    plan: (job: Record<string, unknown>) => planPlacesWithDgis(places.client(), job, { retrieval: { radiusMeters: 5000 }, dataMode: 'test' }),
  };
  try {
    const first = new DurablePlanning(options), body = { event_id: randomUUID(), user_text: intent.text, locality_token: 'synthetic-evidence' };
    const created = await first.start(owner, body);
    expect(created.status).toBe('draft'); if (created.status !== 'draft') throw new Error('No draft');
    const other = new DurablePlanning({ ...options, provider: async () => { throw new Error('Unexpected duplicate model call'); } });
    const repeated = await other.start(owner, body);
    expect(repeated).toEqual(created); expect(calls).toBe(1);
    const edited = await other.edit(owner, created.view.id, { base_version: 0, event_id: randomUUID(), changes: [
      { op: 'point', field: 'origin', point: { lat: 55.75, lon: 37.62, label: 'Start', source: 'user_map' } },
      { op: 'date', day_id: 'day-1', date: tomorrow },
    ] });
    const confirmed = await first.confirm(owner, edited.id, { base_version: edited.version, event_id: randomUUID() });
    const event = { base_version: confirmed.version, event_id: randomUUID() };
    const result = await other.calculate(owner, edited.id, event);
    expect(result.result?.status).toBe('AVAILABLE');
    expect(result.result?.days[0]?.visits.map(v => v.name)).toEqual(['Учебный музей', 'Учебное кафе']);
    expect((await first.get(owner, edited.id)).result).toEqual(result.result);
    expect((await first.calculate(owner, edited.id, event)).result).toEqual(result.result);
    expect(calls).toBe(1);
    await expect(first.get('someone-else', edited.id)).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  } finally { await db.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]); await db.pool.end(); }
}, 60_000);

it.skipIf(!process.env.TEST_DATABASE_URL)('exact greetings consume no category or LLM calls, with durable replay', async () => {
  const db = PlanningDatabase.connect(process.env.TEST_DATABASE_URL!), owner = 'integration:' + randomUUID();
  await db.migrate();
  const planning = new DurablePlanning({ database: db,
    context: async () => { throw new Error('Unexpected catalog call'); },
    provider: async () => { throw new Error('Unexpected LLM call'); },
    plan: async () => { throw new Error('Unexpected planner call'); } });
  try {
    const body = { event_id: randomUUID(), user_text: 'Привет!', locality_token: 'unused-for-greeting' };
    expect(await planning.start(owner, body)).toEqual({ status: 'off_topic' });
    expect(await planning.start(owner, body)).toEqual({ status: 'off_topic' });
  } finally { await db.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]); await db.pool.end(); }
});
