import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPlannerPython, runPythonPlanner } from './planner-process.js';

const python = defaultPlannerPython();

describe.skipIf(!existsSync(python))('TypeScript -> Python -> OR-Tools', () => {
  it('passes the actual JSON protocol to the solver and gets a verified plan', async () => {
    const input = execFileSync(python, [resolve('planner/run.py'), '--demo-input'], { encoding: 'utf8', windowsHide: true });
    const result = await runPythonPlanner(JSON.parse(input));
    expect(result.status).toBe('AVAILABLE');
    expect(result.data_mode).toBe('test');
    expect(result.total_budget_upper_minor).toBe(100000);
    const days = result.days as { visits: { place_id: string }[] }[];
    expect(days[0]?.visits.map(v => v.place_id)).toEqual(['museum-near', 'cafe']);
  });

  it('does not leak input values when the Python contract rejects a job', async () => {
    const reply = await runPythonPlanner({ token: 'must-not-appear' });
    expect(reply.status).toBe('ERROR');
    expect(JSON.stringify(reply)).not.toContain('must-not-appear');
  });

  it('accepts internal recovery completion through the real CLI without leaking DONE as a public plan', async () => {
    const input = JSON.parse(execFileSync(python, [resolve('planner/run.py'), '--demo-input'], { encoding: 'utf8', windowsHide: true }));
    const prepared = await runPythonPlanner(input, { operation: 'prepare-routes' });
    const job = { ...(prepared.job as Record<string, unknown>), route_legs: input.route_legs };
    const result = await runPythonPlanner(job);
    expect(result.status).toBe('AVAILABLE');
    const recovered = await runPythonPlanner({ job, result, attempted: [] }, { operation: 'recover-routes' });
    expect(recovered.status).toBe('DONE'); expect(recovered.stop_reason).toBe('COVERAGE_COMPLETE');
  }, 15_000);
});
