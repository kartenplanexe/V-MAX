import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, 'planner');
const python = resolve(directory, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
if (!existsSync(python)) {
  console.error('Сначала установите Python-зависимости: cd planner; uv sync --frozen. См. planner/README.md.');
  process.exit(1);
}
const [action, ...args] = process.argv.slice(2);
if (!['demo', 'test', 'run'].includes(action)) throw new Error('Expected demo, test, or run');
const command = action === 'test' ? ['-m', 'pytest', ...args] : [resolve(directory, 'run.py'), ...(action === 'demo' ? ['--demo'] : args)];
const child = spawn(python, command, { cwd: action === 'test' ? directory : process.cwd(), stdio: 'inherit', windowsHide: true, shell: false });
child.on('error', () => { console.error('Не удалось запустить Python-планировщик.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
