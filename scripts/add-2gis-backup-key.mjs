// Add one owner-provided backup credential to the existing Lockbox payload.
// Existing values stay only in this process's memory and are never logged.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secretId = 'e6qus5g3d4k2uk9b4vo0';
const folderId = 'b1girskfbqdnh1mq580r';
const expectedKeys = new Set(['MAX_BOT_TOKEN', 'YANDEX_API_KEY', 'YANDEX_FOLDER_ID',
  'DGIS_PLACES_API_KEY', 'DGIS_ROUTING_API_KEY', 'DGIS_MAPGL_API_KEY', 'DATABASE_URL', 'DATABASE_CA_PEM']);
function yc(args, input) {
  const result = spawnSync('yc', [...args, '--folder-id', folderId, '--format', 'json'], {
    cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }),
    env: { ...process.env, YC_CLI_INITIALIZATION_SILENCE: 'true' }, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`yc не завершился (код ${result.status ?? 'start/timeout'}); ответ скрыт.`);
  try { return JSON.parse(result.stdout); } catch { throw new Error('Не удалось разобрать ответ yc; ответ скрыт.'); }
}

try {
  if (process.argv.length !== 3 || !['--check', '--apply'].includes(process.argv[2]))
    throw new Error('Использование: node scripts/add-2gis-backup-key.mjs --check|--apply');
  const env = parseEnv(readFileSync(join(root, '.env.local'), 'utf8'));
  const backup = env.DGIS_BACKUP_API_KEY?.trim();
  if (!backup || !/^[a-zA-Z0-9-]{20,100}$/u.test(backup)) throw new Error('Нет корректного DGIS_BACKUP_API_KEY в .env.local.');
  const metadata = yc(['lockbox', 'secret', 'get', '--id', secretId]);
  const versionId = metadata.current_version?.id;
  if (metadata.id !== secretId || !versionId) throw new Error('Версия нужного секрета не определена.');
  const payload = yc(['lockbox', 'payload', 'get', '--id', secretId, '--version-id', versionId]);
  if (payload.version_id !== versionId || !Array.isArray(payload.entries)) throw new Error('Версия payload не совпала.');
  const entries = payload.entries;
  const keys = entries.map(entry => entry.key);
  if (new Set(keys).size !== keys.length || keys.some(key => !expectedKeys.has(key)) ||
    [...expectedKeys].some(key => !keys.includes(key)) ||
    entries.some(entry => typeof entry.text_value !== 'string' || !entry.text_value))
    throw new Error('Состав существующего Lockbox изменился. Ничего не меняем.');
  if (entries.some(entry => entry.text_value === backup)) throw new Error('Резервный ключ совпадает с уже сохранённым значением.');
  if (process.argv[2] === '--check') {
    console.log(`BACKUP_PREFLIGHT_OK\nSecret ID: ${secretId}\nBase version: ${versionId}\nExisting fields: ${keys.length}\nValues hidden; no changes made.`);
  } else {
    const latest = yc(['lockbox', 'secret', 'get', '--id', secretId]);
    if (latest.current_version?.id !== versionId) throw new Error('Lockbox изменился во время проверки. Ничего не меняем.');
    const next = yc(['lockbox', 'secret', 'add-version', '--id', secretId, '--base-version-id', versionId,
      '--description', 'Add 2GIS backup key for per-service quota failover', '--payload', '-'],
    JSON.stringify([...entries, { key: 'DGIS_BACKUP_API_KEY', text_value: backup }]));
    if (!next.id) throw new Error('Ответ add-version не содержит ID; проверьте версии перед повтором.');
    console.log(`LOCKBOX_VERSION_CREATED\nSecret ID: ${secretId}\nVersion ID: ${next.id}\nFields: ${keys.length + 1}\nValues hidden; application not switched.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Неожиданная ошибка; значения скрыты.');
  process.exitCode = 1;
}
