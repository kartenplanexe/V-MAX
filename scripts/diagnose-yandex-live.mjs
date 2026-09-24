// Read-only, bounded diagnostics for one Serverless Container revision.
// Only public metadata and short redacted log messages are printed.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folderId = 'b1girskfbqdnh1mq580r';
const containerId = 'bbapc7qgk242slpm2df5';

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

try {
  const revisionId = process.argv[2];
  if (process.argv.length !== 3 || !/^bba[a-z0-9]{10,}$/.test(revisionId ?? '')) {
    throw new Error('Укажите один ID ревизии: node scripts/diagnose-yandex-live.mjs bba...');
  }
  const revision = ycJson(['serverless', 'container', 'revision', 'get', '--id', revisionId]);
  if ((revision.container_id ?? revision.containerId) !== containerId) {
    throw new Error('Эта ревизия не принадлежит ожидаемому контейнеру MAX.');
  }
  const created = new Date(revision.created_at ?? revision.createdAt);
  if (Number.isNaN(created.getTime())) throw new Error('Не удалось определить время создания ревизии.');
  const since = new Date(created.getTime() - 30_000).toISOString();
  const until = new Date(Math.min(Date.now(), created.getTime() + 12 * 60_000)).toISOString();
  console.log(`Читаю журнал контейнера за ${since} — ${until}; ревизия ${revisionId}. Только чтение.`);
  const result = ycJson(['logging', 'read', '--group-name', 'default',
    '--resource-ids', containerId, '--since', since, '--until', until, '--limit', '200']);
  const entries = Array.isArray(result) ? result : result.entries;
  if (!Array.isArray(entries)) throw new Error('Неизвестный формат ответа Cloud Logging.');
  console.log(`Записей: ${entries.length}. Печатаю короткие обезличенные сообщения, максимум 50.`);
  for (const entry of entries.slice(0, 50)) {
    const payload = entry.json_payload ?? entry.jsonPayload ?? {};
    const message = entry.message ?? payload.message ?? payload.msg ?? payload.error?.message ?? '';
    const level = String(entry.level ?? '');
    const timestamp = String(entry.timestamp ?? '');
    console.log(`${timestamp} ${level} ${redact(message)}`);
  }
  if (!entries.length) console.log('Журнал пуст: проверьте, включено ли логирование ревизии и есть ли доступ к Cloud Logging.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Не удалось прочитать журнал.');
  process.exitCode = 1;
}
