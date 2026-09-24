import { describe, expect, it } from 'vitest';

import {
  ClarificationQuestionSchema,
  type Locality,
  type Origin,
  PlanningRequestDraftSchema,
} from '../shared/planner-domain.js';
import {
  confirmPlanningRequestDraft,
  parsePlanningRequestDraft,
  selectNextClarificationQuestion,
} from './intent-parser.js';

const locality: Locality = {
  canonical_locality_id: 'locality:nizhny-novgorod',
  country_code: 'RU',
  display_name: 'Нижний Новгород',
  resolution_status: 'RESOLVED',
  timezone: 'Europe/Moscow',
};

const origin: Origin = {
  coordinates: { lat: 56.3269, lon: 44.0059 },
  evidence: { confidence: 1, source_kind: 'USER', state: 'CONFIRMED' },
  kind: 'USER_POINT',
  label: 'Тестовая стартовая точка',
  resolution_status: 'RESOLVED_POINT',
};

const baseInput = {
  createdAt: new Date('2026-09-21T10:00:00Z'),
  draftId: 'draft:test',
  locality,
  localityText: 'Нижний Новгород',
  origin,
};

describe('parsePlanningRequestDraft', () => {
  it('creates a confirmation-ready typed draft from a complete explicit request', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: 'Завтра я свободен с 12 до 16, бюджет до 3000 рублей, хочу музей и поесть, пешком и на автобусе.',
    });

    expect(draft.clarification).toEqual({
      missing_fields: [],
      questions: [],
      reasons: [],
      state: 'READY_FOR_CONFIRMATION',
    });
    expect(draft.window).toMatchObject({
      end_at: '2026-09-22T16:00:00+03:00',
      local_date: '2026-09-22',
      start_at: '2026-09-22T12:00:00+03:00',
      timezone: 'Europe/Moscow',
    });
    expect(draft.budget).toEqual({
      limit: { amount_minor: 300_000, currency: 'RUB' },
      state: 'LIMIT',
      strictness: 'HARD',
    });
    expect(draft.mobility?.allowed_modes).toEqual(['WALKING', 'PUBLIC_TRANSPORT']);
    expect(draft.interest_profile?.themes.map(({ tag }) => tag)).toEqual([
      'culture.museum_history',
      'food.restaurant_cafe',
    ]);
    expect(PlanningRequestDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('keeps an open-ended multi-day window blocked and applies the answer to all days', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: 'Три дня я свободен после 16, хочу музей, пешком.',
    });

    expect(draft.window?.start_at).toBeUndefined();
    expect(draft.window?.raw_time_expression).toBe('после 16');
    expect(draft.clarification.missing_fields).toContain('window.end_at');
    expect(draft.clarification.questions).toContainEqual(
      expect.objectContaining({
        apply_scope: 'ALL_DAYS',
        field_paths: ['window.end_at'],
        question_id: 'question:end-time',
      }),
    );
  });

  it('asks for locality first instead of guessing a city', () => {
    const draft = parsePlanningRequestDraft({
      createdAt: baseInput.createdAt,
      draftId: 'draft:no-locality',
      text: 'Завтра я свободен с 12 до 16, хочу музей, пешком.',
    });

    expect(selectNextClarificationQuestion(draft)?.question_id).toBe('question:locality');
    expect(draft.locality).toBeUndefined();
  });

  it('keeps the single interest question non-blocking when all hard fields are known', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: '2026-09-23 я свободен с 12 до 16, пешком.',
    });

    expect(draft.clarification.state).toBe('NEEDS_CLARIFICATION');
    expect(draft.clarification.missing_fields).toEqual([]);
    expect(selectNextClarificationQuestion(draft)).toMatchObject({
      blocking: false,
      priority: 'QUALITY',
      question_id: 'question:interests',
    });
  });

  it('does not guess what “без бюджета” means', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: '2026-09-23 я свободен с 12 до 16, без бюджета, хочу музей, пешком.',
    });

    expect(selectNextClarificationQuestion(draft)).toMatchObject({
      field_paths: ['budget.state'],
      question_id: 'question:budget-ambiguous',
    });
    expect(draft.budget).toEqual({ state: 'UNSPECIFIED' });
  });

  it('accepts an explicit exploratory preference without repeating the interest question', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: '2026-09-23 я свободен с 12 до 16, пешком, не знаю — удивите меня.',
    });

    expect(draft.interest_profile?.variety).toBe('EXPLORATORY');
    expect(draft.clarification.questions).toEqual([]);
    expect(draft.clarification.state).toBe('READY_FOR_CONFIRMATION');
  });

  it('asks for group size when the user says “мы” without a number', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: '2026-09-23 мы свободны с 12 до 16, хотим музей, пешком.',
    });

    expect(selectNextClarificationQuestion(draft)).toMatchObject({
      field_paths: ['participants.count'],
      priority: 'SAFETY',
      question_id: 'question:participants',
    });
  });

  it('turns a reversed same-day interval into a blocking correction', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: '2026-09-23 я свободен с 16 до 12, хочу музей, пешком.',
    });

    expect(draft.window?.start_at).toBe('2026-09-23T16:00:00+03:00');
    expect(draft.window?.end_at).toBeUndefined();
    expect(draft.clarification.reasons).toContainEqual(
      expect.objectContaining({ code: 'WINDOW_NOT_POSITIVE', field_path: 'window.end_at' }),
    );
  });

  it('asks for a correction when the explicit calendar date does not exist', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: '31.02.2026 я свободен с 12 до 16, хочу музей, пешком.',
    });

    expect(draft.window?.local_date).toBeUndefined();
    expect(draft.clarification.reasons).toContainEqual(
      expect.objectContaining({ code: 'DATE_UNRESOLVED', field_path: 'window.local_date' }),
    );
  });
});

describe('planner request schemas', () => {
  it('creates a planner input only after explicit confirmation', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: '2026-09-23 я свободен с 12 до 16, хочу музей, пешком.',
    });

    const request = confirmPlanningRequestDraft(draft, 'request:test');

    expect(request).toMatchObject({
      confirmation_status: 'CONFIRMED',
      request_id: 'request:test',
      schema_version: 'planner-domain.v0.1',
    });
    expect(request.clarification).toEqual({
      missing_fields: [],
      questions: [],
      reasons: [],
      state: 'READY',
    });
    expect(request).not.toHaveProperty('raw_text');
  });

  it('refuses to create planner input while a blocker remains', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: '2026-09-23 я свободен после 16, хочу музей, пешком.',
    });

    expect(() => confirmPlanningRequestDraft(draft, 'request:blocked')).toThrow(
      'clarification is pending',
    );
  });

  it('rejects choice questions without options', () => {
    const parsed = ClarificationQuestionSchema.safeParse({
      answer_kind: 'MULTI_CHOICE',
      apply_scope: 'REQUEST',
      blocking: true,
      field_paths: ['mobility.allowed_modes'],
      options: [],
      priority: 'BLOCKER',
      prompt: 'Как передвигаться?',
      question_id: 'question:mobility',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects undeclared fields in the canonical draft', () => {
    const draft = parsePlanningRequestDraft({
      ...baseInput,
      text: '2026-09-23 я свободен с 12 до 16, хочу музей, пешком.',
    });
    const parsed = PlanningRequestDraftSchema.safeParse({ ...draft, provider_payload: { hidden: true } });

    expect(parsed.success).toBe(false);
  });
});
