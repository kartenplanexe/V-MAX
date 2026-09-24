import { describe, expect, it } from 'vitest';

import { selectPublicMapglKey } from './public-config.js';

describe('selectPublicMapglKey', () => {
  it('allows a shared demo key only outside production', () => {
    const input = {
      mapglApiKey: 'shared-demo-key',
      placesApiKey: 'shared-demo-key',
      routingApiKey: 'shared-demo-key',
    };

    expect(selectPublicMapglKey({ ...input, isProduction: false })).toBe('shared-demo-key');
    expect(selectPublicMapglKey({ ...input, isProduction: true })).toBe('');
  });

  it('allows a distinct production MapGL key', () => {
    expect(
      selectPublicMapglKey({
        isProduction: true,
        mapglApiKey: 'public-map-key',
        placesApiKey: 'server-places-key',
        routingApiKey: 'server-routing-key',
      }),
    ).toBe('public-map-key');
  });
});
