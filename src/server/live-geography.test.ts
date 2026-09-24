import { expect, it } from 'vitest';
import { boundsFromWkt, LocalityTokens, visitPolicy } from './live-geography.js';
it('binds locality tokens to signed evidence and expiry', () => {
  let now = 1000; const signer = new LocalityTokens('test-key', () => now);
  const locality = { id: '1', region_id: '32', name: 'Москва', timezone: 'Europe/Moscow',
    center: { lat: 55.75, lon: 37.62 }, area: { south: 55, north: 56, west: 37, east: 38 } };
  const token = signer.sign(locality);
  expect(signer.verify(token)).toEqual(locality);
  expect(() => signer.verify(token.slice(0, -5) + 'xxxxx')).toThrow();
  now += 1_800_001; expect(() => signer.verify(token)).toThrow();
});
it('parses provider bounds and does not invent durations for unsupported categories', () => {
  expect(boundsFromWkt('POLYGON((37 55,38 55,38 56,37 56,37 55))')).toEqual({ west: 37, east: 38, south: 55, north: 56 });
  expect(() => boundsFromWkt('wrong')).toThrow();
  expect(visitPolicy([{ id: '10', name: 'Музеи' }, { id: '11', name: 'Кафе' }, { id: '12', name: 'Банки' }]).by_category)
    .toEqual({ '10': 90, '11': 60 });
});
