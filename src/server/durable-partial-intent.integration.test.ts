import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { PlanningDatabase } from './planning-database.js';
import { DurablePlanning } from './durable-planning.js';
import { RouteSharing } from './route-sharing.js';
import { intentFixture } from './intent-start.fixture.js';
import { planningFixture } from './place-planning.fixture.js';

it.skipIf(!process.env.TEST_DATABASE_URL)('retains and resolves a partial request across instances without reparsing or sharing unresolved private text', async () => {
  const db = PlanningDatabase.connect(process.env.TEST_DATABASE_URL!), owner = 'partial-integration:' + randomUUID();
  await db.migrate();
  const f = intentFixture(), places = planningFixture(); let calls = 0;
  const text = f.text + ', бюджет как обычно';
  const response = { ...f.response, unresolved: [{ field: 'budget', day_ids: [], text: 'бюджет как обычно', reason: 'ambiguous' }] };
  const options = { database: db, context: async () => ({ ...f.context, planning: {
    catalog: places.input.catalog, visit_policy: places.input.visit_policy, modes: ['walking'] as const, data_mode: 'test' as const } }),
    provider: async () => { calls++; return response; }, plan: async () => { throw Error('Must not calculate during clarification'); } };
  try {
    const first = new DurablePlanning(options);
    const created = await first.start(owner, { event_id: randomUUID(), user_text: text, locality_token: 'synthetic-context' });
    if (created.status !== 'draft') throw Error('Expected draft');
    const persisted = await db.pool.query('SELECT state FROM planning_owners WHERE owner=$1', [owner]);
    expect(persisted.rows[0].state.checkpoint.version).toBe(2);
    const second = new DurablePlanning({ ...options, provider: async () => { throw Error('Must not reparse'); } });
    expect(await second.get(owner, created.view.id)).toEqual(created.view);
    const saved = await second.getSaved(owner, created.view.id);
    expect(saved.conditions.clarifications).toEqual(created.view.draft.clarifications);
    const sharing = new RouteSharing({ database: db, botUsername: 'synthetic_bot', context: options.context });
    await expect(sharing.create(owner, { draft_id: saved.id, base_revision: saved.revision,
      event_id: randomUUID(), include_private_points: true })).rejects.toMatchObject({ code: 'SHARE_CLARIFICATION_REQUIRED' });
    const body = { base_version: created.view.version, event_id: randomUUID(), changes: [
      { op: 'budget', value: { kind: 'unlimited' } },
      { op: 'resolve_clarification', clarification_id: created.view.draft.clarifications![0]!.id },
    ] };
    const resolved = await second.edit(owner, saved.id, body);
    expect(resolved.draft.clarifications).toBeUndefined();
    expect(resolved.draft.days).toEqual(created.view.draft.days);
    expect(await first.edit(owner, saved.id, body)).toEqual(resolved);
    expect((await first.getSaved(owner, saved.id)).conditions.clarifications).toBeUndefined();
    expect(calls).toBe(1);
  } finally {
    await db.pool.query('DELETE FROM planning_owners WHERE owner=$1', [owner]);
    await db.pool.query('DELETE FROM saved_user_conditions WHERE owner=$1', [owner]); await db.pool.end();
  }
});
