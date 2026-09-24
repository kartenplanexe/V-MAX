import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';

const Reply = z.object({
  schema_version: z.literal('place-selection.v1'),
  status: z.enum(['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'NEEDS_INPUT', 'ERROR']),
}).passthrough();
const MAX_BYTES = 8 * 1024 * 1024;

export function defaultPlannerPython(directory = resolve('planner')) {
  return resolve(directory, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
}

/** Internal, server-owned input only. Not an HTTP endpoint or an auth boundary.
 * The child receives no API keys, has no networking code, and never writes jobs.
 */
export async function runPythonPlanner(job: unknown, options: {
  plannerDirectory?: string;
  pythonExecutable?: string;
  operation?: 'solve' | 'prepare-routes' | 'route-checks';
} = {}) {
  const directory = resolve(options.plannerDirectory ?? 'planner');
  const python = options.pythonExecutable ?? defaultPlannerPython(directory);
  const input = JSON.stringify(job);
  if (!input || Buffer.byteLength(input) > MAX_BYTES) throw new Error('Planner input exceeds the size limit.');
  const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  // Preserve only OS runtime paths, not MAX/2GIS/Yandex secrets or PYTHONPATH.
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'LANG']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return new Promise<z.infer<typeof Reply>>((accept, reject) => {
    const child = spawn(python, [resolve(directory, 'run.py'), '--operation', options.operation ?? 'solve'], { cwd: directory, env, windowsHide: true, shell: false });
    const chunks: Buffer[] = [];
    let bytes = 0, settled = false;
    const timer = setTimeout(() => fail('Planner timed out.'), 30_000);
    function fail(message: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(message));
    }
    child.on('error', () => fail('Planner process is unavailable. Run the Python setup from planner/README.md.'));
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) return fail('Planner output exceeds the size limit.');
      chunks.push(chunk);
    });
    child.stderr.resume(); // No raw provider/OS diagnostics in application responses.
    child.stdin.on('error', () => fail('Planner input channel closed.'));
    child.on('close', code => {
      if (settled) return;
      try {
        const reply = Reply.parse(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        if (code !== 0 && reply.status !== 'ERROR') throw new Error('Invalid process result');
        settled = true;
        clearTimeout(timer);
        accept(reply);
      } catch { fail('Planner returned an invalid response.'); }
    });
    child.stdin.end(input);
  });
}
