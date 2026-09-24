import { expect, it } from 'vitest';
import { YandexIntentClient } from './yandex-intent.js';

it('uses Flash structured output, omits retention, and enforces a process-wide call cap', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new YandexIntentClient({ apiKey: 'not-a-real-key', folderId: 'test-folder', maxCalls: 1, maxEstimatedRub: 8,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: '{"action":"off_topic"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }); } });
  expect(await client.generate({ model: 'ignored', messages: [], response_format: { type: 'json_schema' } })).toEqual({ action: 'off_topic' });
  expect(calls[0]!.url).toBe('https://ai.api.cloud.yandex.net/v1/chat/completions');
  expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ model: 'gpt://test-folder/aliceai-llm-flash', store: false, max_tokens: 4096 });
  await expect(client.generate({})).rejects.toMatchObject({ code: 'INTENT_RUN_LIMIT' });
  expect(calls).toHaveLength(1);
});
it('does not retry or expose upstream details, and rejects truncated JSON', async () => {
  let calls = 0;
  const client = new YandexIntentClient({ apiKey: 'secret', folderId: 'folder', maxCalls: 2, maxEstimatedRub: 16,
    fetchImpl: async () => { calls++; return new Response('secret upstream detail', { status: 401 }); } });
  await expect(client.generate({})).rejects.toMatchObject({ code: 'INTENT_PROVIDER_FAILED', message: 'INTENT_PROVIDER_FAILED' });
  expect(calls).toBe(1);
  const truncated = new YandexIntentClient({ apiKey: 'secret', folderId: 'folder', maxCalls: 1, maxEstimatedRub: 8,
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"valid":"json"}' } }] }) });
  await expect(truncated.generate({})).rejects.toMatchObject({ code: 'INTENT_TRUNCATED' });
});
