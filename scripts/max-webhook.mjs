import { createHash } from 'node:crypto';
import { loadEnvFile } from 'node:process';

try { loadEnvFile('.env.local'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const token = process.env.MAX_BOT_TOKEN?.trim();
if (!token) throw new Error('MAX_BOT_TOKEN is required in .env.local.');
const apply = process.argv.includes('--apply');
const urlArg = process.argv.find(arg => arg.startsWith('--url='));
const url = urlArg?.slice('--url='.length);
if (apply && (!url || !/^https:\/\/[^/]+\/api\/max\/webhook$/u.test(url)))
  throw new Error('Pass the exact HTTPS webhook URL: --url=https://HOST/api/max/webhook');

async function call(method, body) {
  const response = await fetch('https://platform-api2.max.ru/subscriptions', {
    method, headers: { Authorization: token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  const json = await response.json();
  if (!response.ok || json.success === false) throw new Error(`MAX subscriptions HTTP ${response.status}`);
  return json;
}

const current = await call('GET');
if (!Array.isArray(current.subscriptions)) throw new Error('Unexpected MAX subscriptions response.');
console.log(JSON.stringify({ count: current.subscriptions.length,
  subscriptions: current.subscriptions.map(item => ({ url: item.url, time: item.time,
    update_types: item.update_types })) }, null, 2));
if (!apply) process.exit(0);
if (current.subscriptions.length) {
  console.log('Subscription exists; no changes made. Inspect it before changing bot delivery.');
  process.exit(2);
}
const secret = createHash('sha256').update('v-max:webhook:v1:' + token).digest('hex');
const created = await call('POST', { url, secret,
  update_types: ['bot_started', 'message_created', 'message_callback'] });
if (created.success !== true) throw new Error('MAX did not confirm subscription creation.');
console.log('MAX_WEBHOOK_SUBSCRIBED: bot_started, message_created, message_callback. Secret is not printed.');
