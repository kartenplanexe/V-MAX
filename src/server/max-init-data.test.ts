import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { validateMaxInitData } from './max-init-data.js';

const token = 'test-token-never-use-in-production';
const nowSeconds = 1_800_000_000;

function sign(parameters: Record<string, string>) {
  const entries = Object.entries(parameters).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const checkString = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secretKey).update(checkString).digest('hex');
  return new URLSearchParams([...entries, ['hash', hash]]).toString();
}

function validData(authDate = nowSeconds) {
  return sign({
    auth_date: String(authDate),
    query_id: 'test-query',
    user: JSON.stringify({
      first_name: 'Анна',
      id: 42,
      language_code: 'ru',
      last_name: 'Иванова',
      photo_url: null,
      username: 'anna',
    }),
  });
}

describe('validateMaxInitData', () => {
  it('accepts a correctly signed fresh payload', () => {
    const result = validateMaxInitData(validData(), token, { maxAgeSeconds: 3600, nowSeconds });

    expect(result).toMatchObject({
      authDate: nowSeconds,
      ok: true,
      user: { first_name: 'Анна', id: 42 },
    });
  });

  it('rejects a payload changed after signing', () => {
    const changed = validData().replace('test-query', 'other-query');

    expect(validateMaxInitData(changed, token, { maxAgeSeconds: 3600, nowSeconds })).toEqual({
      ok: false,
      reason: 'invalid_hash',
    });
  });

  it('rejects duplicate parameters', () => {
    const duplicated = `${validData()}&hash=${'0'.repeat(64)}`;

    expect(validateMaxInitData(duplicated, token, { maxAgeSeconds: 3600, nowSeconds })).toEqual({
      ok: false,
      reason: 'duplicate_parameter',
    });
  });

  it('rejects expired init data', () => {
    const result = validateMaxInitData(validData(nowSeconds - 3601), token, {
      maxAgeSeconds: 3600,
      nowSeconds,
    });

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects init data issued too far in the future', () => {
    const result = validateMaxInitData(validData(nowSeconds + 31), token, {
      maxAgeSeconds: 3600,
      nowSeconds,
    });

    expect(result).toEqual({ ok: false, reason: 'future_auth_date' });
  });
});
