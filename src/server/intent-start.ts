import { z } from 'zod';
import { FormDraft, type PlanningView } from '../shared/planning-form.js';
import { buildDailyRepairRequest, buildDailyRequest } from './intent/daily-contract.mjs';
import { projectNewDailyIntent } from './intent/daily-time.mjs';

export type CatalogRow = [string, string, string[], { type?: string; caption?: string; declared_parent_ids?: string[] }?];
export interface InitialContext {
  now: string;
  locality: PlanningView['draft']['locality'];
  catalog: { format: string; version: string; region_id: string; complete: boolean; roots: string[]; rows: CatalogRow[] };
}
export class InitialIntentError extends Error {
  constructor(readonly code: string, readonly status = 422,
    readonly diagnostic?: { stage: string; status?: string; errors?: string[]; reasons?: string[];
      schema?: { path: string; keyword: string }[]; fields?: { path: string; code: string }[] }) { super(code); }
}
export type IntentProvider = (request: Record<string, unknown>) => Promise<unknown>;
export type InitialResult = { status: 'off_topic' } | {
  status: 'draft'; draft: PlanningView['draft']; provenance: Record<string, string>;
};
const Text = z.string().trim().min(1).max(4000);
const greetings = new Set(['привет', 'здравствуйте', 'добрый день', 'добрый вечер', 'как дела', 'спасибо']);
const name = (value: string) => value.trim().toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
export const isExactGreeting = (text: string) => greetings.has(name(text).replace(/[!?.,\s]+$/gu, ''));
// Narrow projection of the proposal AFTER the frozen JSON-schema/evidence guard.
interface ValidatedProposal {
  action: string;
  shared_updates: { op: string; field: string; value: unknown }[];
  days: { day_id: string; activity_edits: { activity_id: string; label: string; selection: unknown; requirements: unknown[] }[];
    category_matches: { activity_id: string; state: string; include_any: string[]; exclude: string[] }[];
    order_changes: { op: string; before: string; after: string }[] }[];
}

/** Initial extraction only. Subsequent changes go through typed form operations, never an LLM. */
export async function parseInitialIntent(context: InitialContext & { userText: string; inputId: string }, provider: IntentProvider): Promise<InitialResult> {
  const parsedText = Text.safeParse(context.userText);
  if (!parsedText.success) throw new InitialIntentError('INVALID_REQUEST_TEXT', 400);
  const text = parsedText.data;
  // Deliberately tiny exact-match gate; uncertain messages must not be keyword-filtered out.
  if (isExactGreeting(text)) return { status: 'off_topic' };
  if (!context.catalog.complete || context.catalog.region_id !== context.locality.region_id || !context.catalog.version || !context.catalog.rows.length)
    throw new InitialIntentError('CATALOG_UNAVAILABLE', 503);
  const input = { input_id: context.inputId, mode: 'parse', now: context.now,
    locality_context: context.locality, catalog: context.catalog, user_text: text, draft: null, pending_question: null };
  let raw = await provider(buildDailyRequest(input));
  let projection = projectNewDailyIntent(raw, input);
  const firstErrors = projection.guard.errors;
  if (raw && typeof raw === 'object' && 'action' in raw && raw.action === 'new_request' &&
      firstErrors.length > 0 && firstErrors.every((error: string) =>
        error === 'CATEGORY_ID' || error === 'NONCONTIGUOUS_OFFSETS')) {
    // Reserve/bill a second call through the provider callback. Never loop or silently
    // accept an invalid category/date merely to make a plan appear.
    raw = await provider(buildDailyRepairRequest(input, firstErrors, raw));
    projection = projectNewDailyIntent(raw, input);
  }
  // Check the final response too: a repair must never bypass trusted city resolution.
  if (raw && typeof raw === 'object' && 'shared_updates' in raw && Array.isArray(raw.shared_updates)) {
    const city = raw.shared_updates.find((u: unknown) => u && typeof u === 'object' && 'field' in u && u.field === 'locality_text');
    if (city && (typeof city.value !== 'string' || name(city.value) !== name(context.locality.name)))
      throw new InitialIntentError('LOCALITY_RESOLUTION_REQUIRED');
  }
  const proposal = projection.guard.proposal as ValidatedProposal | null;
  if (proposal?.action === 'off_topic') return { status: 'off_topic' };
  const schemaIssues = 'schema_errors' in projection.guard && Array.isArray(projection.guard.schema_errors)
    ? projection.guard.schema_errors : [];
  if (!proposal) throw new InitialIntentError(projection.guard.status === 'needs_clarification' ? 'INTENT_NEEDS_CLARIFICATION' : 'INTENT_INVALID_RESPONSE', 422,
    { stage: 'guard', status: projection.guard.status, errors: projection.guard.errors.slice(0, 12),
      reasons: projection.guard.reasons.slice(0, 12),
      schema: schemaIssues.slice(0, 12).map((issue: { instancePath: string; keyword: string }) =>
        ({ path: issue.instancePath, keyword: issue.keyword })) });
  if (proposal.action !== 'new_request' || projection.days.length !== proposal.days.length || !projection.days.length)
    throw new InitialIntentError('INTENT_INVALID_RESPONSE', 422, { stage: 'projection', status: projection.status });
  const shared: Record<string, unknown> = {}, provenance: Record<string, string> = {};
  for (const update of proposal.shared_updates) {
    if (update.op !== 'set') throw new InitialIntentError('INTENT_INVALID_RESPONSE');
    const [head, tail] = (update.field as string).split('.');
    if (tail) shared[head!] ??= {};
    if (tail) (shared[head!] as Record<string, unknown>)[tail] = update.value;
    else shared[head!] = update.value;
    provenance[`shared.${update.field}`] = 'user';
  }
  // A walking outing implies a walking route unless the user explicitly chose
  // another way to travel between places. Do not require a second form question
  // for the most ordinary interpretation of «хочу погулять».
  if (!shared.mobility && /(?:по|про)гуля(?:ть|ться|ю|ем)|пройтись|пешую\s+прогулку/iu.test(text) &&
      !/машин|автомобил|такси|автобус|метро|трамва|велосипед|велике|общественн\w*\s+транспорт/iu.test(text)) {
    shared.mobility = ['walking'];
    provenance['shared.mobility'] = 'inferred_walk';
  }
  const days = proposal.days.map((day, index) => {
    const projected = projection.days[index]!, dayId = `day-${index + 1}`;
    const ids = new Map(day.activity_edits.map((a, i) => [a.activity_id, `${dayId}-activity-${i + 1}`]));
    for (const field of ['date', 'start', 'end'] as const) {
      const path = field === 'date' ? `days.${dayId}.date` : `days.${dayId}.window.${field}`;
      if (projected.origins?.[field]) provenance[path] = projected.origins[field];
    }
    return { day_id: dayId, date: projected.date,
      ...(projected.window ? { window: projected.window } : {}),
      ...(projected.duration_constraint_minutes != null ? { duration_constraint_minutes: projected.duration_constraint_minutes } : {}),
      activities: day.activity_edits.map(a => {
        const match = day.category_matches.find(c => c.activity_id === a.activity_id)!;
        return { id: ids.get(a.activity_id), label: a.label, selection: a.selection, requirements: a.requirements,
          categories: { state: match.state, include_any: match.include_any, exclude: match.exclude,
            region_id: context.catalog.region_id, catalog_version: context.catalog.version } };
      }),
      order: day.order_changes.filter(e => e.op === 'add').map(e => [ids.get(e.before), ids.get(e.after)]),
    };
  });
  const draft = FormDraft.safeParse({ locality: context.locality, shared, points: {}, days });
  if (!draft.success) throw new InitialIntentError('INTENT_INVALID_RESPONSE', 422,
    { stage: 'draft', fields: draft.error.issues.slice(0, 12).map(issue => ({ path: issue.path.join('.'), code: issue.code })) });
  return { status: 'draft', draft: draft.data, provenance };
}
