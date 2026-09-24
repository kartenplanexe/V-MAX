// Deploy the live product to the existing MAX mini-app URL. Run from the owner's
// terminal: this script needs their authenticated yc/docker CLI, not secret values.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folderId = 'b1girskfbqdnh1mq580r';
const containerId = 'bbapc7qgk242slpm2df5';
const registryId = 'crphfddv12abu4qe4qs1';
const networkId = 'enp2df7tk8j68tctofcj';
const serviceAccountId = 'aje2uk33pjbmmifon5mn';
const secretId = 'e6qus5g3d4k2uk9b4vo0';
const secretVersionId = 'e6qdjd7lalv5fqgpl7oh';
const baseUrl = `https://${containerId}.containers.yandexcloud.net/`;
const secretKeys = [
  'MAX_BOT_TOKEN', 'YANDEX_API_KEY', 'YANDEX_FOLDER_ID',
  'DGIS_PLACES_API_KEY', 'DGIS_ROUTING_API_KEY', 'DGIS_MAPGL_API_KEY',
  'DATABASE_URL', 'DATABASE_CA_PEM',
];
const publicEnvironment = {
  HOST: '0.0.0.0', PORT: '8080', NODE_ENV: 'production', PUBLIC_BASE_URL: baseUrl,
};
const retainedEnvironmentKeys = new Set(['MAX_INIT_DATA_TTL_SECONDS']);

function run(program, args, { json = false, stream = false, timeout = 90_000 } = {}) {
  const child = spawnSync(program, args, {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    stdio: stream ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, YC_CLI_INITIALIZATION_SILENCE: 'true' },
  });
  if (child.error || child.status !== 0) {
    // Do not echo CLI diagnostics: revision metadata can contain environment values.
    throw new Error(`${program} ${args.slice(0, 4).join(' ')}: ошибка/таймаут (код ${child.status ?? 'start'}). Секреты не печатаем.`);
  }
  if (!json) return child.stdout ?? '';
  try { return JSON.parse(child.stdout); }
  catch { throw new Error(`${program}: ответ не является JSON.`); }
}

const yc = (args, options = {}) => run('yc', [...args, '--folder-id', folderId, '--format', 'json'], { ...options, json: true });
const ycAction = (args, options = {}) => run('yc', [...args, '--folder-id', folderId], options);
const revisions = () => {
  const value = yc(['serverless', 'container', 'revision', 'list', '--container-id', containerId]);
  return Array.isArray(value) ? value : value.revisions;
};
const activeRevision = () => {
  const list = revisions();
  if (!Array.isArray(list)) throw new Error('Не удалось прочитать список ревизий. Ничего не меняем.');
  const active = list.filter(row => String(row.status).toUpperCase() === 'ACTIVE');
  if (active.length !== 1 || !active[0].id) throw new Error('Не удалось однозначно определить активную ревизию. Ничего не меняем.');
  return active[0];
};

function checkExistingConfiguration(revision) {
  const env = revision.image?.environment ?? revision.environment ?? {};
  if (typeof env !== 'object' || Array.isArray(env)) throw new Error('Неизвестный формат переменных активной ревизии. Ничего не меняем.');
  // A previous placeholder may have put a now-secret key directly in env.
  // Replace those keys with Lockbox mappings; never print or forward old values.
  const extraEnv = Object.keys(env).filter(key =>
    !(key in publicEnvironment) && !secretKeys.includes(key) && !retainedEnvironmentKeys.has(key));
  if (extraEnv.length) throw new Error(`У старой ревизии есть дополнительные переменные: ${extraEnv.join(', ')}. Их перенос требует проверки; ничего не меняем.`);
  const retainedEnvironment = {};
  if (env.MAX_INIT_DATA_TTL_SECONDS !== undefined) {
    const ttl = String(env.MAX_INIT_DATA_TTL_SECONDS).trim();
    if (!/^[1-9][0-9]*$/.test(ttl) || !Number.isSafeInteger(Number(ttl))) {
      throw new Error('MAX_INIT_DATA_TTL_SECONDS в старой ревизии не является положительным целым числом. Ничего не меняем.');
    }
    retainedEnvironment.MAX_INIT_DATA_TTL_SECONDS = ttl;
  }
  const secrets = revision.secrets ?? [];
  if (!Array.isArray(secrets)) throw new Error('Неизвестный формат Lockbox-настроек старой ревизии. Ничего не меняем.');
  const extraSecrets = secrets.map(item => item.environment_variable ?? item.environmentVariable)
    .filter(key => !key || !secretKeys.includes(key));
  if (extraSecrets.length) throw new Error('У старой ревизии есть дополнительные либо неопознанные secret mappings. Ничего не меняем.');
  if ((revision.mounts?.length ?? 0) || (revision.storage_mounts?.length ?? 0) || (revision.storageMounts?.length ?? 0)) {
    throw new Error('У старой ревизии есть подключённые тома. Не переносим их молча.');
  }
  const runtime = revision.runtime;
  if (runtime && typeof runtime === 'object' && !('http' in runtime)) {
    throw new Error('Старая ревизия не в HTTP-режиме. Ничего не меняем.');
  }
  return retainedEnvironment;
}

async function getWithRetry(path, expectedStatus, expectedError) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(new URL(path, baseUrl), {
        signal: AbortSignal.timeout(55_000), headers: { accept: 'application/json' },
      });
      const body = await response.json();
      if (response.status === expectedStatus &&
        (!expectedError || body.error === expectedError)) return body;
      console.log(`Проверка ${path}: HTTP ${response.status}, попытка ${attempt}/3.`);
    } catch {
      console.log(`Проверка ${path}: нет ответа, попытка ${attempt}/3.`);
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  throw new Error(`${path} не прошёл проверку (ожидается HTTP ${expectedStatus}${expectedError ? ` / ${expectedError}` : ''}).`);
}

let previousId;
let deploymentStarted = false;
try {
  if (process.argv[2] === '--self-test') {
    assert.deepEqual(checkExistingConfiguration({ image: { environment: { MAX_INIT_DATA_TTL_SECONDS: '3600' } } }),
      { MAX_INIT_DATA_TTL_SECONDS: '3600' });
    assert.throws(() => checkExistingConfiguration({ image: { environment: { UNEXPECTED_SETTING: 'x' } } }), /дополнительные переменные/);
    assert.throws(() => checkExistingConfiguration({ image: { environment: { MAX_INIT_DATA_TTL_SECONDS: '0' } } }), /положительным целым/);
    console.log('DEPLOY_PREFLIGHT_SELF_TEST_OK');
    process.exit(0);
  }
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') {
    console.log('Выкладка существующего контейнера MAX: node scripts/deploy-yandex-live.mjs --apply');
    console.log('Команда выполняет проверку, docker build/push, выкладку и HTTP smoke. Секреты не выводятся.');
    process.exit(0);
  }
  console.log('Проверяю существующий контейнер, ревизию, сеть и закреплённую версию Lockbox…');
  const container = yc(['serverless', 'container', 'get', '--id', containerId]);
  if (container.id !== containerId || container.folder_id !== folderId ||
    !container.url || new URL(container.url).href !== baseUrl) {
    throw new Error('Контейнер/каталог/URL не совпал с уже переданной организаторам ссылкой. Ничего не меняем.');
  }
  const before = activeRevision();
  previousId = before.id;
  const detail = yc(['serverless', 'container', 'revision', 'get', '--id', previousId]);
  const retainedEnvironment = checkExistingConfiguration(detail);
  const network = yc(['vpc', 'network', 'get', '--id', networkId]);
  if (network.id !== networkId || network.folder_id !== folderId) throw new Error('Нужная VPC-сеть не найдена в каталоге.');
  const secret = yc(['lockbox', 'secret', 'get', '--id', secretId]);
  if (secret.id !== secretId || secret.current_version?.id !== secretVersionId) {
    throw new Error('Текущая версия Lockbox отличается от подготовленной. Ничего не меняем.');
  }
  const tag = 'live-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const image = `cr.yandex/${registryId}/maxbot-app:${tag}`;
  console.log(`Предыдущая ревизия: ${previousId}. Новая версия секрета: ${secretVersionId}. URL останется прежним.`);
  console.log('Собираю Docker-образ…');
  run('docker', ['build', '--tag', image, '.'], { stream: true, timeout: 30 * 60_000 });
  console.log('Загружаю образ в существующий Container Registry…');
  run('docker', ['push', image], { stream: true, timeout: 15 * 60_000 });
  if (activeRevision().id !== previousId) throw new Error('Активная ревизия изменилась во время сборки. Выкладка остановлена.');
  const args = [
    'serverless', 'container', 'revision', 'deploy', '--container-id', containerId,
    '--image', image, '--service-account-id', serviceAccountId,
    '--network-id', networkId, '--memory', '1GB', '--cores', '1',
    '--execution-timeout', '180s', '--concurrency', '2', '--min-instances', '0',
    '--zone-instances-limit', '1', '--runtime', 'http',
    '--description', `Live planner; Lockbox ${secretVersionId}; ${tag}`,
    '--environment', Object.entries({ ...publicEnvironment, ...retainedEnvironment })
      .map(([key, value]) => `${key}=${value}`).join(','),
  ];
  for (const key of secretKeys) {
    args.push('--secret', `environment-variable=${key},id=${secretId},version-id=${secretVersionId},key=${key}`);
  }
  console.log('Создаю новую ревизию того же контейнера…');
  deploymentStarted = true;
  ycAction(args, { timeout: 5 * 60_000 });
  const after = activeRevision();
  if (after.id === previousId) throw new Error('После deploy активная ревизия не изменилась.');
  const newRevision = yc(['serverless', 'container', 'revision', 'get', '--id', after.id]);
  const deployedImage = newRevision.image?.image_url ?? newRevision.image?.imageUrl;
  if (deployedImage !== image) throw new Error('Активная ревизия использует неожиданный образ.');
  const health = await getWithRetry('/api/health', 200);
  if (health.status !== 'ok') throw new Error('/api/health вернул неожиданный ответ.');
  await getWithRetry('/api/planning/bootstrap', 401, 'AUTH_REQUIRED');
  const publicConfig = await getWithRetry('/api/public-config', 200);
  console.log(`DEPLOY_OK\nRevision ID: ${after.id}\nURL: ${baseUrl}\nDB-backed planner: configured (unauthenticated bootstrap rejected)\nMap: ${publicConfig.maps?.enabled ? 'enabled' : 'disabled until separate browser key'}\nПредыдущая ревизия для ручного отката: ${previousId}`);
  deploymentStarted = false;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Неизвестная ошибка выкладки.');
  if (deploymentStarted && previousId) {
    try {
      const now = activeRevision();
      if (now.id !== previousId) {
        console.error(`Возвращаю прежнюю ревизию ${previousId}…`);
        ycAction(['serverless', 'containers', 'rollback', '--id', containerId, '--revision-id', previousId], { timeout: 5 * 60_000 });
        if (activeRevision().id !== previousId) throw new Error('Статус отката не подтверждён.');
        console.error('ROLLBACK_OK: прежняя ревизия снова активна; URL не изменился.');
      }
    } catch {
      console.error(`ОТКАТ НЕ ПОДТВЕРЖДЁН. Проверьте активную ревизию вручную и при необходимости выполните: yc serverless containers rollback --id ${containerId} --revision-id ${previousId}`);
    }
  }
  process.exitCode = 1;
}
