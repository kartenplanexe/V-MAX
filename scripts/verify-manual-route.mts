/** Real manual-input -> Places -> Routing -> solver diagnostic, independent of LLM.
 * node --env-file=.env.local --use-system-ca --import tsx scripts/verify-manual-route.mts --run --case=walk
 * Cases: walk, walk-meal, short-window. One case per invocation; no MAX/DB writes.
 * Outputs synthetic conditions, aggregate diagnostics and the public plan only.
 */
import { randomUUID } from 'node:crypto';
import { LiveGeography, LocalityTokens } from '../src/server/live-geography.js';
import { manualOptions, manualSeed } from '../src/server/manual-planning.js';
import { DgisClient } from '../src/server/dgis.js';
import { PlanningSessions } from '../src/server/planning-sessions.js';
import { planPlacesWithDgis, safePlanningDiagnostic } from '../src/server/place-planning.js';
import { localAcceptanceDate } from './live-journey-fidelity.mts';
import type { ActivityChoice } from '../src/shared/activity-choice.js';

if (!process.argv.includes('--run')) {
  console.log('Use --run --case=walk|walk-meal|short-window. Real 2GIS calls (existing per-plan bounds), zero LLM calls, no MAX messages or DB writes.');
  process.exit(0);
}
const scenario = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
if (!scenario || !['walk', 'walk-meal', 'short-window'].includes(scenario)) {
  console.error('Specify one supported --case.'); process.exit(2);
}
const env = (name: string) => process.env[name]?.trim() ?? '';
for (const name of ['DGIS_PLACES_API_KEY', 'DGIS_ROUTING_API_KEY']) {
  if (!env(name)) { console.error(`Missing setting: ${name}`); process.exit(2); }
}
const transport: { service: string; status: number }[] = [];
const fetchProvider: typeof fetch = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) transport.push({ service: new URL(String(url)).hostname === 'routing.api.2gis.com' ? 'routing' : 'catalog', status: response.status });
  return response;
};
const started = performance.now();
try {
  const geography = new LiveGeography(env('DGIS_PLACES_API_KEY'), new LocalityTokens(randomUUID()), fetchProvider,
    env('DGIS_BACKUP_API_KEY'), env('DGIS_TERTIARY_API_KEY'));
  const selected = (await geography.search('Нижний Новгород')).find(choice => choice.name === 'Нижний Новгород');
  if (!selected) throw new Error('PROBE_LOCALITY_UNAVAILABLE');
  const context = await geography.context(selected.token);
  const choices = manualOptions(context);
  // Explicit selections from the same menu a person uses; no inferred food types.
  const mealNames = new Set(['Кафе', 'Рестораны', 'Столовые', 'Быстрое питание']);
  const mealIds = choices.categories.filter(category => mealNames.has(category.name)).map(category => category.id);
  const minimumMealMinutes = Math.min(...choices.categories.filter(category => mealIds.includes(category.id))
    .map(category => category.estimated_visit_minutes));
  if (scenario !== 'walk' && !mealIds.length) throw new Error('PROBE_MEAL_CHOICES_UNAVAILABLE');
  const activities: ActivityChoice[] = [{ kind: 'walk' }];
  if (scenario !== 'walk') activities.push({ kind: 'place', category_ids: mealIds });
  const input = { event_id: randomUUID(), locality_token: selected.token, catalog_version: choices.catalog_version,
    mobility: 'walking', days: [{ date: localAcceptanceDate(context, 1), start: '16:00',
      end: scenario === 'short-window' ? '16:20' : '20:00', ordered: true, activities }] };
  const { seed, provenance } = manualSeed(input, context);
  const client = new DgisClient({ placesApiKey: env('DGIS_PLACES_API_KEY'), routingApiKey: env('DGIS_ROUTING_API_KEY'),
    backupApiKey: env('DGIS_BACKUP_API_KEY'), tertiaryApiKey: env('DGIS_TERTIARY_API_KEY'), fetchImpl: fetchProvider });
  let diagnostic: ReturnType<typeof safePlanningDiagnostic> | undefined;
  const sessions = new PlanningSessions({ plan: async job => {
    const result = await planPlacesWithDgis(client, job, {
      retrieval: { radiusMeters: 5000, pageSize: 5, maxPages: 5, maxRequests: 30 },
      maxRoutePairs: 200, maxRoutingHttpCalls: 30, dataMode: 'live',
    });
    diagnostic = safePlanningDiagnostic(result); return result;
  } });
  const owner = 'synthetic-manual-acceptance';
  let view = sessions.create(owner, seed, context.planning, provenance);
  view = sessions.edit(owner, view.id, { base_version: view.version, event_id: randomUUID(), changes: [
    { op: 'point', field: 'origin', point: { ...selected.center, label: 'Центр города — тестовая точка', source: 'user_map' } },
  ] });
  if (view.issues.length) {
    console.log(JSON.stringify({ case: scenario, stage: 'manual_input', issues: view.issues.map(issue => issue.code) }));
    process.exitCode = 1;
  } else {
    view = sessions.confirm(owner, view.id, { base_version: view.version, event_id: randomUUID() });
    view = await sessions.calculate(owner, view.id, { base_version: view.version, event_id: randomUUID() });
    const result = view.result;
    // Feasible means every requested activity is covered, not merely a nonempty result.
    // Short-window success must be physical infeasibility, never a provider failure.
    const providersHealthy = !transport.some(row => row.service === 'routing') &&
      diagnostic?.places_failed_queries === 0 && diagnostic?.routing_failed_batches === 0;
    const hasVisits = result?.days.some(day => day.visits.length > 0);
    const missing = result?.days.reduce((sum, day) => sum + day.missing_activity_ids.length, 0);
    const passed = providersHealthy && (scenario === 'short-window'
      ? ['LIMITED', 'UNAVAILABLE'].includes(result?.status ?? '') && !!missing
        && (diagnostic?.places_received ?? 0) > 0
        && (diagnostic?.exclusion_reasons.NO_VISIT_WINDOW ?? 0) > 0 && minimumMealMinutes > 20
      : ['AVAILABLE', 'LIMITED'].includes(result?.status ?? '') && hasVisits && missing === 0);
    console.log(JSON.stringify({ case: scenario, input: { date: seed.days[0]!.date, window: seed.days[0]!.window,
      activities: seed.days[0]!.activities.map(activity => ({ kind: activity.intent_kind,
        categories: activity.intent_kind === 'event_visit' ? [] : activity.categories.include_any.map(id => context.planning.catalog.category_names?.[id]) })) },
      functional_check: passed ? 'PASS' : 'FAIL', quality_review: 'MANUAL_REVIEW_REQUIRED',
      status: result?.status, warnings: result?.warnings, diagnostic, provider_http_failures: transport,
      llm_calls: 0, seconds: Math.round((performance.now() - started) / 100) / 10,
      days: result?.days.map(day => ({ status: day.status, missing_count: day.missing_activity_ids.length,
        visits: day.visits.map(visit => ({ name: visit.name, activity_id: visit.activity_id,
          starts_at: visit.starts_at, ends_at: visit.ends_at, travel_minutes: visit.travel_before_minutes,
          distance_meters: visit.distance_before_meters, warnings: visit.warnings })) })) }));
    if (!passed) process.exitCode = 1;
  }
} catch (error) {
  // Neither provider error messages nor request URLs are safe log payloads.
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{2,80}$/u.test(error.code)
    ? error.code : 'PROBE_FAILED';
  console.log(JSON.stringify({ case: scenario, error: code, provider_http_failures: transport,
    seconds: Math.round((performance.now() - started) / 100) / 10 }));
  process.exitCode = 1;
}
