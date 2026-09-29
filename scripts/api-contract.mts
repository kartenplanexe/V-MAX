/** Rebuild/check submission contracts offline. Does not import runtime config or read secrets. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CalculateInput, FormDraft, FormEdit, FormEvent, PublicPlan } from '../src/shared/planning-form.js';
import { SavedConditionsViewSchema, SavedUserConditionsV1Schema } from '../src/shared/saved-conditions.js';
import { RestoreSavedInputSchema } from '../src/server/durable-planning.js';
import { PreviewAlternativeInputSchema, ApplyAlternativeInputSchema, AlternativePreviewSchema } from '../src/shared/route-alternatives.js';
import { CreateShareInputSchema, ResolveShareInputSchema, ImportShareInputSchema, RevokeShareInputSchema,
  ShareCreatedSchema, SharePreviewSchema } from '../src/shared/route-sharing.js';
import { SavedRouteListSchema, ActivateSavedRouteInputSchema, DeleteSavedRouteInputSchema } from '../src/shared/saved-route-list.js';
import { ManualOptionsInput, ManualOptions, ManualRequestInput } from '../src/shared/manual-planning.js';
import { SelectedEventDisplaySchema, SearchEventsInputSchema, EventAvailabilityInputSchema, SelectEventInputSchema,
  RecheckEventInputSchema, EventSearchPreviewSchema, EventAvailabilityPreviewSchema } from '../src/shared/event-selection.js';

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const string: Schema = { type: 'string' };
const object = (properties: Record<string, Schema>, required = Object.keys(properties), extra = false): Schema =>
  ({ type: 'object', properties, required, additionalProperties: extra });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: Schema): Schema => ({ type: 'array', items });
const jsonSchema = (schema: z.ZodType): Schema => {
  const { $schema: _dialect, ...result } = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  return result;
};
const response = (description: string, schema: Schema, noStore = false) => ({ description,
  ...(noStore ? { headers: { 'Cache-Control': { schema: { type: 'string', const: 'no-store' } } } } : {}),
  content: { 'application/json': { schema } } });
const body = (schema: Schema) => ({ required: true, content: { 'application/json': { schema } } });
const errors = (codes: number[], name = 'PlanningError') => Object.fromEntries(codes.map(code =>
  [String(code), response(`HTTP ${code}; see the machine-readable error code.`,
    code === 400 ? { anyOf: [ref(name), ref('FrameworkError')] } : ref(name))]));
const transportErrors = {
  '413': response('JSON body exceeds the route body limit.', ref('FrameworkError')),
  '415': response('Unsupported request Content-Type.', ref('FrameworkError')),
};
const planningSecurity = [{ MaxInitData: [] }];
const idParameter = { name: 'id', in: 'path', required: true, schema: string,
  description: 'Opaque draft identifier returned by the server; ownership is checked before reading or changing it.' };

export function buildOpenApi() {
  const schemas: Record<string, Schema> = {
    FormDraft: jsonSchema(FormDraft), FormEdit: jsonSchema(FormEdit), FormEvent: jsonSchema(FormEvent),
    CalculateInput: { ...jsonSchema(CalculateInput), description: 'An explicit calculation action. With an existing result, refresh:true starts a new calculation of the same confirmed conditions at the current base_version, advancing the version and invalidating the previous result. Without refresh an existing result is rejected. Replay the same event_id only for the same action; replay does not repeat provider work.' },
    PublicPlan: { ...jsonSchema(PublicPlan), description: 'A provider/planner result, not proof that every wish or every city venue was covered. Optional search_scope identifies the radius around the start and retrieval coverage: PARTIAL means known incompleteness; BOUNDED_RESULTS still applies only to the bounded search and candidate policy. Neither value means exhaustive city-wide search. Older results may omit this field.' },
    SavedUserConditions: jsonSchema(SavedUserConditionsV1Schema),
    SavedConditionsView: jsonSchema(SavedConditionsViewSchema),
    RestoreSavedInput: jsonSchema(RestoreSavedInputSchema),
    PreviewAlternativeInput: jsonSchema(PreviewAlternativeInputSchema), ApplyAlternativeInput: jsonSchema(ApplyAlternativeInputSchema),
    AlternativePreview: jsonSchema(AlternativePreviewSchema),
    CreateShareInput: jsonSchema(CreateShareInputSchema), ResolveShareInput: jsonSchema(ResolveShareInputSchema),
    ImportShareInput: jsonSchema(ImportShareInputSchema), RevokeShareInput: jsonSchema(RevokeShareInputSchema),
    ShareCreated: jsonSchema(ShareCreatedSchema), SharePreview: jsonSchema(SharePreviewSchema),
    SavedRouteList: jsonSchema(SavedRouteListSchema), ActivateSavedRouteInput: jsonSchema(ActivateSavedRouteInputSchema),
    DeleteSavedRouteInput: jsonSchema(DeleteSavedRouteInputSchema),
    ManualOptionsInput: jsonSchema(ManualOptionsInput), ManualOptions: jsonSchema(ManualOptions), ManualRequestInput: jsonSchema(ManualRequestInput),
    SelectedEventDisplay: jsonSchema(SelectedEventDisplaySchema),
    SearchEventsInput: jsonSchema(SearchEventsInputSchema), EventAvailabilityInput: jsonSchema(EventAvailabilityInputSchema),
    SelectEventInput: jsonSchema(SelectEventInputSchema), RecheckEventInput: jsonSchema(RecheckEventInputSchema),
    EventSearchPreview: jsonSchema(EventSearchPreviewSchema), EventAvailabilityPreview: jsonSchema(EventAvailabilityPreviewSchema),
    PlanningError: object({ error: string }),
    ApiError: object({ status: { const: 'error' }, code: string, message: string }),
    FrameworkError: object({ statusCode: { type: 'integer' }, code: string, error: string, message: string },
      ['statusCode', 'error', 'message'], true),
    Coordinates: object({ lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number', minimum: -180, maximum: 180 } }),
    PlanningView: object({
      id: string, version: { type: 'integer', minimum: 0 },
      phase: { enum: ['DRAFT', 'CONFIRMED', 'PLANNING', 'RESULT'] },
      confirmed_version: nullable({ type: 'integer', minimum: 0 }), expires_at: { type: 'string', format: 'date-time' },
      draft: ref('FormDraft'), provenance: { type: 'object', additionalProperties: string },
      issues: array(object({ code: string, field: string })),
      capabilities: object({ modes: array(string), data_mode: { enum: ['test', 'live'] }, map_center: ref('Coordinates') }, ['modes', 'data_mode']),
      result: nullable(ref('PublicPlan')),
      event_previews: { type: 'object', additionalProperties: ref('SelectedEventDisplay') },
    }, ['id', 'version', 'phase', 'confirmed_version', 'expires_at', 'draft', 'provenance', 'issues', 'capabilities', 'result']),
    PlanningBootstrap: object({ view: nullable(ref('PlanningView')), expiredRoute: { type: 'string',
      description: 'Title of the expired chat route, not an identifier. Use saved.id for saved-condition operations.' },
      saved: ref('SavedConditionsView') }, ['view']),
    InitialRequest: object({ event_id: { type: 'string', minLength: 8, maxLength: 128 },
      user_text: { type: 'string', minLength: 1, maxLength: 4000, description: 'Trimmed before validation; whitespace-only input is rejected.' },
      locality_token: { type: 'string', minLength: 1, maxLength: 16000,
        description: 'Use a fresh opaque token from GET /api/planning/localities; do not construct locality/category authority client-side.' },
      locality_query: { type: 'string', minLength: 1, maxLength: 1000,
        description: 'Optional original user-authored locality query, trimmed before validation and retained as an own condition. It is not provider authority, a provider label or an ID.' } },
      ['event_id', 'user_text', 'locality_token']),
    InitialResponse: { oneOf: [object({ status: { const: 'off_topic' } }),
      object({ status: { const: 'draft' }, view: ref('PlanningView') })] },
    LocalityChoice: object({ id: string, region_id: string, name: string, timezone: string,
      center: ref('Coordinates'), area: object({ south: { type: 'number' }, north: { type: 'number' }, west: { type: 'number' }, east: { type: 'number' } }),
      token: string }),
    AddressChoice: object({ id: string, label: string, point: ref('Coordinates') }),
    MaxAuthSuccess: object({ status: { const: 'authenticated' }, authDate: { type: 'integer' },
      user: object({ id: { type: 'integer' }, firstName: string, languageCode: string }, ['id', 'firstName']) }),
  };
  const paths: Record<string, Record<string, unknown>> = {
    '/api/health': { get: { operationId: 'health', summary: 'Process liveness, not provider or database readiness', security: [],
      responses: { '200': response('Process is answering HTTP.', object({ service: { const: 'v-max' }, status: { const: 'ok' }, version: string })) } } },
    '/api/public-config': { get: { operationId: 'publicConfig', summary: 'Browser-safe MapGL configuration', security: [],
      responses: { '200': response('Public MapGL key only, when configured. Server-side Places/Routing keys are never returned.',
        object({ maps: object({ enabled: { type: 'boolean' }, provider: { const: '2gis' }, mapglKey: string }, ['enabled', 'provider']) }), true) } } },
    '/api/auth/max': { post: { operationId: 'validateMaxLaunch', summary: 'Validate MAX launch data without creating a separate login session', security: [],
      description: 'No password login and no bearer token are issued. Planning calls must still send X-Max-Init-Data. Credentials and user details must not be included in public evidence.',
      requestBody: body(object({ initData: { type: 'string', minLength: 1, maxLength: 16384 } }, ['initData'], true)),
      responses: { '200': response('Valid signed MAX launch data.', ref('MaxAuthSuccess')), ...errors([400, 401, 503], 'ApiError'), ...transportErrors } } },
    '/api/planning/bootstrap': { get: { operationId: 'planningBootstrap', summary: 'Read the route currently selected in the MAX chat', security: planningSecurity,
      description: 'Returns view:null when no route is active. An expired draft can instead return saved user conditions with expiredRoute (the previous route title, not an ID). Legacy records may return expiredRoute without saved. Saved conditions are not a live itinerary or confirmation. Successful initial/manual/shared creation attempts to activate the new draft; the saved library remains authoritative if navigation activation fails. Missing runtime configuration returns 503 before authentication.',
      responses: { '200': response('Current route, no active route, or saved conditions requiring a fresh draft.', ref('PlanningBootstrap'), true),
        ...errors([401, 503]) } } },
    '/api/planning/saved/{id}': { get: { operationId: 'getSavedConditions', summary: 'Read durable user conditions without restoring provider facts', security: planningSecurity,
      parameters: [{ ...idParameter, description: 'Opaque saved-conditions identifier; unknown, foreign or expired records return 404.' }],
      description: 'Reads only the authenticated owner\'s durable conditions. Does not call the LLM or calculate a route. Coordinates can exist only for an explicitly selected user map/geolocation point; they are not the current location. Provider place/rubric IDs, address labels, catalogs, schedules, prices and itineraries are not part of this payload. Check reconfirmation_required before restoring.',
      responses: { '200': response('Saved own conditions and their revision/expiry; not a provider itinerary.', ref('SavedConditionsView'), true),
        ...errors([401, 404, 409, 500]) } } },
    '/api/planning/saved/{id}/restore': { post: { operationId: 'restoreSavedConditions', summary: 'Create a fresh unconfirmed draft from saved user conditions', security: planningSecurity,
      parameters: [{ ...idParameter, description: 'Opaque saved-conditions identifier. Ownership is checked before the action body.' }],
      description: 'Explicit action with a fresh verified locality token and the latest saved revision. The server obtains fresh geography/category context, without reinterpreting the original request with an LLM or reusing the expired itinerary. A new successful action keeps the saved ID and returns an unconfirmed PlanningView with a newer version; inspect issues, review missing/reconfirmation fields, then confirm and calculate separately. A replay of a successful event returns the current view while it remains available, so it may reflect later edits/confirmation/calculation. Body limit: 32 KiB. INVALID_ACTION is 400, unknown/foreign/expired saved conditions are SAVED_CONDITIONS_NOT_FOUND (404), stale revision is SAVED_CONDITIONS_STALE (409), conflicting replay is EVENT_CONFLICT (409). A remap that cannot preserve conditions returns its first reconfirmation issue code with 422. Failed replay preserves the recorded error status (503 only when that status is absent); pending replay returns RESTORE_INTERRUPTED with 503. Neither repeats the context call. Do not retry them silently.',
      requestBody: body(ref('RestoreSavedInput')),
      responses: { '200': response('New action: fresh unconfirmed draft without prior provider result. Successful replay: current view.', ref('PlanningView'), true),
        ...errors([400, 401, 404, 409, 422, 429, 500, 502, 503]), ...transportErrors } } },
    '/api/planning/localities': { get: { operationId: 'searchLocalities', summary: 'Find a verified Russian locality and issue an opaque selection token', security: planningSecurity,
      parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2, maxLength: 100 } }],
      responses: { '200': response('Matching localities; an empty choices array is valid.', object({ choices: array(ref('LocalityChoice')) }), true), ...errors([400, 401, 409, 429, 503]) } } },
    '/api/planning/addresses': { post: { operationId: 'searchAddresses', summary: 'Find start-point building addresses in the draft locality', security: planningSecurity,
      requestBody: body(object({ draft_id: { type: 'string', minLength: 1, maxLength: 100 }, q: { type: 'string', minLength: 4, maxLength: 120 } }, ['draft_id', 'q'], true)),
      responses: { '200': response('Address choices; the caller selects one before PATCH.', object({ choices: array(ref('AddressChoice')) }), true),
        ...errors([400, 401, 404, 409, 429, 503]), ...transportErrors } } },
    '/api/planning/requests': { post: { operationId: 'createPlanningDraft', summary: 'Parse a new request through geography and LLM into a draft', security: planningSecurity,
      description: 'May call paid providers. Body limit: 24 KiB. Reusing an event_id with different content returns EVENT_CONFLICT; a failed/unknown provider outcome is not silently retried. A structurally and semantically checked partial draft can retain clarifications with exact user quotes. Every unresolved question blocks confirm/plan. Review the corresponding field, then explicitly PATCH resolve_clarification for that question at the current version; unsupported or incomplete field values cannot be acknowledged. activity_choice selects trusted catalog types for an existing activity without losing its ID, requirements or order. No clarification action reparses the request with an LLM.',
      requestBody: body(ref('InitialRequest')), responses: { '200': response('Off-topic input or a draft requiring confirmation.', ref('InitialResponse'), true),
        ...errors([400, 401, 404, 409, 422, 429, 500, 502, 503]), ...transportErrors } } },
    '/api/max/webhook': { post: { operationId: 'maxWebhook', summary: 'Receive MAX bot updates (provider-to-server only)', security: [{ MaxWebhookSecret: [] }],
      description: 'Valid updates can send messages to a MAX user and invoke paid providers. Do not replay production events or use this endpoint as a user-facing API. The server ignores unsupported update types; body limit is 64 KiB. Administrative setup remains separate from contract checking.',
      requestBody: body({ type: 'object', additionalProperties: true,
        description: 'MAX update envelope; accepted message_created, bot_started and message_callback events are normalized server-side. Unsupported/malformed envelopes are ignored.' }),
      responses: { '200': response('Handled, duplicate, ignored, or accepted by the configured managed async service. Accepted does not mean calculation is complete.', object({ status: { enum: ['handled', 'duplicate', 'ignored', 'accepted'] } })),
        '401': response('Missing or invalid webhook secret.', object({ status: { const: 'unauthorized' } })),
        '503': response('Retry is required; automatic duplicate protection is server-owned.', object({ status: { const: 'retry_later' } })), ...transportErrors } } },
  };
  paths['/api/max/worker'] = { post: { operationId: 'maxAsyncWorker', summary: 'Execute a managed MAX update (internal only)',
    security: [{ MaxWorkerSecret: [] }],
    description: 'Separate server-derived credential; the webhook secret does not authorize this route. Body is a minimal MAX envelope, limited to 64 KiB. Persistent receipts prevent duplicate provider work. Not a judge/user API.',
    requestBody: body({ type: 'object', additionalProperties: true }),
    responses: { '200': response('Handled, duplicate, or ignored.', object({ status: { enum: ['handled', 'duplicate', 'ignored'] } })),
      '401': response('Missing or invalid worker credential.', object({ status: { const: 'unauthorized' } })),
      '503': response('Worker busy or interrupted.', object({ status: { const: 'retry_later' } })), ...transportErrors } } };
  paths['/api/planning/saved'] = { get: { operationId: 'listSavedRoutes', summary: 'List the authenticated owner\'s saved conditions',
    security: planningSecurity, parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 600 } }],
    description: 'Up to 50 records per page. can_open and has_fresh_result are informational; activate checks current ownership and expiry. Reads call no providers.',
    responses: { '200': response('Saved route list and opaque next cursor.', ref('SavedRouteList'), true), ...errors([400, 401, 503]) } } };
  for (const [path, operationId, requestSchema, responseSchema, description] of [
    ['/api/planning/drafts/{id}/events/search', 'searchDayEvents', 'SearchEventsInput', 'EventSearchPreview',
      'Search the selected day in a verified supported locality. Returns a bounded public afisha with opaque choices and explicit coverage; no draft mutation. Source previews expire within five minutes and cannot be treated as the entire city catalog.'],
    ['/api/planning/drafts/{id}/events/availability', 'checkEventAvailability', 'EventAvailabilityInput', 'EventAvailabilityPreview',
      'Freshly read the selected source event and venue. Returns exact selectable occurrences or visit windows with opaque occurrence choices. Unknown schedules are explicit gaps, not assumed opening hours.'],
    ['/api/planning/drafts/{id}/events/select', 'selectDayEvent', 'SelectEventInput', 'PlanningView',
      'Explicitly append an event or replace the selected wish using a server-owned occurrence choice. Flexible visits require an explicit user duration. Invalidates confirmation/result, preserves other wishes and stores only the chosen identity as durable own data.'],
    ['/api/planning/drafts/{id}/events/recheck', 'recheckSelectedEvent', 'RecheckEventInput', 'PlanningView',
      'Freshly verify a previously chosen exact event occurrence. Does not choose a different occurrence, calculate a route or extend saved-condition retention. The returned draft needs confirmation.'],
    ['/api/planning/saved/{id}/activate', 'activateSavedRoute', 'ActivateSavedRouteInput', 'PlanningBootstrap',
      'Explicitly selects an own route in shared bot/mini-app navigation without calling providers. An expired draft returns own saved conditions. An old replay cannot override a newer navigation action (ACTIVATION_SUPERSEDED 409).'],
    ['/api/planning/saved/{id}/delete', 'deleteSavedRoute', 'DeleteSavedRouteInput', 'RouteDeleted',
      'Deletes the explicitly selected own saved revision, working draft and navigation entry, and revokes associated links through a database cascade. Copies previously imported by other users remain theirs. Same-event replay is idempotent; changed revision returns SAVED_CONDITIONS_STALE 409.'],
    ['/api/planning/drafts/{id}/alternatives/preview', 'previewStopAlternative', 'PreviewAlternativeInput', 'AlternativePreview',
      'Build one fresh validated replacement for the selected stop while preserving all other stops/order/constraints. Does not modify the current plan. Empty alternatives is a valid result with issues. Uses Places/Routing and the deterministic planner, no LLM.'],
    ['/api/planning/drafts/{id}/alternatives/apply', 'applyStopAlternative', 'ApplyAlternativeInput', 'PlanningView',
      'Applies the exact unexpired preview under owner/version checks without new provider work. Expired previews return 410. Neither original nor provider expiry is extended.'],
    ['/api/planning/shares', 'createRouteShare', 'CreateShareInput', 'ShareCreated',
      'Creates an opaque revocable link for the exact saved revision. Pending input clarifications return SHARE_CLARIFICATION_REQUIRED (422); they cannot be silently omitted or forwarded. Private origin/destination points are omitted unless explicitly included. Own conditions expire within seven days; provider preview retains its original shorter expiry. This call does not send a MAX message.'],
    ['/api/planning/shares/resolve', 'resolveRouteShare', 'ResolveShareInput', 'SharePreview',
      'Authenticated read-only preview for a holder of the token. Expired provider facts are removed; expired/revoked/unknown links return 404. No LLM or provider calls. Token belongs in the POST body, never logs.'],
    ['/api/planning/shares/import', 'importRouteShare', 'ImportShareInput', 'PlanningView',
      'Explicitly copies allowed conditions to a new recipient-owned unconfirmed draft using fresh verified locality context, without LLM. Original result/confirmation is not copied. Failed/pending replay never repeats context; replay after imported draft expiry returns 410.'],
    ['/api/planning/shares/revoke', 'revokeRouteShare', 'RevokeShareInput', 'ShareRevoked',
      'Owner-only revocation of an issued link. Does not delete copies already explicitly imported by recipients.'],
    ['/api/planning/manual/options', 'manualPlanningChoices', 'ManualOptionsInput', 'ManualOptions',
      'Reads supported categories and explicit visit-duration estimates from fresh verified locality context. Does not call LLM.'],
    ['/api/planning/manual/requests', 'createManualDraft', 'ManualRequestInput', 'PlanningView',
      'Creates an unconfirmed draft from explicit dates/windows/categories/order/mobility without LLM. Revalidates catalog version and choices. Unknown categories, duplicate dates, invalid time order or more than 120 total activities are rejected. Start point is selected later through the normal form. Durable replay prevents repeated context calls.'],
  ] as const) {
    paths[path] = { post: { operationId, summary: description.split('.')[0], description, security: planningSecurity,
      ...(path.includes('{id}') ? { parameters: [idParameter] } : {}), requestBody: body(ref(requestSchema)),
      responses: { '200': response('Successful operation; inspect status, issues and expiry before presenting completion.', ref(responseSchema), true),
        ...errors([400, 401, 404, 409, 410, 422, 429, 500, 502, 503]), ...transportErrors } } };
  }
  schemas.ShareRevoked = object({ revoked: { const: true } });
  schemas.RouteDeleted = object({ deleted: { const: true } });
  for (const [method, suffix, operationId, summary, requestSchema] of [
    ['get', '', 'getPlanningDraft', 'Read a draft owned by the authenticated user', null],
    ['patch', '', 'editPlanningDraft', 'Apply an atomic version-bound edit and invalidate prior confirmation/result', 'FormEdit'],
    ['post', '/confirm', 'confirmPlanningDraft', 'Confirm the current draft if all required fields are valid', 'FormEvent'],
    ['post', '/plan', 'calculatePlan', 'Calculate or explicitly refresh a confirmed plan with Places, routing and the deterministic planner', 'CalculateInput'],
  ] as const) {
    const path = `/api/planning/drafts/{id}${suffix}`;
    paths[path] ??= {};
    paths[path][method] = { operationId, summary, security: planningSecurity, parameters: [idParameter],
      description: 'Use the latest returned version for base_version and a unique event_id per user action. Replays of the same event are deduplicated. Unknown/foreign/expired drafts return 404. Error responses are JSON {error:code}; malformed JSON may instead use the Fastify error envelope. Time/ownership/ordering checks are server-side and are stricter than structural JSON Schema alone.',
      ...(requestSchema ? { requestBody: body(ref(requestSchema)) } : {}),
      responses: { '200': response('Current PlanningView. Inspect result.status rather than treating HTTP 200 as proof of a complete route.', ref('PlanningView'), true),
        ...errors(method === 'get' ? [401, 404, 409, 500] : [400, 401, 404, 409, 422, 429, 500, 503]),
        ...(requestSchema ? transportErrors : {}) } };
  }
  paths['/api/planning/drafts/{id}/activity-options'] = { get: {
    operationId: 'getActivityOptions', summary: 'Read supported activities from this authenticated draft’s trusted catalog; no model or planning call',
    security: planningSecurity, parameters: [idParameter],
    responses: { '200': response('Category choices and estimated visit times; old drafts without category names return 503.', ref('ManualOptions'), true),
      ...errors([401, 404, 409, 500, 503]) },
  } };
  return { openapi: '3.1.0', info: { title: 'Планировщик городского досуга в MAX', version: '2026-09-27',
    description: 'Actual HTTP contract of the working tree. Not a release-readiness or live-quality claim. Generated from shared Zod schemas where available; timestamps/prices/travel times are explicit fields. Dates and time windows are also semantically checked in runtime. No credentials are embedded. JSON notation is used as the YAML 1.2 subset to avoid an extra runtime dependency.' },
    servers: [{ url: 'https://bbapc7qgk242slpm2df5.containers.yandexcloud.net', description: 'Existing configured HTTPS deployment; availability and parity with this working tree require a separate release check.' },
      { url: 'http://127.0.0.1:3000', description: 'Local Docker Compose; this URL alone does not provide MAX authorization.' }],
    tags: [{ name: 'contract', description: 'Freeze the code and these documents together after local and MAX checks.' }],
    paths, components: { securitySchemes: {
      MaxInitData: { type: 'apiKey', in: 'header', name: 'X-Max-Init-Data', description: 'Complete signed MAX initData from a fresh authorized mini-app launch. Never publish it. Authorization is not used by the planner.' },
      MaxWebhookSecret: { type: 'apiKey', in: 'header', name: 'X-Max-Bot-Api-Secret', description: 'Server-managed webhook secret. No administrative credentials are needed for judge user-flow checks.' },
      MaxWorkerSecret: { type: 'apiKey', in: 'header', name: 'X-Vmax-Worker-Secret', description: 'Separate internal worker credential; never supplied to clients.' },
    }, schemas },
    'x-source-files': ['src/server/index.ts', 'src/server/live-runtime.ts', 'src/server/planning-routes.ts', 'src/server/initial-requests.ts', 'src/server/durable-planning.ts', 'src/server/max-chat.ts', 'src/shared/planning-form.ts', 'src/shared/saved-conditions.ts', 'src/shared/route-alternatives.ts', 'src/shared/route-sharing.ts', 'src/server/route-sharing-routes.ts', 'src/server/saved-route-list.ts', 'src/server/manual-planning.ts', 'src/server/event-planning-routes.ts', 'src/server/durable-event-planning.ts', 'src/shared/event-selection.ts', 'src/shared/event-catalog.ts'],
    'x-runtime-notes': ['When required environment is missing, only bootstrap is registered for planning and returns 503; the other planning/webhook routes are absent.',
      'Yandex credentials are optional for runtime startup: without them only natural-language parsing is unavailable; manual input and saved conditions remain available.',
      'HTTP 200 with LIMITED/UNAVAILABLE/ERROR/NEEDS_INPUT must not be scored as a successful complete route.',
      'No unprotected endpoint creates a user session. MAX user identity is derived from the verified signature.'],
  };
}

export function buildDataApi() {
  const auth = { 'X-Max-Init-Data': '${MAX_TEST_INIT_DATA}' };
  const expected = (schema: Schema, status = 200) => ({ status_codes: [status], content_type: 'application/json', schema });
  const check = (id: string, method: string, path: string, role: string, parameters: Schema, expectation: Schema) =>
    ({ id, required: true, method, path, role, parameters, expected: expectation });
  return {
    schema_version: 'v-max.data-api.v1', solution_name: 'Планировщик городского досуга в MAX',
    schema_status: 'Project-defined check manifest covering the fields required on case page 10. The supplied organizer documents do not publish an executable DATA-API schema; verify compatibility with the submission portal before upload.',
    base_url: 'https://bbapc7qgk242slpm2df5.containers.yandexcloud.net',
    base_url_override_environment: 'V_MAX_TEST_BASE_URL', openapi_file: 'openapi.yaml', test_data_file: 'test-data/api-scenarios.json',
    schema_reference_document: 'openapi.yaml',
    revision: { status: 'pending_freeze', commit: null, note: 'Working tree changes are in progress. Record the tested submitted commit or archive checksum before submission; do not invent a SHA.' },
    execution: { automatic_runner: false, instructions: 'Execute checks in order with the test MAX user, or import OpenAPI into a compatible HTTP client. Placeholder substitution and JSON Pointer extraction below describe the procedure; this file does not pretend to be an organizer-provided runner.',
      substitution: 'A placeholder occupying an entire JSON value preserves the source type: versions, latitude and longitude must be numbers, not strings. Schema references resolve against openapi.yaml components.',
      offline_contract_command: 'node --import tsx scripts/api-contract.mts',
      offline_http_test_command: 'npm exec -- vitest run src/server/submission-api-contract.test.ts',
      live_policy: 'Use a dedicated authorized MAX test account. Explicitly initiated requests/plan may spend provider quota. Never log or publish initData, tokens or raw provider data; do not send valid synthetic webhook events to production.' },
    roles: { anonymous: 'No credentials.', max_user: 'Ordinary user of the supplied MAX bot. Team supplies a usable test account/access procedure privately; no admin access is needed.' },
    variables: {
      MAX_TEST_INIT_DATA: { source: 'Fresh signed launch data from a mini-app opened by the test MAX user; transmitted privately/in memory, not stored in this repository.', secret: true },
      LOCALITY_TOKEN: { source_check: 'localities', json_pointer: '/choices/0/token', secret: true, precondition: 'Tester verifies that the chosen locality is Москва; do not blindly accept a different first result.' },
      DRAFT_ID: { source_check: 'create-draft', json_pointer: '/view/id' },
      DRAFT_VERSION: { source: 'Latest PlanningView.version from each successful edit/confirm.' },
      SAVED_REVISION: { source_check: 'read-saved', json_pointer: '/revision',
        precondition: 'Saved IDs are stable: use DRAFT_ID for read/restore. Re-read the revision after any later edit; do not substitute PlanningView.version without checking the saved response.' },
      RESTORE_LOCALITY_TOKEN: { source_check: 'refresh-saved-locality', json_pointer: '/choices/0/token', secret: true,
        precondition: 'Explicitly verify/select Москва again. Do not reuse an expired provider token or infer a locality from stored provider IDs.' },
      DAY_ID: { source_check: 'create-draft', json_pointer: '/view/draft/days/0/day_id' },
      ADDRESS_LAT: { source_check: 'addresses', json_pointer: '/choices/0/point/lat' },
      ADDRESS_LON: { source_check: 'addresses', json_pointer: '/choices/0/point/lon' },
      ADDRESS_LABEL: { source_check: 'addresses', json_pointer: '/choices/0/label' },
      EVENT_ID: { source: 'New UUID for each explicit action; reuse only when deliberately testing deduplication.' },
      MANUAL_CATALOG: { source_check: 'manual-options', json_pointer: '/catalog_version' },
      MANUAL_CATEGORY: { source_check: 'manual-options', json_pointer: '/categories/0/id', precondition: 'Choose an actual desired category from the returned list; do not invent a 2GIS ID.' },
      MANUAL_DATE: { source: 'A future YYYY-MM-DD date explicitly chosen by the tester in the locality timezone.' },
      MANUAL_ID: { source_check: 'manual-create', json_pointer: '/id' },
      MANUAL_REVISION: { source_check: 'manual-read-saved', json_pointer: '/revision' },
      SHARE_TOKEN: { source_check: 'share-create', json_pointer: '/token', secret: true },
      SHARE_ID: { source_check: 'share-create', json_pointer: '/share_id', secret: true },
    },
    checks: [
      check('health', 'GET', '/api/health', 'anonymous', {}, expected(object({ service: { const: 'v-max' }, status: { const: 'ok' }, version: string }))),
      check('public-config', 'GET', '/api/public-config', 'anonymous', {}, expected(object({ maps: object({ enabled: { type: 'boolean' }, provider: { const: '2gis' }, mapglKey: string }, ['enabled', 'provider']) }))),
      check('deny-unsigned-bootstrap', 'GET', '/api/planning/bootstrap', 'anonymous', {}, expected(object({ error: { const: 'AUTH_REQUIRED' } }), 401)),
      check('bootstrap', 'GET', '/api/planning/bootstrap', 'max_user', { headers: auth }, expected(ref('PlanningBootstrap'))),
      check('validate-launch', 'POST', '/api/auth/max', 'max_user', { body: { initData: '${MAX_TEST_INIT_DATA}' } }, expected(ref('MaxAuthSuccess'))),
      check('localities', 'GET', '/api/planning/localities', 'max_user', { headers: auth, query: { q: 'Москва' } }, expected(object({ choices: { type: 'array', minItems: 1, items: ref('LocalityChoice') } }))),
      check('create-draft', 'POST', '/api/planning/requests', 'max_user', { headers: auth, body: { event_id: '${EVENT_ID}', locality_token: '${LOCALITY_TOKEN}',
        locality_query: 'Москва',
        user_text: 'Завтра в Москве с 14:00 до 19:00 хочу погулять, а потом поесть, пешком, без ограничения бюджета' } }, expected(object({ status: { const: 'draft' }, view: ref('PlanningView') }))),
      check('addresses', 'POST', '/api/planning/addresses', 'max_user', { headers: auth, body: { draft_id: '${DRAFT_ID}', q: 'Тверская улица, 1' } }, expected(object({ choices: { type: 'array', minItems: 1, items: ref('AddressChoice') } }))),
      check('set-start', 'PATCH', '/api/planning/drafts/{id}', 'max_user', { path: { id: '${DRAFT_ID}' }, headers: auth,
        body: { base_version: '${DRAFT_VERSION}', event_id: '${EVENT_ID}', changes: [{ op: 'point', field: 'origin', point: { lat: '${ADDRESS_LAT}', lon: '${ADDRESS_LON}', label: '${ADDRESS_LABEL}', source: 'place_choice' } }] } }, expected(ref('PlanningView'))),
      check('confirm', 'POST', '/api/planning/drafts/{id}/confirm', 'max_user', { path: { id: '${DRAFT_ID}' }, headers: auth,
        body: { base_version: '${DRAFT_VERSION}', event_id: '${EVENT_ID}' } }, expected(ref('PlanningView'))),
      check('calculate', 'POST', '/api/planning/drafts/{id}/plan', 'max_user', { path: { id: '${DRAFT_ID}' }, headers: auth,
        body: { base_version: '${DRAFT_VERSION}', event_id: '${EVENT_ID}' } }, { ...expected(ref('PlanningView')), semantic_checks: [
          'Inspect result.status and per-day missing_activity_ids. A partial route must be labeled LIMITED, with omitted wishes identified.',
          'When search_scope is present, verify radius_meters and coverage survive the server/public result projection. PARTIAL and BOUNDED_RESULTS must not be described as an exhaustive city-wide search.',
          'Validate walking and eating activities, their explicit order, opening hours, visit slots and travel inside the confirmed window.',
          'UNAVAILABLE/ERROR is a valid response shape but fails this positive live acceptance scenario; do not replace it with fixture data.'] }),
      check('reopen-draft', 'GET', '/api/planning/drafts/{id}', 'max_user', { path: { id: '${DRAFT_ID}' }, headers: auth }, expected(ref('PlanningView'))),
      check('edit-window', 'PATCH', '/api/planning/drafts/{id}', 'max_user', { path: { id: '${DRAFT_ID}' }, headers: auth,
        body: { base_version: '${DRAFT_VERSION}', event_id: '${EVENT_ID}', changes: [{ op: 'window', day_ids: ['${DAY_ID}'], start: '14:00', end: '14:30' }] } }, expected(ref('PlanningView'))),
      check('edit-search-radius', 'PATCH', '/api/planning/drafts/{id}', 'max_user', { path: { id: '${DRAFT_ID}' }, headers: auth,
        body: { base_version: '${DRAFT_VERSION}', event_id: '${EVENT_ID}', changes: [{ op: 'search_radius', meters: 1000 }] } },
        { ...expected(ref('PlanningView')), semantic_checks: ['Only shared.search_radius_meters and provenance change; confirmation/result are invalidated. Reconfirm before calculating. The next result.search_scope.radius_meters must equal 1000; no candidate outside that radius may be included. Saved/reopened/shared conditions retain the explicit radius.'] }),
      check('deny-unsigned-saved', 'GET', '/api/planning/saved/{id}', 'anonymous', { path: { id: '${DRAFT_ID}' } },
        expected(object({ error: { const: 'AUTH_REQUIRED' } }), 401)),
      check('read-saved', 'GET', '/api/planning/saved/{id}', 'max_user', { path: { id: '${DRAFT_ID}' }, headers: auth },
        { ...expected(ref('SavedConditionsView')), semantic_checks: [
          'Read the latest user edits without an LLM call; this response must not contain the previous provider itinerary, catalog, prices or schedule facts.',
          'The response is saved user conditions. Provider address choices can be absent with POINT_RECONFIRM_REQUIRED; a saved user geolocation is historical, not current.'] }),
      check('refresh-saved-locality', 'GET', '/api/planning/localities', 'max_user', { headers: auth, query: { q: 'Москва' } },
        expected(object({ choices: { type: 'array', minItems: 1, items: ref('LocalityChoice') } }))),
      check('restore-saved', 'POST', '/api/planning/saved/{id}/restore', 'max_user', { path: { id: '${DRAFT_ID}' }, headers: auth,
        body: { event_id: '${EVENT_ID}', base_revision: '${SAVED_REVISION}', locality_token: '${RESTORE_LOCALITY_TOKEN}' } },
        { ...expected(ref('PlanningView')), semantic_checks: [
          'ID stays equal to DRAFT_ID, phase is DRAFT, confirmed_version and result are null. The prior provider itinerary must not reappear.',
          'Review current dates, missing points and other issues. Restore alone must not confirm the conditions or calculate a route.',
          'If fresh context cannot preserve named types, exclusions or hard conditions, 422 is the safe refusal; record the acceptance limitation rather than widening the request.'] }),
      check('saved-library', 'GET', '/api/planning/saved', 'max_user', { headers: auth },
        { ...expected(ref('SavedRouteList')), semantic_checks: ['Only this user’s nonexpired conditions appear. Pagination must not duplicate routes; reading does not extend expiry.'] }),
      check('activate-saved', 'POST', '/api/planning/saved/{id}/activate', 'max_user', { path: { id: '${DRAFT_ID}' }, headers: auth,
        body: { event_id: '${EVENT_ID}' } }, expected(ref('PlanningBootstrap'))),
      check('manual-options', 'POST', '/api/planning/manual/options', 'max_user', { headers: auth,
        body: { locality_token: '${RESTORE_LOCALITY_TOKEN}' } }, expected(ref('ManualOptions'))),
      check('activity-options', 'GET', '/api/planning/drafts/{id}/activity-options', 'max_user', { path: { id: '${DRAFT_ID}' }, headers: auth },
        { ...expected(ref('ManualOptions')), semantic_checks: ['Reading choices does not edit, confirm, plan or call a model. Categories belong to this draft’s regional catalog.'] }),
      check('manual-create', 'POST', '/api/planning/manual/requests', 'max_user', { headers: auth, body: {
        event_id: '${EVENT_ID}', locality_token: '${RESTORE_LOCALITY_TOKEN}', catalog_version: '${MANUAL_CATALOG}', mobility: 'walking',
        days: [{ date: '${MANUAL_DATE}', start: '14:00', end: '19:00', ordered: true,
          activities: [{ kind: 'place', category_ids: ['${MANUAL_CATEGORY}'] }] }] } },
        { ...expected(ref('PlanningView')), semantic_checks: ['Creation succeeds without calling an LLM; the new draft is unconfirmed, requires a start point and has no calculated result.'] }),
      check('manual-read-saved', 'GET', '/api/planning/saved/{id}', 'max_user', { path: { id: '${MANUAL_ID}' }, headers: auth }, expected(ref('SavedConditionsView'))),
      check('share-create', 'POST', '/api/planning/shares', 'max_user', { headers: auth, body: {
        draft_id: '${MANUAL_ID}', base_revision: '${MANUAL_REVISION}', event_id: '${EVENT_ID}', include_private_points: false } }, expected(ref('ShareCreated'))),
      check('share-preview', 'POST', '/api/planning/shares/resolve', 'max_user', { headers: auth, body: { token: '${SHARE_TOKEN}' } },
        { ...expected(ref('SharePreview')), semantic_checks: ['Shared conditions contain no private start/destination or free-text address queries. Opening does not import, calculate, confirm or send messages.'] }),
      check('share-revoke', 'POST', '/api/planning/shares/revoke', 'max_user', { headers: auth,
        body: { share_id: '${SHARE_ID}', event_id: '${EVENT_ID}' } }, expected(ref('ShareRevoked'))),
      check('delete-own-manual', 'POST', '/api/planning/saved/{id}/delete', 'max_user', { path: { id: '${MANUAL_ID}' }, headers: auth,
        body: { base_revision: '${MANUAL_REVISION}', event_id: '${EVENT_ID}' } },
        { ...expected(ref('RouteDeleted')), semantic_checks: ['Delete only the synthetic route created in this sequence. Other saved routes survive; replay is idempotent.'] }),
    ],
    follow_up_checks: ['After edit-window, confirm and calculate again with fresh versions/event IDs; the short-window case must expose unmet wishes, not silently call the result complete.',
      'For a checked partial request, verify that activities, dates, time and order survive alongside draft.clarifications. Confirm/plan must remain blocked until explicit version-bound resolution. Edit one relevant field, resolve only that question and verify no new LLM calls. Pending questions must survive own save/reopen/process restart; sharing must fail without exposing their quotes.',
      'For an unexpired result, explicitly POST /plan with refresh:true, the current base_version and a new event_id. Conditions must remain identical and the version must advance. Replay that exact action: no further provider work or version change. A new event using the old version must fail with STALE_VERSION. Routing service denial must produce ERROR / ROUTING_PROVIDER_UNAVAILABLE, not claim the wishes are impossible; retry after service recovery without another LLM call.',
      'Repeat read-saved and restore-saved after draft/provider expiration and a process restart. Latest edits must survive; categories/addresses/itineraries must not be reused as durable provider facts. Check stale revision 409 and foreign/expired saved ID 404.',
      'Use MAX chat /routes and the mini-app to reopen a saved route, inspect saved conditions and explicitly refresh context before confirmation/calculation. API read/restore does not replace this user interaction.',
      'Run the same request with an unsigned header and another user: 401/404 without leaking route contents.',
      'For a fresh calculated route, preview a chosen stop via alternatives/preview using its current day/activity/place IDs. Preview must preserve the current plan. Apply an offered alternative_id explicitly; the returned plan must equal the preview. Empty alternatives need an explicit reason and are not a successful positive replacement check.',
      'Create another share of a fresh calculated route. Open its MAX deep link as a second authorized test user, choose a fresh verified city and import explicitly. The recipient draft is unconfirmed, isolated from the sender and requires omitted start/finish points. Revoke the original share; future resolution fails while an already imported independent copy remains.',
      'Repeat manual creation with LLM credentials absent in an isolated deployment. Geography remains required; never replace failed live geography with invented categories.',
      'In Нижний Новгород or Казань, use events/search for a chosen day, events/availability for an opaque choice, then events/select for the chosen occurrence. For a visit window explicitly enter a duration; fixed sessions must retain their exact schedule. Preserve food/order and confirm before calculation. A missing desired event or PARTIAL search is not proof of city-wide absence.',
      'After event preview expiry, restoration or changed date, events/recheck must obtain fresh source facts before confirmation. A moved venue/changed occurrence must require a reviewed choice, never silently become a POI. Check unsigned/foreign/stale selections, receipt replay and source-free saved conditions.',
      'Check mobile and web MAX manually. API contract tests do not establish usability or live route quality.'],
  };
}

// JSON is a strict YAML 1.2 subset; it can also be checked without adding YAML parser dependencies.
export const serializeContract = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export async function updateContracts(write = false) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const [name, value] of [['openapi.yaml', buildOpenApi()], ['DATA-API.yaml', buildDataApi()]] as const) {
    const expected = serializeContract(value), path = resolve(root, name);
    if (write) await writeFile(path, expected, 'utf8');
    else if (await readFile(path, 'utf8') !== expected) throw new Error(`${name} is stale. Run node --import tsx scripts/api-contract.mts --write, then verify the contract tests.`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await updateContracts(process.argv.includes('--write'));
  console.log(process.argv.includes('--write') ? 'Submission API contracts generated; no network or secrets used.' : 'Submission API contracts are up to date; no network or secrets used.');
}
