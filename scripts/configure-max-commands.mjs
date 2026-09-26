import { loadEnvFile } from 'node:process';

try { loadEnvFile('.env.local'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const token = process.env.MAX_BOT_TOKEN?.trim();
if (!token) throw new Error('MAX_BOT_TOKEN is required in .env.local.');
const desired = [
  { name: 'start', description: 'Открыть меню планировщика' },
  { name: 'new', description: 'Составить новый маршрут' },
  { name: 'routes', description: 'Показать мои маршруты' },
  { name: 'exit', description: 'Выйти из планирования' },
  { name: 'menu', description: 'Показать действия бота' },
];

async function call(method, path, body) {
  const response = await fetch(`https://platform-api2.max.ru${path}`, {
    method, headers: { Authorization: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`MAX bot command API HTTP ${response.status}`);
  return response.json();
}

const current = await call('GET', '/me');
if (!current.is_bot || !Array.isArray(current.commands ?? [])) throw new Error('Unexpected MAX bot profile response.');
const existing = current.commands ?? [];
const names = new Set(desired.map(command => command.name));
const merged = [...existing.filter(command => !names.has(command.name)), ...desired];
if (merged.length > 32) throw new Error('MAX command limit exceeded; inspect existing commands before applying.');
console.log(JSON.stringify({ bot: current.username, current: existing.map(command => command.name),
  proposed: merged.map(command => command.name), apply: process.argv.includes('--apply') }, null, 2));
if (!process.argv.includes('--apply')) process.exit(0);
const result = await call('PATCH', '/me/commands', { commands: merged });
if (!Array.isArray(result.commands) || desired.some(command => !result.commands.some(item => item.name === command.name)))
  throw new Error('MAX did not confirm all navigation commands.');
console.log('MAX_NAVIGATION_COMMANDS_OK');
