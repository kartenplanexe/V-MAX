import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { config } from './config.js';
import { registerLiveRuntime } from './live-runtime.js';

it.skipIf(!process.env.TEST_DATABASE_URL)('starts authenticated manual and saved-route APIs without LLM credentials', async () => {
  const original = { ...config }, app = Fastify();

  const schema = `runtime_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const scoped = new URL(process.env.TEST_DATABASE_URL!); scoped.searchParams.set('options', `-c search_path=${schema}`);
  Object.assign(config, { databaseUrl: scoped.href, databaseCaPath: '', databaseCaPem: '',
    isProduction: false, databaseAllowLocalPlaintext: true, maxBotToken: 'synthetic-runtime-token',
    dgisPlacesApiKey: 'synthetic-places', dgisRoutingApiKey: 'synthetic-routing', dgisMapglApiKey: '',
    dgisBackupApiKey: '', dgisTertiaryApiKey: '', yandexApiKey: '', yandexFolderId: '' });
  const data = [['auth_date', String(Math.floor(Date.now() / 1000))], ['user', JSON.stringify({ id: 927027, first_name: 'Тест' })]];
  const secret = createHmac('sha256', 'WebAppData').update('synthetic-runtime-token').digest();
  const hash = createHmac('sha256', secret).update(data.map(pair => pair.join('=')).join('\n')).digest('hex');
  const headers = { 'x-max-init-data': String(new URLSearchParams([...data, ['hash', hash]])) };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await registerLiveRuntime(app);
    const bootstrap = await app.inject({ url: '/api/planning/bootstrap', headers });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toEqual({ view: null });
    expect(bootstrap.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ url: '/api/planning/saved', headers })).statusCode).toBe(200);
    for (const action of ['search', 'availability', 'select', 'recheck']) {
      const response = await app.inject({ method: 'POST', url: `/api/planning/drafts/missing/events/${action}`, payload: {} });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'AUTH_REQUIRED' });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    for (const suffix of ['options', 'requests']) {
      const response = await app.inject({ method: 'POST', url: `/api/planning/manual/${suffix}`, payload: {} });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'AUTH_REQUIRED' });
    }

    const invalidCity = await app.inject({ method: 'POST', url: '/api/planning/manual/options', headers,
      payload: { locality_token: 'synthetic-invalid-token' } });
    expect(invalidCity.statusCode).toBe(422);
    expect(invalidCity.json()).toEqual({ error: 'LOCALITY_SELECTION_EXPIRED' });
  } finally {
    await app.close(); Object.assign(config, original);
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); }
  }
});
