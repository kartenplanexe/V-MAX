import { z } from 'zod';

export const PLANNER_SCHEMA_VERSION = 'planner-domain.v0.1' as const;

const OpaqueIdSchema = z.string().min(1).max(200);
const NonEmptyStringSchema = z.string().min(1);
const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const Rfc3339DateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u);

export const CoordinatesSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  })
  .strict();

export const EvidenceSchema = z
  .object({
    state: z.enum(['CONFIRMED', 'ESTIMATED', 'UNKNOWN', 'CONFLICTING', 'STALE', 'NOT_APPLICABLE']),
    source_kind: z.enum(['USER', 'PROVIDER', 'POLICY', 'DERIVED', 'NONE']),
    source_ref: NonEmptyStringSchema.optional(),
    observed_at: Rfc3339DateTimeSchema.optional(),
    fresh_until: Rfc3339DateTimeSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    policy_version: NonEmptyStringSchema.optional(),
  })
  .strict();

export const ReasonSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    message: NonEmptyStringSchema,
    field_path: NonEmptyStringSchema.optional(),
    recoverable: z.boolean().optional(),
  })
  .strict();

export const MoneyAmountSchema = z
  .object({
    amount_minor: z.number().int().nonnegative(),
    currency: z.literal('RUB'),
  })
  .strict();

export const TimeWindowSchema = z
  .object({
    local_date: LocalDateSchema,
    timezone: NonEmptyStringSchema,
    start_at: Rfc3339DateTimeSchema,
    end_at: Rfc3339DateTimeSchema,
  })
  .strict()
  .superRefine((window, context) => {
    if (Date.parse(window.end_at) <= Date.parse(window.start_at)) {
      context.addIssue({ code: 'custom', message: 'end_at must be after start_at', path: ['end_at'] });
    }
  });

export const PartialTimeWindowSchema = z
  .object({
    local_date: LocalDateSchema.optional(),
    timezone: NonEmptyStringSchema.optional(),
    start_at: Rfc3339DateTimeSchema.optional(),
    end_at: Rfc3339DateTimeSchema.optional(),
    raw_date_expression: z.string().optional(),
    raw_time_expression: z.string().optional(),
  })
  .strict();

export const LocalitySchema = z
  .object({
    canonical_locality_id: OpaqueIdSchema.optional(),
    display_name: NonEmptyStringSchema,
    country_code: z.literal('RU'),
    timezone: NonEmptyStringSchema,
    resolution_status: z.enum(['RESOLVED', 'AMBIGUOUS', 'UNRESOLVED']),
    center: CoordinatesSchema.optional(),
  })
  .strict();

export const OriginSchema = z
  .object({
    kind: z.enum(['CURRENT_LOCATION', 'USER_POINT', 'ADDRESS', 'AREA', 'UNKNOWN']),
    resolution_status: z.enum(['RESOLVED_POINT', 'RESOLVED_AREA', 'AMBIGUOUS', 'UNRESOLVED']),
    label: z.string().optional(),
    coordinates: CoordinatesSchema.optional(),
    radius_meters: z.number().int().nonnegative().optional(),
    evidence: EvidenceSchema.optional(),
  })
  .strict();

export const SearchScopeSchema = z
  .object({
    kind: z.enum(['LOCALITY_BOUNDARY', 'RADIUS_FROM_ORIGIN']),
    radius_meters: z.number().int().min(100).max(200_000).optional(),
    max_expandable_radius_meters: z.number().int().min(100).max(200_000).optional(),
  })
  .strict()
  .superRefine((scope, context) => {
    if (scope.kind === 'RADIUS_FROM_ORIGIN' && scope.radius_meters === undefined) {
      context.addIssue({ code: 'custom', message: 'radius_meters is required', path: ['radius_meters'] });
    }
  });

export const CompletionRequirementSchema = z
  .object({
    kind: z.enum(['END_ANYWHERE', 'RETURN_TO_ORIGIN', 'FIXED_DESTINATION']),
    destination: OriginSchema.optional(),
  })
  .strict()
  .superRefine((completion, context) => {
    if (completion.kind === 'FIXED_DESTINATION' && !completion.destination) {
      context.addIssue({ code: 'custom', message: 'destination is required', path: ['destination'] });
    }
  });

export const ParticipantsSchema = z
  .object({
    count: z.number().int().min(1).max(100),
    age_context: z.enum(['UNKNOWN', 'ALL_ADULTS', 'INCLUDES_MINOR', 'EXPLICIT_AGES']),
    ages: z.array(z.number().int().min(0).max(120)).max(100).optional(),
    group_context: z.enum(['UNKNOWN', 'SOLO', 'COUPLE', 'FRIENDS', 'FAMILY', 'OTHER']).optional(),
  })
  .strict();

export const BudgetSchema = z
  .object({
    state: z.enum(['UNSPECIFIED', 'LIMIT']),
    limit: MoneyAmountSchema.optional(),
    strictness: z.enum(['HARD', 'SOFT']).optional(),
  })
  .strict()
  .superRefine((budget, context) => {
    if (budget.state === 'LIMIT' && (!budget.limit || !budget.strictness)) {
      context.addIssue({ code: 'custom', message: 'limit and strictness are required', path: ['limit'] });
    }
  });

export const WeightedTagSchema = z
  .object({ tag: NonEmptyStringSchema, weight: z.number().min(0).max(1) })
  .strict();

export const InterestProfileSchema = z
  .object({
    taxonomy_version: NonEmptyStringSchema,
    themes: z.array(WeightedTagSchema),
    styles: z.array(WeightedTagSchema),
    environment: z.enum(['UNSPECIFIED', 'INDOOR', 'OUTDOOR', 'MIXED']).optional(),
    energy: z.enum(['UNSPECIFIED', 'LOW', 'MEDIUM', 'HIGH']).optional(),
    must_include: z.array(NonEmptyStringSchema),
    exclusions: z.array(NonEmptyStringSchema),
    variety: z.enum(['FOCUSED', 'BALANCED', 'EXPLORATORY']),
    raw_text: z.string().optional(),
  })
  .strict();

export const MobilitySchema = z
  .object({
    allowed_modes: z
      .array(z.enum(['WALKING', 'DRIVING', 'PUBLIC_TRANSPORT', 'TAXI', 'BICYCLE']))
      .min(1),
    max_single_walk_minutes: z.number().int().nonnegative().optional(),
    max_total_walk_minutes: z.number().int().nonnegative().optional(),
    accessibility_needs: z.array(NonEmptyStringSchema),
  })
  .strict();

export const FieldConstraintSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    operator: z.enum(['EQ', 'NEQ', 'IN', 'NOT_IN', 'LTE', 'GTE', 'REQUIRED']),
    value: z.unknown(),
    evidence: EvidenceSchema.optional(),
  })
  .strict();

export const ParseEvidenceSchema = z
  .object({
    field_path: NonEmptyStringSchema,
    value_origin: z.enum(['EXPLICIT', 'RESOLVED', 'POLICY_DEFAULT', 'INFERRED', 'USER_CONFIRMED']),
    span_start: z.number().int().nonnegative().optional(),
    span_end: z.number().int().nonnegative().optional(),
    confidence: z.number().min(0).max(1),
    interpretation: z.string().optional(),
  })
  .strict();

export const QuestionOptionSchema = z
  .object({
    option_id: OpaqueIdSchema,
    label: NonEmptyStringSchema,
    value: z.unknown(),
  })
  .strict();

export const ClarificationQuestionSchema = z
  .object({
    question_id: OpaqueIdSchema,
    priority: z.enum(['BLOCKER', 'SAFETY', 'QUALITY']),
    field_paths: z.array(NonEmptyStringSchema).min(1),
    answer_kind: z.enum([
      'SINGLE_CHOICE',
      'MULTI_CHOICE',
      'DATE',
      'TIME',
      'ADDRESS',
      'GEOLOCATION',
      'NUMBER',
      'BOOLEAN',
      'FREE_TEXT',
    ]),
    prompt: NonEmptyStringSchema,
    options: z.array(QuestionOptionSchema),
    apply_scope: z.enum(['CURRENT_DAY', 'ALL_DAYS', 'REQUEST']),
    blocking: z.boolean(),
  })
  .strict()
  .superRefine((question, context) => {
    if (
      ['SINGLE_CHOICE', 'MULTI_CHOICE'].includes(question.answer_kind) &&
      question.options.length === 0
    ) {
      context.addIssue({ code: 'custom', message: 'choice question requires options', path: ['options'] });
    }
  });

const ClarificationFields = {
  missing_fields: z.array(NonEmptyStringSchema),
  reasons: z.array(ReasonSchema),
  questions: z.array(ClarificationQuestionSchema),
} as const;

export const DraftClarificationSchema = z
  .object({
    state: z.enum(['NEEDS_CLARIFICATION', 'READY_FOR_CONFIRMATION']),
    ...ClarificationFields,
  })
  .strict()
  .superRefine((clarification, context) => {
    if (clarification.state === 'NEEDS_CLARIFICATION' && clarification.questions.length === 0) {
      context.addIssue({ code: 'custom', message: 'clarification requires a question', path: ['questions'] });
    }
    if (
      clarification.state === 'READY_FOR_CONFIRMATION' &&
      (clarification.missing_fields.length > 0 || clarification.questions.length > 0)
    ) {
      context.addIssue({ code: 'custom', message: 'confirmation draft must have no pending fields', path: [] });
    }
  });

export const ReadyClarificationSchema = z
  .object({ state: z.literal('READY'), ...ClarificationFields })
  .strict()
  .superRefine((clarification, context) => {
    if (clarification.missing_fields.length > 0 || clarification.questions.length > 0) {
      context.addIssue({ code: 'custom', message: 'ready request must have no pending fields', path: [] });
    }
  });

const PlanningFields = {
  locality: LocalitySchema,
  window: TimeWindowSchema,
  origin: OriginSchema,
  search_scope: SearchScopeSchema,
  completion: CompletionRequirementSchema,
  participants: ParticipantsSchema,
  budget: BudgetSchema,
  interest_profile: InterestProfileSchema,
  mobility: MobilitySchema,
  hard_constraints: z.array(FieldConstraintSchema),
  soft_preferences: z.array(WeightedTagSchema),
  parse_evidence: z.array(ParseEvidenceSchema),
} as const;

export const PlanningRequestDraftSchema = z
  .object({
    schema_version: z.literal(PLANNER_SCHEMA_VERSION),
    draft_id: OpaqueIdSchema,
    created_at: Rfc3339DateTimeSchema,
    raw_text: z.string().optional(),
    locality_text: z.string().optional(),
    locality: LocalitySchema.optional(),
    window: PartialTimeWindowSchema.optional(),
    origin: OriginSchema.optional(),
    search_scope: SearchScopeSchema.optional(),
    completion: CompletionRequirementSchema.optional(),
    participants: ParticipantsSchema.optional(),
    budget: BudgetSchema.optional(),
    interest_profile: InterestProfileSchema.optional(),
    mobility: MobilitySchema.optional(),
    hard_constraints: z.array(FieldConstraintSchema).optional(),
    soft_preferences: z.array(WeightedTagSchema).optional(),
    parse_evidence: z.array(ParseEvidenceSchema),
    clarification: DraftClarificationSchema,
  })
  .strict()
  .superRefine((draft, context) => {
    if (draft.clarification.state !== 'READY_FOR_CONFIRMATION') return;
    for (const field of Object.keys(PlanningFields) as (keyof typeof PlanningFields)[]) {
      if (field === 'parse_evidence') continue;
      if (draft[field] === undefined) {
        context.addIssue({ code: 'custom', message: `${field} is required before confirmation`, path: [field] });
      }
    }
    if (draft.locality?.resolution_status !== 'RESOLVED') {
      context.addIssue({ code: 'custom', message: 'locality must be resolved', path: ['locality'] });
    }
    if (draft.origin?.resolution_status !== 'RESOLVED_POINT' || !draft.origin.coordinates) {
      context.addIssue({ code: 'custom', message: 'origin must be a resolved point', path: ['origin'] });
    }
    if (!draft.window?.start_at || !draft.window.end_at) {
      context.addIssue({ code: 'custom', message: 'window must be complete', path: ['window'] });
    } else if (Date.parse(draft.window.end_at) <= Date.parse(draft.window.start_at)) {
      context.addIssue({ code: 'custom', message: 'window end must be after start', path: ['window', 'end_at'] });
    }
  });

export const PlanningRequestSchema = z
  .object({
    schema_version: z.literal(PLANNER_SCHEMA_VERSION),
    request_id: OpaqueIdSchema,
    created_at: Rfc3339DateTimeSchema,
    ...PlanningFields,
    clarification: ReadyClarificationSchema,
    confirmation_status: z.enum(['CONFIRMED', 'AMENDED']),
  })
  .strict();

export const MultiDayPlanningRequestSchema = z
  .object({
    schema_version: z.literal(PLANNER_SCHEMA_VERSION),
    multi_request_id: OpaqueIdSchema,
    created_at: Rfc3339DateTimeSchema,
    days: z.array(PlanningRequestSchema).min(1),
  })
  .strict();

export type Coordinates = z.infer<typeof CoordinatesSchema>;
export type Locality = z.infer<typeof LocalitySchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type PlanningRequestDraft = z.infer<typeof PlanningRequestDraftSchema>;
export type PlanningRequest = z.infer<typeof PlanningRequestSchema>;
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;
