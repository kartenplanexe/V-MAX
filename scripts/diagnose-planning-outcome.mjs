// Read-only summary of server-side planner failures. Never prints raw log entries,
// user text, coordinates, provider payloads or credentials.
import { spawnSync } from 'node:child_process';

const since = process.argv.find(arg => arg.startsWith('--since='))?.slice('--since='.length)
  ?? new Date(Date.now() - 30 * 60_000).toISOString();
if (!Number.isFinite(Date.parse(since)) || Date.parse(since) > Date.now() || Date.now() - Date.parse(since) > 86_400_000)
  throw new Error('Use --since=UTC_ISO_TIME within the last day.');
const child = spawnSync('yc', ['logging', 'read', '--group-name', 'default', '--resource-ids', 'bbapc7qgk242slpm2df5',
  '--since', since, '--until', new Date().toISOString(), '--limit', '500', '--folder-id', 'b1girskfbqdnh1mq580r',
  '--format', 'json'], { encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
if (child.error || child.status !== 0) throw new Error('Cloud Logging недоступен; сырые журналы не выводятся.');
const parsed = JSON.parse(child.stdout);
const entries = Array.isArray(parsed) ? parsed : parsed.entries;
if (!Array.isArray(entries)) throw new Error('Неизвестный формат журнала.');
const safeInt = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const found = [];
for (const entry of entries) {
  let payload = entry.json_payload ?? entry.jsonPayload;
  if (!payload && typeof entry.message === 'string' && entry.message.startsWith('{')) {
    try { payload = JSON.parse(entry.message); } catch { continue; }
  }
  if (!payload || (payload.msg ?? payload.message ?? entry.message) !== 'Planning outcome summary') continue;
  const counts = {};
  for (const [reason, count] of Object.entries(payload.exclusion_reasons ?? {}))
    if (/^[A-Z_]{2,50}$/u.test(reason)) counts[reason] = safeInt(count);
  found.push({ at: String(entry.timestamp ?? '').slice(0, 23),
    status: ['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'ERROR', 'NEEDS_INPUT'].includes(payload.status) ? payload.status : 'UNKNOWN',
    places_http_calls: safeInt(payload.places_http_calls), routing_http_calls: safeInt(payload.routing_http_calls),
    places_received: safeInt(payload.places_received), places_failed_queries: safeInt(payload.places_failed_queries),
    places_http_4xx: safeInt(payload.places_http_4xx), places_http_5xx: safeInt(payload.places_http_5xx),
    places_transport_failures: safeInt(payload.places_transport_failures),
    places_provider_4xx: safeInt(payload.places_provider_4xx),
    places_schema_failures: safeInt(payload.places_schema_failures),
    places_max_rubric_ids: safeInt(payload.places_max_rubric_ids),
    places_failure_codes: Object.fromEntries(Object.entries(payload.places_failure_codes ?? {}).filter(([key, value]) =>
      /^(?:HTTP|PROVIDER)_\d{3}(?:_[A-Z_]+)?$|^SCHEMA_[A-Z0-9_]+$|^(?:TRANSPORT|INVALID_PROVIDER_RESPONSE)$/u.test(key) &&
      Number.isSafeInteger(value) && value >= 0)),
    routing_failed_batches: safeInt(payload.routing_failed_batches), eligible_options: safeInt(payload.eligible_options),
    shortlisted_options: safeInt(payload.shortlisted_options), excluded_options: safeInt(payload.excluded_options),
    exclusion_reasons: counts, verified_visits: safeInt(payload.verified_visits) });
}
console.log(JSON.stringify({ since, examined_entries: entries.length, potentially_truncated: entries.length === 500,
  outcomes: found.slice(-10) }, null, 2));
