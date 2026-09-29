export interface PublicConfig {
  planning?: { routingMode: 'external' | 'verified' };
  maps: {
    enabled: boolean;
    mapglKey?: string;
    provider: '2gis';
  };
}
