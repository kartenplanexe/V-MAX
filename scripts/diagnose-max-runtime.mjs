// Read-only runtime evidence: no raw messages, identities, tokens or URLs.
import { spawnSync } from 'node:child_process';
const since = new Date(Date.now() - 15 * 60_000).toISOString();
const child = spawnSync('yc', ['logging', 'read', '--group-name', 'default', '--resource-ids', 'bbapc7qgk242slpm2df5',
  '--since', since, '--until', new Date().toISOString(), '--limit', '500', '--folder-id', 'b1girskfbqdnh1mq580r', '--format', 'json'],
{ encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
if (child.error || child.status !== 0) {
  const reason = /PermissionDenied|Unauthenticated|Unavailable|DeadlineExceeded|ResourceExhausted|InvalidArgument/u.exec(child.stderr ?? '')?.[0] ?? 'UNKNOWN';
  console.error(JSON.stringify({ status: 'LOG_READ_FAILED', exitCode: child.status, signal: child.signal,
    processCode: /^[A-Z_]+$/u.test(child.error?.code ?? '') ? child.error.code : null, reason }));
  process.exit(1);
}
const parsed = JSON.parse(child.stdout), entries = Array.isArray(parsed) ? parsed : parsed.entries;
if (!Array.isArray(entries)) throw new Error('Unknown log format.');
const output = [], counts = {};
const permitted = new Set(['MAX chat update failed', 'MAX callback acknowledgement failed', 'MAX intent validation failed',
  'MAX planning step failed', 'MAX async worker failed',
  'Planning outcome summary', 'Planning expiry cleanup failed', 'Planning database initialization failed']);
for (const entry of entries) {
  let payload = entry.json_payload ?? entry.jsonPayload;
  if (!payload && typeof entry.message === 'string' && entry.message.startsWith('{')) {
    try { payload = JSON.parse(entry.message); } catch { continue; }
  }
  const kind = payload?.msg ?? payload?.message;
  if (permitted.has(kind)) output.push({ at: String(entry.timestamp ?? '').slice(0, 23), kind,
    code: typeof payload.code === 'string' && /^[A-Z_]{3,70}$/u.test(payload.code) ? payload.code : 'OTHER' });
  const status = payload?.res?.statusCode;
  if (Number.isInteger(status) && status >= 100 && status <= 599) counts[status] = (counts[status] ?? 0) + 1;
}
console.log(JSON.stringify({ since, entries: entries.length, possiblyTruncated: entries.length === 500, httpStatuses: counts, events: output.slice(-25) }, null, 2));
