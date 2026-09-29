import { describe, expect, it } from 'vitest';

import { selectPublicMapglKey } from './public-config.js';

describe('selectPublicMapglKey', () => {
  it('allows a shared production demo key only with explicit opt-in', () => {
    const input = {
      mapglApiKey: 'shared-demo-key',
      placesApiKey: 'shared-demo-key',
      routingApiKey: 'shared-demo-key',
    };

    expect(selectPublicMapglKey({ ...input, isProduction: false })).toBe('shared-demo-key');
    expect(selectPublicMapglKey({ ...input, isProduction: true })).toBe('');
    expect(selectPublicMapglKey({ ...input, isProduction: true, allowSharedDemoKey: true })).toBe('shared-demo-key');
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
  it.each(['backupApiKey', 'tertiaryApiKey'])('does not publish a %s used by server fallbacks', field => {
    expect(selectPublicMapglKey({ isProduction: true, mapglApiKey: 'public-key', placesApiKey: 'main',
      routingApiKey: 'main', [field]: ' public-key ' })).toBe('');
  });
});
