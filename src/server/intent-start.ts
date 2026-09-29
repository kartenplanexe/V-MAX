import { z } from 'zod';
import { FormDraft, type PlanningView } from '../shared/planning-form.js';
import { buildDailyRepairRequest, buildDailyRequest } from './intent/daily-contract.mjs';
import { projectNewDailyIntent } from './intent/daily-time.mjs';
import { classifyActivityIntent } from './activity-intent.js';
import { buildInitialCategoryRequest } from './intent/initial-wire.mjs';
import { resolveGenericCategories } from './intent/generic-categories.mjs';
import { inspectTimeLiteralCoverage } from './intent/time-literal-coverage.mjs';
import { reviewBudgetAssertion } from './budget-assertion.js';
import { relativeDateDays, dateAfter, overlapsBusyTime } from './intent-scalar-evidence.js';


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
  date_anchor: { value: { kind: string; days?: number }; evidence: string } | null;
  unresolved: { field: string; day_ids: string[]; text: string; reason: string }[];
  shared_updates: { op: string; field: string; value: unknown; evidence: string }[];
  days: { day_id: string; date: { kind: string; days?: number }; date_evidence: string | null; activity_edits: { activity_id: string; label: string; evidence: string;
    selection: { named_types: string[]; category_policy: string }; requirements: unknown[] }[];
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
  const extract = (value: unknown) => {
    if (value && typeof value === 'object' && 'kind' in value && value.kind === 'initial_extraction_v1' && 'proposal' in value)
      return { proposal: value.proposal, requiresMapping: true };
    return { proposal: value, requiresMapping: false };
  };
  const project = (value: unknown) => {
    const result = projectNewDailyIntent(value, input, { allowInitialPartial: true });
    if (result.guard.proposal) {
      const coverage = inspectTimeLiteralCoverage(result.guard.proposal, text);
      if (coverage.errors.length) {
        result.guard.errors.push(...coverage.errors);
        result.guard.proposal = null; result.guard.status = 'needs_clarification';
        result.status = 'needs_clarification';
      }
    }
    const valid = result.guard.proposal as { action: string;
      days: { time_updates: { op: string; field: string }[] }[] } | null;
    if (valid?.action === 'new_request') {
      const projectedDays = result.days as { window?: unknown; issues?: string[] }[];
      const unrepresented = valid.days.flatMap((day, index) =>
        day.time_updates.some(update => update.op === 'set' && ['start', 'end'].includes(update.field)) &&
        !projectedDays[index]?.window ? [projectedDays[index]] : []);
      if (unrepresented.length) {
        // A valid user constraint can exceed the current form's window model.
        // Do not discard it or ask the model to change it merely to fit defaults.
        (result.guard.reasons as string[]).push(...new Set(['TIME_WINDOW_UNREPRESENTABLE',
          ...unrepresented.flatMap(day => day?.issues ?? [])]));
        result.guard.proposal = null; result.guard.status = 'needs_clarification';
        result.status = 'needs_clarification';
      }
    }
    return result;
  };
  let reply = extract(await provider(buildDailyRequest(input)));
  let raw = reply.proposal, calls = 1;
  let projection = project(raw);
  const repairable = new Set(['SCHEMA', 'CATEGORY_ID', 'NONCONTIGUOUS_OFFSETS',
    'ANCHOR_WITHOUT_OFFSETS', 'UNSUPPORTED_EVIDENCE', 'DATE_WITHOUT_EVIDENCE',
    'STRICT_CATEGORY_MISMATCH', 'SEMANTIC_ACTIVITY_MISSING', 'SEMANTIC_ACTIVITY_MERGED',
    'SEMANTIC_ACTIVITY_NEGATED', 'SEMANTIC_CATEGORY_MISMATCH', 'SEMANTIC_ORDER_MISSING', 'TIME_LITERAL_MISSING']);
  for (;;) {
    const errors = projection.guard.errors;
    if (calls < 2 && raw && typeof raw === 'object' && 'action' in raw && raw.action === 'new_request' &&
        errors.length > 0 && errors.every((error: string) => repairable.has(error))) {
      // All network phases share the same two-call budget, including correction.
      reply = extract(await provider(buildDailyRepairRequest(input, errors, raw))); calls++;
      raw = reply.proposal; projection = project(raw); continue;
    }
    const extracted = projection.guard.proposal as ValidatedProposal | null;
    if (!reply.requiresMapping || extracted?.action !== 'new_request' || !extracted.days.some(day => day.activity_edits.length)) break;
    const city = extracted.shared_updates.find(update => update.field === 'locality_text');
    if (city && (typeof city.value !== 'string' || name(city.value) !== name(context.locality.name)))
      throw new InitialIntentError('LOCALITY_RESOLUTION_REQUIRED');
    const resolved = resolveGenericCategories(extracted, context.catalog);
    if (resolved.pending.length && calls >= 2) {
      raw = resolved.proposal; reply = { proposal: raw, requiresMapping: false }; projection = project(raw); break;
    }
    raw = resolved.pending.length
      ? await provider(buildInitialCategoryRequest(input, resolved.proposal, resolved.pending)) : resolved.proposal;
    if (resolved.pending.length) calls++;
    reply = { proposal: raw, requiresMapping: false }; projection = project(raw);
  }
  // Check the final response too: a repair must never bypass trusted city resolution.
  if (raw && typeof raw === 'object' && 'shared_updates' in raw && Array.isArray(raw.shared_updates)) {
    const city = raw.shared_updates.find((u: unknown) => u && typeof u === 'object' && 'field' in u && u.field === 'locality_text');
    if (city && (typeof city.value !== 'string' || name(city.value) !== name(context.locality.name)))
      throw new InitialIntentError('LOCALITY_RESOLUTION_REQUIRED');
  }
  const proposal = projection.guard.proposal as ValidatedProposal | null;
  if (reply.requiresMapping && proposal?.days.some(day => day.activity_edits.length))
    throw new InitialIntentError('INTENT_NEEDS_CLARIFICATION', 422,
      { stage: 'category_mapping', reasons: ['CATEGORY_MAPPING_NOT_COMPLETED'] });
  if (proposal?.action === 'off_topic') return { status: 'off_topic' };
  const schemaIssues = 'schema_errors' in projection.guard && Array.isArray(projection.guard.schema_errors)
    ? projection.guard.schema_errors : [];
  if (!proposal) throw new InitialIntentError(projection.guard.status === 'needs_clarification' ||
    projection.guard.errors.some((error: string) => error.startsWith('SEMANTIC_')) ? 'INTENT_NEEDS_CLARIFICATION' : 'INTENT_INVALID_RESPONSE', 422,
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
  const days = proposal.days.map((day, index) => {
    const projected = projection.days[index]!, dayId = `day-${index + 1}`;
    const ids = new Map(day.activity_edits.map((a, i) => [a.activity_id, `${dayId}-activity-${i + 1}`]));
    for (const field of ['date', 'start', 'end'] as const) {
      const path = field === 'date' ? `days.${dayId}.date` : `days.${dayId}.window.${field}`;
      if (projected.origins?.[field]) provenance[path] = projected.origins[field];
    }
    return { day_id: dayId, date: projected.date as string | null,
      ...(projected.window ? { window: projected.window } : {}),
      ...(projected.duration_constraint_minutes != null ? { duration_constraint_minutes: projected.duration_constraint_minutes } : {}),
      activities: day.activity_edits.map(a => {
        const match = day.category_matches.find(c => c.activity_id === a.activity_id)!;
        return { id: ids.get(a.activity_id), label: a.label,
          intent_kind: classifyActivityIntent({ label: a.label, evidence: a.evidence,
            namedTypes: a.selection.named_types }), selection: a.selection, requirements: a.requirements,
          categories: { state: match.state, include_any: match.include_any, exclude: match.exclude,
            region_id: context.catalog.region_id, catalog_version: context.catalog.version } };
      }),
      order: day.order_changes.filter(e => e.op === 'add').map(e => [ids.get(e.before), ids.get(e.after)]),
    };
  });
  const scalarQuestions: { field: string; day_ids: string[]; text: string; reason: string }[] = [];
  for (const [index, day] of days.entries()) {
    const proposed = proposal.days[index]!;
    const anchorOffset = proposed.date.kind === 'anchor_offset' ? relativeDateDays(proposal.date_anchor?.evidence) : null;
    const relative = proposed.date.kind === 'anchor_offset' && anchorOffset !== null
      ? anchorOffset + (proposed.date.days ?? 0) : relativeDateDays(proposed.date_evidence);
    if (relative !== null) day.date = dateAfter(context.now, context.locality.timezone, relative);
    if (day.window && overlapsBusyTime(text, day.window)) {
      delete day.window;
      delete provenance[`days.${day.day_id}.window.start`]; delete provenance[`days.${day.day_id}.window.end`];
      scalarQuestions.push({ field: 'time', day_ids: [proposed.day_id], text: 'Укажите свободное время: распознанный интервал пересекается с занятостью.', reason: 'conflict' });
    }
  }
  if (Array.isArray(shared.mobility) && shared.mobility.includes('taxi')) {
    const taxiOnly = shared.mobility.length === 1;
    shared.mobility = [...new Set(shared.mobility.map(mode => mode === 'taxi' ? 'driving' : mode))];
    if (taxiOnly && shared.search_radius_meters === undefined) {
      shared.search_radius_meters = 30_000;
      provenance['shared.search_radius_meters'] = 'default_taxi';
    }
  }
  const budgetUpdate = proposal.shared_updates.find(update => update.field === 'budget');
  const budgetReview = reviewBudgetAssertion({ userText: text, evidence: budgetUpdate?.evidence,
    budgetKind: (shared.budget as { kind?: string } | undefined)?.kind,
    amountRub: (shared.budget as { amount_rub?: number } | undefined)?.amount_rub,
    hasBudgetQuestion: proposal.unresolved.some(issue => issue.field === 'budget') });
  if (budgetReview.discardBudget) { delete shared.budget; delete provenance['shared.budget']; }
  const questions = [...proposal.unresolved, ...scalarQuestions, ...(budgetReview.question ? [budgetReview.question] : [])];
  const clarifications = questions.map((issue, index) => ({ ...issue, id: `question-${index + 1}`,
    day_ids: issue.day_ids.map(id => `day-${proposal.days.findIndex(day => day.day_id === id) + 1}`) }));
  const draft = FormDraft.safeParse({ locality: context.locality, shared, points: {}, days,
    ...(clarifications.length ? { clarifications } : {}) });
  if (!draft.success) throw new InitialIntentError('INTENT_INVALID_RESPONSE', 422,
    { stage: 'draft', fields: draft.error.issues.slice(0, 12).map(issue => ({ path: issue.path.join('.'), code: issue.code })) });
  return { status: 'draft', draft: draft.data, provenance };
}
