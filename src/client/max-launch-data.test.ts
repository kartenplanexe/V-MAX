import { describe, expect, it, vi } from 'vitest';
import { readMaxLaunchData, waitForMaxLaunchData } from './max-launch-data.js';

describe('MAX launch data', () => {
  it('uses signed bridge data and falls back to the signed URL fragment', () => {
    expect(readMaxLaunchData('auth_date=1&hash=bridge', '#WebAppData=auth_date%3D2%26hash%3Durl'))
      .toBe('auth_date=1&hash=bridge');
    expect(readMaxLaunchData(undefined, '#WebAppData=auth_date%3D2%26hash%3Durl'))
      .toBe('auth_date=2&hash=url');
    expect(readMaxLaunchData(undefined, '#other=value')).toBe('');
  });

  it('allows a briefly delayed bridge, then stops waiting', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const found = waitForMaxLaunchData(() => ++reads === 3 ? 'signed-data' : '');
      await vi.runAllTimersAsync();
      expect(await found).toBe('signed-data');
      expect(reads).toBe(3);

      const missing = waitForMaxLaunchData(() => '', 2);
      await vi.runAllTimersAsync();
      expect(await missing).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});
