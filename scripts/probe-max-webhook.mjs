// Safe live probe: no real MAX update and no messages to users.
import { createHash } from 'node:crypto';
import { loadEnvFile } from 'node:process';

try { loadEnvFile('.env.local'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const token = process.env.MAX_BOT_TOKEN?.trim();
if (!token) throw new Error('MAX_BOT_TOKEN is required in .env.local.');
const base = 'https://bbapc7qgk242slpm2df5.containers.yandexcloud.net';
const secret = createHash('sha256').update('v-max:webhook:v1:' + token).digest('hex');

async function check(path, init = {}) {
  try {
    const response = await fetch(base + path, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    let status = null;
    try { status = (await response.json()).status ?? null; } catch { /* No body needed. */ }
    return { http_status: response.status, status };
  } catch (error) {
    const cause = error?.cause?.code;
    const known = ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'];
    return { error: error?.name === 'TimeoutError' ? 'TIMEOUT' : known.includes(cause) ? cause : 'NETWORK_ERROR' };
  }
}

const health = await check('/api/health');
if (health.http_status !== 200) {
  console.log(JSON.stringify({ health, webhook: 'not_checked' }, null, 2));
  process.exitCode = 1;
} else {
  const payload = JSON.stringify({ update_type: 'diagnostic_ignored', timestamp: Date.now() });
  const unauthenticated = await check('/api/max/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: payload });
  const authenticated = await check('/api/max/webhook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Max-Bot-Api-Secret': secret }, body: payload });
  const ok = unauthenticated.http_status === 401 && authenticated.http_status === 200 && authenticated.status === 'ignored';
  console.log(JSON.stringify({ health, webhook: { unauthenticated, authenticated }, ok }, null, 2));
  if (!ok) process.exitCode = 1;
}
