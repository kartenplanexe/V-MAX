import { expect, it } from 'vitest';
import { maxWorkerSecret, validMaxWorkerSecret, yandexMaxDispatcher } from './max-async.js';
import { maxWebhookSecret, minimalMaxUpdate } from './max-chat.js';

it('accepts only a managed 202 and confines dispatch to the configured cloud origin', async () => {
  let sent: RequestInit | undefined;
  const dispatch = yandexMaxDispatcher('https://example.containers.yandexcloud.net/', 'synthetic-token',
    async (_url, init) => { sent = init; return new Response(null, { status: 202 }); });
  await dispatch({ update_type: 'bot_started' });
  expect(sent?.redirect).toBe('error');
  expect(new Headers(sent?.headers).get('X-Ycf-Container-Integration-Type')).toBe('async');
  expect(new Headers(sent?.headers).get('X-Vmax-Worker-Secret')).toBe(maxWorkerSecret('synthetic-token'));
  const wrongStatus = yandexMaxDispatcher('https://example.containers.yandexcloud.net/', 'synthetic-token',
    async () => new Response(null, { status: 200 }));
  await expect(wrongStatus({})).rejects.toThrow('MAX_ASYNC_DISPATCH_FAILED');
  expect(() => yandexMaxDispatcher('http://localhost/', 'synthetic-token')).toThrow();
  expect(() => yandexMaxDispatcher('https://example.containers.yandexcloud.net.evil.test/', 'synthetic-token')).toThrow();
  expect(validMaxWorkerSecret(maxWebhookSecret('synthetic-token'), 'synthetic-token')).toBe(false);
});

it('drops unrelated MAX profile and attachment data while retaining the minimal event identity', () => {
  const projected = minimalMaxUpdate({ update_type: 'message_created', ignored: 'private-extra', message: {
    sender: { user_id: 123, first_name: 'private-extra', photo_url: 'private-extra' },
    recipient: { chat_type: 'dialog', chat_id: 456 }, body: { mid: 'test-message', text: '  прогулка  ',
      attachments: [{ type: 'photo', payload: 'private-extra' }, { type: 'location', latitude: 55.75, longitude: 37.61 }] } } });
  expect(JSON.stringify(projected)).not.toContain('private-extra');
  expect(projected).toMatchObject({ message: { sender: { user_id: 123 }, body: { mid: 'test-message', text: 'прогулка',
    attachments: [{ type: 'location', latitude: 55.75, longitude: 37.61 }] } } });
  expect(minimalMaxUpdate({ update_type: 'unknown' })).toBeNull();
});
