import { expect, it } from 'vitest';
import { dgisDirectionsLink, dgisMultiStopLink } from './dgis-links.js';

it('hands coordinates and travel mode to the public 2GIS application without an API key', () => {
  expect(dgisDirectionsLink({ lon: 43.99, lat: 56.32 }, 'walking', { lon: 44, lat: 56.33 }))
    .toBe('https://2gis.ru/directions/tab/pedestrian/points/44,56.33|43.99,56.32');
  expect(dgisDirectionsLink({ lon: 43.99, lat: 56.32 }, 'public_transport'))
    .toBe('https://2gis.ru/directions/tab/bus/points/|43.99,56.32');
  expect(dgisDirectionsLink({ lon: 0, lat: 0 }, 'cycling')).toContain('/bicycle/');
});

it('passes every selected stop in order and keeps the return to the origin as a finish', () => {
  const stops = Array.from({ length: 6 }, (_, i) => ({ lon: 44 + i / 100, lat: 56.32 }));
  const origin = { lon: 43.99, lat: 56.33 };
  expect(dgisMultiStopLink(stops, 'walking', origin, origin)).toBe(
    'https://2gis.ru/directions/tab/pedestrian/points/43.99,56.33|44,56.32|44.01,56.32|44.02,56.32|44.03,56.32|44.04,56.32|44.05,56.32|43.99,56.33');
  expect(dgisMultiStopLink(stops, 'driving')).toContain('/car/points/|44,56.32|44.01,56.32');
});

it('refuses incomplete, invalid or excessive routes instead of silently dropping stops', () => {
  const point = { lon: 44, lat: 56 };
  expect(dgisMultiStopLink([])).toBeNull();
  expect(dgisMultiStopLink([point, undefined, point])).toBeNull();
  expect(dgisMultiStopLink([point, { lon: 181, lat: 56 }])).toBeNull();
  expect(dgisMultiStopLink([point], 'walking', point, { lon: 0, lat: NaN })).toBeNull();
  expect(dgisMultiStopLink([point], 'toString')).toBeNull();
  expect(dgisDirectionsLink(point, 'constructor')).toBeNull();
  expect(dgisMultiStopLink(Array(11).fill(point), 'cycling', point)).not.toBeNull();
  expect(dgisMultiStopLink(Array(12).fill(point), 'cycling', point)).toBeNull();
  expect(dgisMultiStopLink(Array(11).fill(point), 'cycling', point, point)).toBeNull();
});
it('never emits routes for missing, invalid coordinates or unsupported transport', () => {
  expect(dgisDirectionsLink(undefined)).toBeNull();
  expect(dgisDirectionsLink({ lon: Infinity, lat: 0 })).toBeNull();
  expect(dgisDirectionsLink({ lon: 0, lat: 91 })).toBeNull();
  expect(dgisDirectionsLink({ lon: 0, lat: 0 }, 'walking', { lon: NaN, lat: 0 })).toBeNull();
  expect(dgisDirectionsLink({ lon: 0, lat: 0 }, 'unknown')).toBeNull();
});
