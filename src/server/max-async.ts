import { createHash, timingSafeEqual } from 'node:crypto';

export const maxWorkerSecret = (token: string) => createHash('sha256').update('v-max:async-worker:v1:' + token).digest('hex');
export function validMaxWorkerSecret(actual: unknown, token: string) {
  if (!token || typeof actual !== 'string') return false;
  const supplied = Buffer.from(actual), expected = Buffer.from(maxWorkerSecret(token));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// Transfer ownership to the managed queue before replying; serverless may freeze afterward.
export function yandexMaxDispatcher(baseUrl: string, token: string, http: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || !/^[a-z0-9]+\.containers\.yandexcloud\.net$/.test(base.hostname) ||
      base.username || base.password || base.port || base.pathname !== '/' || base.search || base.hash || !token)
    throw new Error('Invalid MAX async destination');
  const target = new URL('/api/max/worker', base);
  return async (update: unknown) => {
    const response = await http(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'X-Ycf-Container-Integration-Type': 'async',
        'X-Vmax-Worker-Secret': maxWorkerSecret(token) }, body: JSON.stringify(update) });
    await response.body?.cancel();
    if (response.status !== 202) throw new Error('MAX_ASYNC_DISPATCH_FAILED');
  };
}
