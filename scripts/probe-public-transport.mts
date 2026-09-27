/** One synthetic public-coordinate pair; real provider, at most 3 key attempts.
 * No MAX messages, user data, database writes or stored provider payloads. */
import { DgisClient, DgisRequestBudgetError, DgisProviderError } from '../src/server/dgis.js';

if (!process.argv.includes('--run')) {
  console.log('Use --run for one dated live public-transport pair (at most 3 physical requests).');
  process.exit(0);
}
const setting = (name: string) => process.env[name]?.trim() ?? '';
if (!setting('DGIS_ROUTING_API_KEY')) throw Error('DGIS_ROUTING_API_KEY is required');
let attempts = 0;
const diagnosticFetch: typeof fetch = async (url, options) => {
  try {
    const response = await fetch(url, options);
    console.log(JSON.stringify({ kind: 'transport_http', status: response.status }));
    return response;
  } catch (error) {
    const cause = error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause
      ? String(error.cause.code) : error instanceof Error ? error.name : 'UNKNOWN';
    console.log(JSON.stringify({ kind: 'transport_failure', code: /^[A-Z_a-z0-9]{2,80}$/u.test(cause) ? cause : 'OTHER' }));
    throw error;
  }
};
const client = new DgisClient({ placesApiKey: setting('DGIS_PLACES_API_KEY'), routingApiKey: setting('DGIS_ROUTING_API_KEY'),
  backupApiKey: setting('DGIS_BACKUP_API_KEY'), tertiaryApiKey: setting('DGIS_TERTIARY_API_KEY'), fetchImpl: diagnosticFetch });
try {
  const result = await client.buildPublicTransportRoute({ from: { lat: 56.3287, lon: 44.0020 },
    to: { lat: 56.3226, lon: 43.9456 }, departureUtc: Math.floor(Date.now() / 1000) + 3600,
    requestBudget: { consume() { if (attempts >= 3) throw new DgisRequestBudgetError(); attempts++; } } });
  console.log(JSON.stringify({ kind: 'public_transport_probe', at: new Date().toISOString(), attempts,
    route: Boolean(result), ...(result ? { duration_seconds: result.durationSeconds, distance_meters: result.distanceMeters,
      geometry_parts: result.geometry?.length ?? 0, pedestrian: result.transit.pedestrian,
      stages: result.transit.stages.length, schedule_evidence: result.transit.scheduleEvidence } : {}) }));
  if (!result) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ kind: 'public_transport_probe', at: new Date().toISOString(), attempts,
    error: error instanceof DgisProviderError ? 'PROVIDER_FAILED' : error instanceof DgisRequestBudgetError ? error.code : 'PROBE_FAILED' }));
  process.exitCode = 1;
}
