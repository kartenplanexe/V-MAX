import { describe, expect, it } from 'vitest';
import { PlanningSessions } from './planning-sessions.js';
import { planningFixture } from './place-planning.fixture.js';

describe('durable planning checkpoint', () => {
  it('restores drafts and event receipts without a process-local map', () => {
    const fixture = planningFixture();
    const options = { now: () => new Date('2026-09-24T09:00:00Z'), plan: async () => ({}) };
    const sessions = new PlanningSessions(options);
    const context = { catalog: fixture.input.catalog, visit_policy: fixture.input.visit_policy, modes: ['walking'] as const, data_mode: 'live' as const };
    const view = sessions.create('max:1', fixture.input.intent, context);
    const input = { base_version: 0, event_id: 'edit-event-1', changes: [{ op: 'party', total: 2 }] };
    sessions.edit('max:1', view.id, input);
    const restored = new PlanningSessions({ ...options, checkpoint: JSON.parse(JSON.stringify(sessions.checkpoint())) });
    expect(restored.get('max:1', view.id).draft.shared.party?.total).toBe(2);
    expect(restored.edit('max:1', view.id, input).version).toBe(1);
    expect(() => restored.get('max:2', view.id)).toThrow('DRAFT_NOT_FOUND');
  });
});
