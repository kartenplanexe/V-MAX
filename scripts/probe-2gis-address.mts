import { LiveGeography, LocalityTokens } from '../src/server/live-geography.js';

const key = process.env.DGIS_PLACES_API_KEY;
if (!key) throw new Error('DGIS_PLACES_API_KEY is not set');

// One bounded request with an authored, non-personal address. No raw provider payload
// or credential is printed or persisted.
let httpStatus: number | null = null;
let transportError: string | null = null;
const probeFetch: typeof fetch = async (input, init) => {
  try { const response = await fetch(input, init); httpStatus = response.status; return response; }
  catch (error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    transportError = typeof code === 'string' ? code : 'TRANSPORT_ERROR';
    throw error;
  }
};
const geography = new LiveGeography(key, new LocalityTokens('probe-only'), probeFetch);
try {
  const choices = await geography.searchAddress('Тверская улица, 1', '4504222397630173');
  const result = { ok: choices.length > 0, city: 'Москва', address_choices: choices.length,
    all_with_coordinates: choices.every(choice => Number.isFinite(choice.point.lat) && Number.isFinite(choice.point.lon)),
    provider_payload_persisted: false, key_printed: false };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ ok: false, error: 'GEOGRAPHY_UNAVAILABLE', http_status: httpStatus,
    transport_error: transportError,
    hint: 'Проверьте VPN/доступ к 2ГИС и разрешения ключа для Places API.',
    provider_payload_persisted: false, key_printed: false }, null, 2));
  process.exitCode = 1;
}
