import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

const MaxUserSchema = z.object({
  first_name: z.string().min(1).max(256),
  id: z.number().int().positive(),
  language_code: z.string().min(2).max(32).optional(),
  last_name: z.string().max(256).nullish(),
  photo_url: z.string().url().nullish(),
  username: z.string().max(256).nullish(),
});

export type MaxInitDataFailureReason =
  | 'empty'
  | 'too_large'
  | 'duplicate_parameter'
  | 'missing_hash'
  | 'invalid_hash'
  | 'invalid_auth_date'
  | 'expired'
  | 'future_auth_date'
  | 'invalid_user';

export type MaxInitDataValidation =
  | {
      ok: true;
      authDate: number;
      user: z.infer<typeof MaxUserSchema>;
    }
  | {
      ok: false;
      reason: MaxInitDataFailureReason;
    };

interface ValidationOptions {
  maxAgeSeconds: number;
  nowSeconds?: number;
}

const MAX_INIT_DATA_BYTES = 16 * 1024;
const FUTURE_CLOCK_SKEW_SECONDS = 30;

function fail(reason: MaxInitDataFailureReason): MaxInitDataValidation {
  return { ok: false, reason };
}

export function validateMaxInitData(
  initData: string,
  botToken: string,
  options: ValidationOptions,
): MaxInitDataValidation {
  if (!initData) return fail('empty');
  if (Buffer.byteLength(initData, 'utf8') > MAX_INIT_DATA_BYTES) return fail('too_large');

  const entries = [...new URLSearchParams(initData).entries()];
  const counts = new Map<string, number>();
  for (const [key] of entries) counts.set(key, (counts.get(key) ?? 0) + 1);
  if ([...counts.values()].some((count) => count !== 1)) return fail('duplicate_parameter');

  const originalHash = entries.find(([key]) => key === 'hash')?.[1];
  if (!originalHash) return fail('missing_hash');
  if (!/^[a-f0-9]{64}$/iu.test(originalHash)) return fail('invalid_hash');

  const dataCheckString = entries
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest();
  const suppliedHash = Buffer.from(originalHash, 'hex');
  if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
    return fail('invalid_hash');
  }

  const authDate = Number(entries.find(([key]) => key === 'auth_date')?.[1]);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return fail('invalid_auth_date');

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (authDate > nowSeconds + FUTURE_CLOCK_SKEW_SECONDS) return fail('future_auth_date');
  if (nowSeconds - authDate > options.maxAgeSeconds) return fail('expired');

  const rawUser = entries.find(([key]) => key === 'user')?.[1];
  if (!rawUser) return fail('invalid_user');

  try {
    const user = MaxUserSchema.parse(JSON.parse(rawUser));
    return { authDate, ok: true, user };
  } catch {
    return fail('invalid_user');
  }
}
