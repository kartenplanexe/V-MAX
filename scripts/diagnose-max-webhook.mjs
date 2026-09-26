// Read-only MAX webhook delivery diagnosis. Never prints request bodies, headers or raw logs.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const folderId = 'b1girskfbqdnh1mq580r';
const containerId = 'bbapc7qgk242slpm2df5';
const sinceArg = process.argv.find(arg => arg.startsWith('--since='));
const since = sinceArg?.slice('--since='.length) ?? new Date(Date.now() - 3 * 60 * 60_000).toISOString();
const until = new Date().toISOString();
if ((process.argv.length > 3 || (process.argv.length === 3 && !sinceArg)) ||
    !Number.isFinite(Date.parse(since)) || Date.parse(since) > Date.now() ||
    Date.now() - Date.parse(since) > 24 * 60 * 60_000) {
  throw new Error('Usage: node scripts/diagnose-max-webhook.mjs [--since=UTC_ISO_TIME] (last 24 hours only)');
}

function logPayload(entry) {
  const structured = entry.json_payload ?? entry.jsonPayload;
  let messageObject = null;
  if (typeof entry.message === 'string' && entry.message.startsWith('{')) {
    try { messageObject = JSON.parse(entry.message); } catch { /* Not JSON. */ }
  }
  return { ...(messageObject && typeof messageObject === 'object' ? messageObject : {}),
    ...(structured && typeof structured === 'object' ? structured : {}) };
}

function safeCode(value) {
  if (typeof value !== 'string') return 'OTHER';
  if (/^MAX_SEND_[A-Z0-9_]{3,60}$/u.test(value)) return value;
  if (/^(UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|OPERATION_IN_PROGRESS|INTENT_PROVIDER_FAILED|INTENT_INVALID_RESPONSE|INTENT_NEEDS_CLARIFICATION)$/u.test(value)) return value;
  if (/fetch failed/iu.test(value)) return 'FETCH_FAILED';
  if (/certificate|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/iu.test(value)) return 'TLS_ERROR';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/iu.test(value)) return 'DNS_ERROR';
  if (/timeout|timed out/iu.test(value)) return 'TIMEOUT';
  if (/password authentication|authentication failed/iu.test(value)) return 'DB_AUTH_ERROR';
  if (/ECONNREFUSED|connection refused/iu.test(value)) return 'CONNECTION_REFUSED';
  if (/connection terminated|Connection terminated|socket hang up/iu.test(value)) return 'CONNECTION_TERMINATED';
  if (/database|postgres|relation .* does not exist/iu.test(value)) return 'DATABASE_ERROR';
  return 'OTHER';
}

export function summarizeWebhookLogs(entries) {
  const requests = new Map();
  const events = [];
  let failures = 0;
  let failureCodeFields = 0;
  let requestEntriesSeen = 0;
  let healthRequests = 0;
  const codes = {};
  const intentDiagnostics = [];
  for (const entry of [...entries].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))) {
    const payload = logPayload(entry);
    const message = payload.msg ?? payload.message ?? entry.message;
    if (message === 'MAX intent validation failed' && payload.diagnostic && typeof payload.diagnostic === 'object') {
      const diagnostic = payload.diagnostic;
      const safeList = values => Array.isArray(values) ? values.filter(value => typeof value === 'string' && /^[A-Z_]{2,80}$/u.test(value)).slice(0, 12) : [];
      intentDiagnostics.push({ time: typeof entry.timestamp === 'string' ? entry.timestamp.slice(0, 23) : 'UNKNOWN_TIME',
        code: safeCode(payload.code),
        stage: ['guard', 'projection', 'draft', 'control'].includes(diagnostic.stage) ? diagnostic.stage : 'OTHER',
        errors: safeList(diagnostic.errors), reasons: safeList(diagnostic.reasons),
        schema: Array.isArray(diagnostic.schema) ? diagnostic.schema.slice(0, 12).map(issue => ({
          path: typeof issue.path === 'string' && /^\/(?:[a-z_]+|\d+|\/)*$/iu.test(issue.path) ? issue.path : 'OTHER',
          keyword: typeof issue.keyword === 'string' && /^[a-zA-Z]{2,40}$/u.test(issue.keyword) ? issue.keyword : 'OTHER',
        })) : [],
        fields: Array.isArray(diagnostic.fields) ? diagnostic.fields.slice(0, 12).map(issue => ({
          path: typeof issue.path === 'string' && /^[\w.]+$/u.test(issue.path) ? issue.path : 'OTHER',
          code: typeof issue.code === 'string' && /^[a-z_]+$/u.test(issue.code) ? issue.code : 'OTHER',
        })) : [] });
    }
    if (message === 'MAX chat update failed') {
      failures++;
      const rawCode = payload.code ?? payload.error?.code ?? payload.error?.message ??
        payload.err?.code ?? payload.err?.message;
      if (typeof rawCode === 'string') failureCodeFields++;
      const code = safeCode(rawCode);
      codes[code] = (codes[code] ?? 0) + 1;
    }
    const url = payload.req?.url ?? payload.request?.url ?? entry.http_request?.request_url;
    const status = payload.res?.statusCode ?? payload.response?.status_code ?? entry.http_request?.status;
    if (typeof url === 'string') {
      requestEntriesSeen++;
      if (url.split('?')[0].endsWith('/api/health')) healthRequests++;
    }
    if (typeof url === 'string' && url.split('?')[0].endsWith('/api/max/webhook')) {
      const id = String(payload.reqId ?? payload.request_id ?? entry.id ?? events.length);
      const time = typeof entry.timestamp === 'string' ? entry.timestamp.slice(0, 23) : 'UNKNOWN_TIME';
      requests.set(id, events.length);
      events.push({ time, status: Number.isSafeInteger(Number(status)) ? Number(status) : null });
    }
    const id = String(payload.reqId ?? payload.request_id ?? '');
    if (id && requests.has(id) && Number.isSafeInteger(Number(status))) {
      events[requests.get(id)].status = Number(status);
    }
  }
  return { request_entries_seen: requestEntriesSeen, health_requests: healthRequests,
    webhook_requests: events.length, statuses: events.reduce((map, item) => {
    const key = String(item.status ?? 'unknown'); map[key] = (map[key] ?? 0) + 1; return map;
  }, {}), failures, failure_code_fields: failureCodeFields,
    failure_codes: codes, intent_diagnostics: intentDiagnostics.slice(-10), recent_events: events.slice(-20) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const child = spawnSync('yc', ['logging', 'read', '--group-name', 'default', '--resource-ids', containerId,
      '--since', since, '--until', until, '--limit', '2000', '--folder-id', folderId, '--format', 'json'], {
      encoding: 'utf8', timeout: 90_000, maxBuffer: 12 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    if (child.error || child.status !== 0) throw new Error(`Cloud Logging недоступен (код ${child.status ?? 'start'}); сырые журналы не выводятся.`);
    let result;
    try { result = JSON.parse(child.stdout); } catch { throw new Error('Cloud Logging вернул некорректный JSON.'); }
    const entries = Array.isArray(result) ? result : result.entries;
    if (!Array.isArray(entries)) throw new Error('Неизвестный формат ответа Cloud Logging.');
    console.log(JSON.stringify({ since, until, examined_entries: entries.length,
      potentially_truncated: entries.length === 2000, ...summarizeWebhookLogs(entries) }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Не удалось прочитать журналы.');
    process.exitCode = 1;
  }
}
