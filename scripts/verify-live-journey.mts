/** Explicit live acceptance probe. Synthetic requests, real providers and solver.
 * No MAX messages, persisted provider payloads or browser auth. Shared quota DB writes only.
 * Run: node --env-file=.env.local --use-system-ca --import tsx scripts/verify-live-journey.mts --run
 */
import { randomUUID } from 'node:crypto';
import { LiveGeography, LocalityTokens } from '../src/server/live-geography.js';
import { InitialIntentError, parseInitialIntent } from '../src/server/intent-start.js';
import { YandexIntentClient } from '../src/server/yandex-intent.js';
import { DgisClient } from '../src/server/dgis.js';
import { PlanningSessions } from '../src/server/planning-sessions.js';
import { planPlacesWithDgis, safePlanningDiagnostic } from '../src/server/place-planning.js';
import { extractionFidelityErrors, liveJourneyCases, simulatedJourneyChanges } from './live-journey-fidelity.mts';
import { liveProbeQuota } from './live-routing-quota.mts';

if (!process.argv.includes('--run')) {
  console.log('Explicit --run required: 4 synthetic journeys through live 2GIS/Alice; at most 8 LLM calls, 10 Routing objects per plan with shared DB quota. Add --parse-only for extraction only. No MAX messages; only quota DB writes.');
  process.exit(0);
}
const parseOnly = process.argv.includes('--parse-only');
const env = (name: string) => process.env[name]?.trim() ?? '';
for (const name of ['DGIS_PLACES_API_KEY', 'YANDEX_API_KEY', 'YANDEX_FOLDER_ID', ...(!parseOnly ? ['DGIS_ROUTING_API_KEY'] : [])])
  if (!env(name)) throw new Error(`Missing setting: ${name}`);
const diagnosticFetch: typeof fetch = async (url, options) => {
  try {
    const response = await fetch(url, options);
    if (!response.ok) console.log(JSON.stringify({ transport: 'provider_http', status: response.status }));
    return response;
  } catch (error) {
    const cause = error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause
      ? String(error.cause.code) : error instanceof Error ? error.name : 'UNKNOWN';
    console.log(JSON.stringify({ transport: 'provider_failed', code: /^[A-Z_a-z0-9]{2,80}$/u.test(cause) ? cause : 'OTHER' }));
    throw error;
  }
};
const geography = new LiveGeography(env('DGIS_PLACES_API_KEY'), new LocalityTokens(randomUUID()), diagnosticFetch,
  env('DGIS_BACKUP_API_KEY'), env('DGIS_TERTIARY_API_KEY'));
let failed = false;
const quota = liveProbeQuota();
try {
  const choices = await geography.search('Нижний Новгород');
  const selected = choices.find(choice => choice.name === 'Нижний Новгород');
  if (!selected) throw new InitialIntentError('TEST_LOCALITY_NOT_FOUND');
  for (const [index, scenario] of liveJourneyCases.entries()) {
    let llmCalls = 0;
    const started = performance.now();
    try {
      const context = await geography.context(selected.token);
      const provider = new YandexIntentClient({ apiKey: env('YANDEX_API_KEY'), folderId: env('YANDEX_FOLDER_ID'),
        maxCalls: 2, maxEstimatedRub: 14.76, fetchImpl: diagnosticFetch });
      const initial = await parseInitialIntent({ ...context, userText: scenario.text, inputId: randomUUID() }, request => {
        llmCalls++; return provider.generate(request);
      });
      if (initial.status !== 'draft') throw new InitialIntentError('TEST_EXPECTED_DRAFT');
      const extracted = initial.draft.days.map(day => ({ date: day.date, window: day.window ?? null,
        activities: day.activities.map(activity => ({ intent_kind: activity.intent_kind,
          category_count: activity.intent_kind === 'event_visit' ? 0 : activity.categories.include_any.length })),
        order_count: day.order.length,
        origins: { date: initial.provenance[`days.${day.day_id}.date`] ?? null,
          start: initial.provenance[`days.${day.day_id}.window.start`] ?? null,
          end: initial.provenance[`days.${day.day_id}.window.end`] ?? null } }));
      const fidelityErrors = extractionFidelityErrors(initial, scenario, context, context.planning.catalog.category_names);
      if (fidelityErrors.length) {
        console.log(JSON.stringify({ case: index + 1, stage: 'extraction_fidelity', status: 'FAIL',
          extracted, errors: fidelityErrors, llm_calls: llmCalls })); failed = true; continue;
      }
      console.log(JSON.stringify({ case: index + 1, stage: 'extraction_fidelity', status: 'PASS', extracted,
        llm_calls: llmCalls, seconds: Math.round((performance.now() - started) / 100) / 10 }));
      if (parseOnly) continue;
      const client = new DgisClient({ placesApiKey: env('DGIS_PLACES_API_KEY'), routingApiKey: env('DGIS_ROUTING_API_KEY'),
        backupApiKey: env('DGIS_BACKUP_API_KEY'), tertiaryApiKey: env('DGIS_TERTIARY_API_KEY'), fetchImpl: diagnosticFetch });
      let diagnostic: unknown;
      const sessions = new PlanningSessions({ plan: async job => {
        const result = await planPlacesWithDgis(client, job, { retrieval: { radiusMeters: 5000, pageSize: 5, maxPages: 5, maxRequests: 30 },
          maxRoutePairs: 10, maxRoutingHttpCalls: 30, dataMode: 'live', routingStrategy: 'progressive',
          consumeRoutingQuota: (objects, remaining) => quota.consume(objects, remaining) });
        diagnostic = safePlanningDiagnostic(result); return result;
      } });
      const owner = 'synthetic-live-acceptance';
      let view = sessions.create(owner, initial.draft, context.planning, initial.provenance);
      view = sessions.edit(owner, view.id, { base_version: view.version, event_id: randomUUID(),
        changes: simulatedJourneyChanges(initial, scenario, context, selected.center) });
      if (view.issues.length) {
        console.log(JSON.stringify({ case: index + 1, stage: 'clarification', extracted,
          issues: view.issues.map(issue => issue.code), llm_calls: llmCalls })); failed = true; continue;
      }
      view = sessions.confirm(owner, view.id, { base_version: view.version, event_id: randomUUID() });
      view = await sessions.calculate(owner, view.id, { base_version: view.version, event_id: randomUUID() });
      console.log(JSON.stringify({ case: index + 1, extracted, status: view.result?.status,
        warnings: view.result?.warnings, search_scope: view.result?.search_scope, llm_calls: llmCalls,
        seconds: Math.round((performance.now() - started) / 100) / 10, diagnostic,
        days: view.result?.days.map(day => ({ status: day.status, missing_count: day.missing_activity_ids.length,
          visits: day.visits.map(visit => ({ name: visit.name, starts_at: visit.starts_at, ends_at: visit.ends_at,
            travel_minutes: visit.travel_before_minutes, distance_meters: visit.distance_before_meters, warnings: visit.warnings })) })) }));
      if (!view.result || (scenario.route === 'available' ? !['AVAILABLE', 'LIMITED'].includes(view.result.status)
        || !view.result.days.some(day => day.visits.length)
        : !['LIMITED', 'UNAVAILABLE'].includes(view.result.status)
          || !view.result.days.some(day => day.missing_activity_ids.length))) failed = true;
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'PROBE_FAILED';
      console.log(JSON.stringify({ case: index + 1, error: code,
        ...(error instanceof InitialIntentError ? { diagnostic: error.diagnostic } : {}), llm_calls: llmCalls })); failed = true;
    }
  }
} catch (error) {
  console.log(JSON.stringify({ stage: 'setup', error: error instanceof InitialIntentError ? error.code : 'PROBE_SETUP_FAILED' }));
  failed = true;
}
await quota.close();
process.exitCode = failed ? 1 : 0;
