// Read-only, allowlisted 2GIS catalog diagnostics. Never prints keys, URLs,
// provider bodies, user requests or raw cloud log entries.
import { spawnSync } from 'node:child_process';

const sinceArg = process.argv.find(arg => arg.startsWith('--since='));
const showShape = process.argv.includes('--shape');
const since = sinceArg?.slice('--since='.length) ?? new Date(Date.now() - 15 * 60_000).toISOString();
if (process.argv.slice(2).some(arg => arg !== '--shape' && arg !== sinceArg) ||
    !Number.isFinite(Date.parse(since)) || Date.parse(since) > Date.now() ||
    Date.now() - Date.parse(since) > 86_400_000)
  throw new Error('Usage: node scripts/diagnose-2gis-catalog.mjs [--since=UTC_ISO_TIME]');

const child = spawnSync('yc', ['logging', 'read', '--group-name', 'default', '--resource-ids', 'bbapc7qgk242slpm2df5',
  '--since', since, '--until', new Date().toISOString(), '--limit', '500', '--folder-id', 'b1girskfbqdnh1mq580r',
  '--format', 'json'], { encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
if (child.error || child.status !== 0) throw new Error('Cloud Logging недоступен; сырые журналы не выводятся.');
const parsed = JSON.parse(child.stdout);
const entries = Array.isArray(parsed) ? parsed : parsed.entries;
if (!Array.isArray(entries)) throw new Error('Неизвестный формат журнала.');
const events = [];
for (const entry of entries) {
  let payload = entry.json_payload ?? entry.jsonPayload;
  if (!payload && typeof entry.message === 'string' && entry.message.startsWith('{')) {
    try { payload = JSON.parse(entry.message); } catch { continue; }
  }
  if (!payload || typeof payload !== 'object') continue;
  const message = payload.msg ?? payload.message ?? entry.message;
  if (message === '2GIS catalog request outcome') {
    events.push({ at: String(entry.timestamp ?? '').slice(0, 23), kind: 'request',
      key_role: ['primary', 'backup'].includes(payload.key_role) ? payload.key_role : 'UNKNOWN',
      http_status: Number.isSafeInteger(payload.http_status) ? payload.http_status : null,
      provider_code: Number.isSafeInteger(payload.provider_code) ? payload.provider_code : null,
      fallback_eligible: payload.fallback_eligible === true || payload.quota_detected === true,
      transport_error: ['AbortError', 'TimeoutError', 'TypeError', 'OTHER'].includes(payload.transport_error)
        ? payload.transport_error : null });
  } else if (message === '2GIS catalog validation outcome') {
    events.push({ at: String(entry.timestamp ?? '').slice(0, 23), kind: 'validation',
      error_code: typeof payload.error_code === 'string' && /^[A-Z_]{2,50}$/u.test(payload.error_code)
        ? payload.error_code : 'UNKNOWN' });
  }
}
const shapes = showShape ? entries.slice(-12).map(entry => ({
  at: String(entry.timestamp ?? '').slice(0, 23),
  entry_keys: Object.keys(entry).sort(),
  json_payload_keys: entry.json_payload && typeof entry.json_payload === 'object'
    ? Object.keys(entry.json_payload).sort() : [],
  message_kind: typeof entry.message === 'string'
    ? entry.message.startsWith('{') ? 'JSON_TEXT' : 'TEXT' : typeof entry.message,
})) : undefined;
console.log(JSON.stringify({ since, examined_entries: entries.length, potentially_truncated: entries.length === 500,
  events: events.slice(-20), ...(shapes ? { shapes } : {}) }, null, 2));
