import { expect, it } from 'vitest';
import { DgisKeyFallback, shouldTryDgisBackup } from './dgis-key-fallback.js';

it('tries a backup for provider key denials even with HTTP 200, not malformed requests or 5xx', () => {
  expect(shouldTryDgisBackup(429, null)).toBe(true);
  expect(shouldTryDgisBackup(200, { meta: { code: 403 } })).toBe(true);
  expect(shouldTryDgisBackup(403, { meta: { code: 403, error: { type: 'invalidKey' } } })).toBe(true);
  expect(shouldTryDgisBackup(402, null)).toBe(true);
  expect(shouldTryDgisBackup(400, { meta: { code: 400, error: { message: 'page_size invalid' } } })).toBe(false);
  expect(shouldTryDgisBackup(503, { meta: { code: 503 } })).toBe(false);
});

it('switches only the limited service and periodically rechecks the primary', () => {
  let now = 0;
  const keys = new DgisKeyFallback('primary', 'backup', () => now);
  expect(keys.current('categories')).toBe('primary');
  expect(keys.backupAfterDenial('categories', 'primary')).toBe('backup');
  expect(keys.current('categories')).toBe('backup');
  expect(keys.current('places')).toBe('primary');
  expect(keys.backupAfterDenial('categories', 'backup')).toBeNull();
  now = 600_001;
  expect(keys.current('categories')).toBe('primary');
  expect(new DgisKeyFallback('same', 'same').backupAfterDenial('places', 'same')).toBeNull();
});
