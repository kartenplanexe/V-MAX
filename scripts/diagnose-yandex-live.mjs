// Read-only, bounded diagnostics for one Serverless Container revision.
// Only public metadata and short redacted log messages are printed.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folderId = 'b1girskfbqdnh1mq580r';
const containerId = 'bbapc7qgk242slpm2df5';
const maxLaunchFailureReasons = new Set([
  'bot_token_unconfigured', 'missing_launch_header',
  'empty', 'too_large', 'duplicate_parameter', 'missing_hash', 'invalid_hash',
  'invalid_auth_date', 'expired', 'future_auth_date', 'invalid_user',
]);

function redact(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[PEM REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, 'postgres://[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[a-z0-9+/_=-]+/gi, '[AUTH REDACTED]')
    .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^,\s"'}]+/gi, '$1=[REDACTED]')
    .slice(0, 420);
}

function ycJson(args) {
  const child = spawnSync('yc', [...args, '--folder-id', folderId, '--format', 'json'], {
    cwd: root, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (child.error || child.status !== 0) {
    const firstError = String(child.stderr ?? '').split(/\r?\n/)
      .find(line => /^(ERROR:|Error:|rpc error:)/i.test(line.trim()));
    throw new Error(`yc ${args.slice(0, 3).join(' ')}: ошибка (код ${child.status ?? 'start'}). ${redact(firstError)}`);
  }
  try { return JSON.parse(child.stdout); }
  catch { throw new Error('yc не вернул корректный JSON. Сырые журналы не показываем.'); }
}

function formatEntry(entry) {
  const rawPayload = entry.json_payload ?? entry.jsonPayload;
  const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};
  const message = entry.message ?? payload.message ?? payload.msg ?? payload.error?.message ?? '';
  const prefix = `${String(entry.timestamp ?? '')} ${String(entry.level ?? '')}`;
  if (message === 'Planning database initialization failed') {
    // Yandex puts fields other than msg/level into json_payload. Print only allowlisted
    // diagnostic values; never echo an arbitrary PostgreSQL error or secret payload.
    const phase = ['migration', 'cleanup'].includes(payload.phase) ? payload.phase : 'UNKNOWN';
    const code = typeof payload.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(payload.code)
      ? payload.code : 'UNKNOWN';
    const symptom = payload.symptom === 'CONNECTION_TIMEOUT' ? 'CONNECTION_TIMEOUT' : 'none';
    return `${prefix} Planning database initialization failed phase=${phase} code=${code} symptom=${symptom}`;
  }
  return `${prefix} ${redact(message)}`;
}

function maxLaunchDiagnostic(entry) {
  const rawPayload = entry.json_payload ?? entry.jsonPayload;
  const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};
  let parsedMessage = {};
  if (typeof entry.message === 'string' && entry.message.startsWith('{')) {
    try { parsedMessage = JSON.parse(entry.message); } catch { /* Unstructured log entry. */ }
  }
  const message = payload.msg ?? payload.message ?? parsedMessage.msg ?? parsedMessage.message ?? entry.message;
  if (message !== 'MAX planner launch validation failed') return null;
  const rawReason = payload.reason ?? parsedMessage.reason;
  const reason = maxLaunchFailureReasons.has(rawReason) ? rawReason : 'UNKNOWN';
  const timestamp = typeof entry.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(entry.timestamp)
    ? entry.timestamp.slice(0, 23) : 'UNKNOWN_TIME';
  return { timestamp, reason };
}

try {
  const revisionId = process.argv[2];
  if (revisionId === '--self-test' && process.argv.length === 3) {
    const formatted = formatEntry({ timestamp: 'test', level: 'TRACE', message: 'Planning database initialization failed',
      json_payload: { phase: 'migration', code: 'ERR_TLS_CERT_ALTNAME_INVALID', symptom: 'CONNECTION_TIMEOUT',
        password: 'secret-value', message: 'password=secret-value' } });
    assert.equal(formatted, 'test TRACE Planning database initialization failed phase=migration code=ERR_TLS_CERT_ALTNAME_INVALID symptom=CONNECTION_TIMEOUT');
    assert(!formatted.includes('secret-value'));
    assert.deepEqual(maxLaunchDiagnostic({ timestamp: '2026-09-24T20:00:00.000Z',
      json_payload: { msg: 'MAX planner launch validation failed', reason: 'invalid_hash', token: 'secret-value' } }),
    { timestamp: '2026-09-24T20:00:00.000', reason: 'invalid_hash' });
    assert.equal(maxLaunchDiagnostic({ message: 'Some other error', json_payload: { reason: 'invalid_hash' } }), null);
    assert.deepEqual(maxLaunchDiagnostic({ message: JSON.stringify({ msg: 'MAX planner launch validation failed',
      reason: 'secret-value' }) }), { timestamp: 'UNKNOWN_TIME', reason: 'UNKNOWN' });
    console.log('DIAGNOSTIC_FORMAT_SELF_TEST_OK');
    process.exit(0);
  }
  const launchOnly = process.argv[3] === '--max-launch';
  if ((process.argv.length !== 3 && !(process.argv.length === 4 && launchOnly)) || !/^bba[a-z0-9]{10,}$/.test(revisionId ?? '')) {
    throw new Error('Укажите ID ревизии: node scripts/diagnose-yandex-live.mjs bba... [--max-launch]');
  }
  const revision = ycJson(['serverless', 'container', 'revision', 'get', '--id', revisionId]);
  if ((revision.container_id ?? revision.containerId) !== containerId) {
    throw new Error('Эта ревизия не принадлежит ожидаемому контейнеру MAX.');
  }
  const created = new Date(revision.created_at ?? revision.createdAt);
  if (Number.isNaN(created.getTime())) throw new Error('Не удалось определить время создания ревизии.');
  const since = new Date(created.getTime() - 30_000).toISOString();
  const until = new Date(Math.min(Date.now(), created.getTime() + (launchOnly ? 60 : 12) * 60_000)).toISOString();
  console.log(`Читаю журнал контейнера за ${since} — ${until}; ревизия ${revisionId}. Только чтение.`);
  const result = ycJson(['logging', 'read', '--group-name', 'default',
    '--resource-ids', containerId, '--since', since, '--until', until, '--limit', launchOnly ? '1000' : '200']);
  const entries = Array.isArray(result) ? result : result.entries;
  if (!Array.isArray(entries)) throw new Error('Неизвестный формат ответа Cloud Logging.');
  if (launchOnly) {
    const failures = entries.map(maxLaunchDiagnostic).filter(Boolean);
    console.log(`Записей просмотрено: ${entries.length}. Ошибок проверки запуска MAX: ${failures.length}.`);
    for (const failure of failures.slice(-20)) console.log(`${failure.timestamp} reason=${failure.reason}`);
    if (!failures.length) console.log('Причина не найдена в этом окне журнала. Токены и сырые записи не выводятся.');
  } else {
    console.log(`Записей: ${entries.length}. Печатаю короткие обезличенные сообщения, максимум 50.`);
    for (const entry of entries.slice(0, 50)) console.log(formatEntry(entry));
    if (!entries.length) console.log('Журнал пуст: проверьте, включено ли логирование ревизии и есть ли доступ к Cloud Logging.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Не удалось прочитать журнал.');
  process.exitCode = 1;
}
