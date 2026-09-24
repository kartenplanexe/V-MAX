import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPlannerPython, runPythonPlanner } from './planner-process.js';

const python = defaultPlannerPython();
// Node-only installs remain supported; planner CI/local setup must also run
// the separately documented Python suite. With uv sync these are real E2E tests.
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
});
