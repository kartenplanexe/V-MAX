// User-operated deployment preparation. No LLM calls, image push, or revision switch.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secretId = 'e6qus5g3d4k2uk9b4vo0';
const folderId = 'b1girskfbqdnh1mq580r';
const runtimeSa = 'aje2uk33pjbmmifon5mn';
const required = ['MAX_BOT_TOKEN', 'YANDEX_API_KEY', 'YANDEX_FOLDER_ID', 'DGIS_PLACES_API_KEY', 'DGIS_ROUTING_API_KEY'];
const allowedArgs = new Set(['--apply']);
function execute(bin, args, { input, interactive = false } = {}) {
  const result = spawnSync(bin, args, {
    cwd: root, encoding: 'utf8', timeout: interactive ? 180_000 : 60_000,
    maxBuffer: 2 * 1024 * 1024,
    // SSH passphrase prompts go to the user's terminal. Secret stdout stays in memory.
    stdio: interactive ? ['inherit', 'pipe', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    ...(input !== undefined ? { input } : {}),
    env: { ...process.env, YC_CLI_INITIALIZATION_SILENCE: 'true' },
  });
  if (result.error || result.status !== 0) {
    // YC may include submitted payload in an error: deliberately do not echo output.
    throw new Error(`${bin}: команда не завершилась успешно (код ${result.status ?? 'timeout/start error'}). Содержимое ответа скрыто, чтобы не раскрыть секреты.`);
  }
  return result.stdout;
}
function yc(args, input) {
  return JSON.parse(execute('yc', [...args, '--folder-id', folderId, '--format', 'json'], { input }));
}

try {
  if (process.argv.slice(2).some(arg => !allowedArgs.has(arg))) throw new Error('Допустимый параметр: --apply');
  const env = parseEnv(readFileSync(join(root, '.env.local'), 'utf8'));
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Заполните в .env.local: ${missing.join(', ')}`);
  if (env.YANDEX_FOLDER_ID.trim() !== folderId) throw new Error('YANDEX_FOLDER_ID отличается от каталога maxbot. Ничего не изменено.');
  const pairs = required.map(key => ({ key, text_value: env[key].trim() }));
  if (env.DGIS_MAPGL_API_KEY?.trim()) pairs.push({ key: 'DGIS_MAPGL_API_KEY', text_value: env.DGIS_MAPGL_API_KEY.trim() });
  const mapDistinct = Boolean(env.DGIS_MAPGL_API_KEY?.trim()) &&
    ![env.DGIS_PLACES_API_KEY?.trim(), env.DGIS_ROUTING_API_KEY?.trim()].includes(env.DGIS_MAPGL_API_KEY.trim());
  console.log(`Локальные обязательные настройки: OK. Отдельный MapGL-ключ: ${mapDistinct ? 'есть' : 'не подтверждён; карта может быть отключена'}. Значения не выводятся.`);
  if (!process.argv.includes('--apply')) {
    console.log('Только локальная проверка. Для чтения настроек БД по SSH и новой версии Lockbox запустите с --apply.');
  } else {
    console.log('Читаю только метаданные Lockbox...');
    const secret = yc(['lockbox', 'secret', 'get', '--id', secretId]);
    const baseVersion = secret.current_version?.id;
    if (!baseVersion) throw new Error('Не удалось определить текущую версию Lockbox. Изменений нет.');
    console.log('Подключаюсь к ВМ. Если SSH попросит пароль ключа — введите его в этом терминале.');
    const remote = execute('ssh', [
      '-i', join(homedir(), '.ssh', 'maxbot-db'), '-o', 'ConnectTimeout=15',
      '-o', 'StrictHostKeyChecking=yes', 'yc-user@158.160.195.62',
      'sudo -n cat /opt/maxbot-postgres/private/connection.env /opt/maxbot-postgres/certs/ca.crt',
    ], { interactive: true });
    const lines = remote.trim().split(/\r?\n/);
    if (!lines[0]?.startsWith('DATABASE_URL=')) throw new Error('Неожиданный формат настроек на ВМ. Изменений нет.');
    const databaseUrl = lines.shift().slice('DATABASE_URL='.length).trim();
    let address;
    try { address = new URL(databaseUrl); } catch { throw new Error('Некорректный формат DATABASE_URL на ВМ'); }
    if (address.protocol !== 'postgres:' || address.hostname !== '10.130.0.19' ||
      address.port !== '5432' || address.username !== 'maxbot' || address.pathname !== '/maxbot' ||
      address.search || address.hash || !address.password) throw new Error('DATABASE_URL не соответствует ожидаемой базе maxbot на 10.130.0.19:5432');
    const ca = lines.join('\n');
    if (ca.includes('PRIVATE KEY')) throw new Error('Вместо публичного сертификата получен закрытый ключ. Передача запрещена.');
    let cert;
    try { cert = new X509Certificate(ca); } catch { throw new Error('Публичный CA-сертификат на ВМ не разбирается'); }
    if (!cert.ca || Date.parse(cert.validTo) - Date.now() < 30 * 86400_000) throw new Error('CA не подходит или истекает менее чем через 30 дней');
    pairs.push({ key: 'DATABASE_URL', text_value: databaseUrl }, { key: 'DATABASE_CA_PEM', text_value: ca });
    console.log('Передаю настройки в новую версию существующего Lockbox. Пароли не сохраняются в файлы и не попадают в аргументы процесса.');
    const version = yc(['lockbox', 'secret', 'add-version', '--id', secretId,
      '--base-version-id', baseVersion, '--description', 'VM PostgreSQL TLS and live planner settings', '--payload', '-'], JSON.stringify(pairs));
    if (!version.id) throw new Error('Ответ add-version не содержит ID. Проверьте версии секрета перед повтором.');
    console.log(`LOCKBOX_VERSION_CREATED\nSecret ID: ${secretId}\nVersion ID: ${version.id}`);
    // Exact existing runtime identity and exact secret only; no folder-wide role.
    execute('yc', ['lockbox', 'secret', 'add-access-binding', '--id', secretId,
      '--role', 'lockbox.payloadViewer', '--service-account-id', runtimeSa, '--folder-id', folderId]);
    console.log(`RUNTIME_SECRET_ACCESS_OK\nPrepared keys: ${pairs.map(pair => pair.key).join(', ')}\nПриложение не переключалось. Новая версия будет явно закреплена в следующей ревизии.`);
  }
} catch (error) {
  // Unexpected exceptions may contain source text; only messages we create are useful here.
  console.error(error instanceof Error && !['SyntaxError', 'TypeError'].includes(error.name)
    ? error.message : 'Не удалось разобрать конфигурацию/ответ. Значения скрыты.');
  process.exitCode = 1;
}
