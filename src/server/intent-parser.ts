import {
  type ClarificationQuestion,
  type Locality,
  type Origin,
  PLANNER_SCHEMA_VERSION,
  type PlanningRequest,
  type PlanningRequestDraft,
  PlanningRequestDraftSchema,
  PlanningRequestSchema,
} from '../shared/planner-domain.js';

export interface ParsePlanningRequestInput {
  createdAt: Date;
  draftId: string;
  locality?: Locality;
  localityText?: string;
  origin?: Origin;
  text: string;
}

type ParseEvidence = PlanningRequestDraft['parse_evidence'];
type MobilityMode = NonNullable<PlanningRequestDraft['mobility']>['allowed_modes'][number];

const INTEREST_RULES = [
  { pattern: /музе(?:й|и|я|ев)|истори|выстав/iu, tag: 'culture.museum_history' },
  { pattern: /театр|спектак/iu, tag: 'culture.theatre' },
  { pattern: /концерт|музык/iu, tag: 'culture.live_music' },
  { pattern: /кино|фильм/iu, tag: 'culture.cinema' },
  { pattern: /поесть|еда|ресторан|кафе|кофе/iu, tag: 'food.restaurant_cafe' },
  { pattern: /парк|прогул|на природе|набережн/iu, tag: 'outdoor.walk_park' },
  { pattern: /спорт|скалодром|каток|велопрогул/iu, tag: 'active.sport' },
] as const;

const MOBILITY_OPTIONS = [
  { option_id: 'mobility:walking', label: 'Пешком', value: ['WALKING'] },
  {
    option_id: 'mobility:public',
    label: 'Пешком + общественный транспорт',
    value: ['WALKING', 'PUBLIC_TRANSPORT'],
  },
  { option_id: 'mobility:car', label: 'Автомобиль или такси', value: ['DRIVING', 'TAXI'] },
  {
    option_id: 'mobility:any',
    label: 'Неважно',
    value: ['WALKING', 'PUBLIC_TRANSPORT', 'DRIVING', 'TAXI'],
  },
] as const;

const INTEREST_OPTIONS = [
  { option_id: 'interest:culture', label: 'Культура', value: ['culture.museum_history'] },
  { option_id: 'interest:food', label: 'Еда и кофе', value: ['food.restaurant_cafe'] },
  { option_id: 'interest:outdoor', label: 'Прогулки', value: ['outdoor.walk_park'] },
  { option_id: 'interest:active', label: 'Активный отдых', value: ['active.sport'] },
  { option_id: 'interest:explore', label: 'Удивите меня', value: { variety: 'EXPLORATORY' } },
] as const;

export function parsePlanningRequestDraft(input: ParsePlanningRequestInput): PlanningRequestDraft {
  const text = input.text.trim();
  if (!text) throw new Error('Planning request text must not be empty.');
  if (!Number.isFinite(input.createdAt.getTime())) throw new Error('createdAt must be a valid date.');

  const evidence: ParseEvidence = [];
  const questions: ClarificationQuestion[] = [];
  const missingFields: string[] = [];
  const reasons: Array<{
    code: string;
    field_path: string;
    message: string;
    recoverable: boolean;
  }> = [];

  const addQuestion = (
    fieldPath: string,
    reasonCode: string,
    reasonMessage: string,
    question: ClarificationQuestion,
    markMissing = question.blocking,
  ) => {
    if (markMissing && !missingFields.includes(fieldPath)) missingFields.push(fieldPath);
    if (markMissing) {
      reasons.push({ code: reasonCode, field_path: fieldPath, message: reasonMessage, recoverable: true });
    }
    questions.push(question);
  };

  const locality = input.locality;
  const localityResolved = locality?.resolution_status === 'RESOLVED';
  if (!localityResolved) {
    addQuestion(
      'locality',
      locality?.resolution_status === 'AMBIGUOUS' ? 'LOCALITY_AMBIGUOUS' : 'LOCALITY_REQUIRED',
      locality?.resolution_status === 'AMBIGUOUS'
        ? 'Нужно выбрать конкретный населённый пункт и регион.'
        : 'Нужно указать населённый пункт.',
      question({
        answer_kind: 'FREE_TEXT',
        field_paths: ['locality'],
        id: 'question:locality',
        prompt: 'В каком городе или населённом пункте планируем досуг?',
      }),
    );
  }

  const referenceLocalDate = localityResolved
    ? localDateAtInstant(input.createdAt, locality.timezone)
    : undefined;
  const parsedDate = parseDate(text, referenceLocalDate);
  const parsedTime = parseTimeWindow(text);
  const window: NonNullable<PlanningRequestDraft['window']> = {};

  if (parsedDate.expression) window.raw_date_expression = parsedDate.expression;
  if (parsedDate.localDate) window.local_date = parsedDate.localDate;
  if (parsedTime.expression) window.raw_time_expression = parsedTime.expression;
  if (localityResolved) window.timezone = locality.timezone;

  if (parsedDate.localDate && localityResolved && parsedTime.start) {
    window.start_at = localDateTimeToRfc3339(parsedDate.localDate, parsedTime.start, locality.timezone);
  }
  if (parsedDate.localDate && localityResolved && parsedTime.end) {
    window.end_at = localDateTimeToRfc3339(parsedDate.localDate, parsedTime.end, locality.timezone);
  }
  const invalidWindowOrder = Boolean(
    window.start_at && window.end_at && Date.parse(window.end_at) <= Date.parse(window.start_at),
  );
  if (invalidWindowOrder) delete window.end_at;

  if (parsedDate.match && parsedDate.localDate) {
    evidence.push(matchEvidence('window.local_date', parsedDate.match, text, `Дата ${parsedDate.localDate}`));
  }
  if (!parsedDate.expression) {
    addQuestion(
      'window.local_date',
      'DATE_REQUIRED',
      'Нужно указать дату плана.',
      question({
        answer_kind: 'DATE',
        field_paths: ['window.local_date'],
        id: 'question:date',
        prompt: 'На какую дату составить план?',
      }),
    );
  } else if (!parsedDate.localDate && localityResolved) {
    addQuestion(
      'window.local_date',
      'DATE_UNRESOLVED',
      'Не удалось однозначно определить дату.',
      question({
        answer_kind: 'DATE',
        field_paths: ['window.local_date'],
        id: 'question:date',
        prompt: 'Уточните дату плана.',
      }),
    );
  }

  if (parsedTime.start && parsedTime.match) {
    evidence.push(matchEvidence('window.start_at', parsedTime.match, text, `Начало ${parsedTime.start}`));
  } else {
    addQuestion(
      'window.start_at',
      'START_TIME_REQUIRED',
      'Нужно указать начало свободного времени.',
      question({
        answer_kind: 'TIME',
        field_paths: ['window.start_at'],
        id: 'question:start-time',
        prompt: 'С какого времени вы свободны?',
        scope: isMultiDay(text) ? 'ALL_DAYS' : 'CURRENT_DAY',
      }),
    );
  }

  if (parsedTime.end && parsedTime.match && !invalidWindowOrder) {
    evidence.push(matchEvidence('window.end_at', parsedTime.match, text, `Окончание ${parsedTime.end}`));
  } else {
    addQuestion(
      'window.end_at',
      invalidWindowOrder ? 'WINDOW_NOT_POSITIVE' : 'END_TIME_REQUIRED',
      invalidWindowOrder
        ? 'Конец дневного окна должен быть позже начала.'
        : 'Нужно указать конец свободного времени.',
      question({
        answer_kind: 'TIME',
        field_paths: ['window.end_at'],
        id: 'question:end-time',
        prompt: invalidWindowOrder
          ? 'Уточните время окончания: оно должно быть позже начала.'
          : 'До какого времени вы свободны?',
        scope: isMultiDay(text) ? 'ALL_DAYS' : 'CURRENT_DAY',
      }),
    );
  }

  const origin = input.origin;
  if (origin?.resolution_status !== 'RESOLVED_POINT' || !origin.coordinates) {
    addQuestion(
      'origin',
      'ORIGIN_REQUIRED',
      'Для проверяемого маршрута нужна точная стартовая точка.',
      question({
        answer_kind: 'GEOLOCATION',
        field_paths: ['origin'],
        id: 'question:origin',
        prompt: 'Откуда удобнее начать маршрут?',
      }),
    );
  }

  const mobility = parseMobility(text, evidence);
  if (!mobility) {
    addQuestion(
      'mobility.allowed_modes',
      'MOBILITY_REQUIRED',
      'Без способа передвижения нельзя проверить время в пути.',
      question({
        answer_kind: 'MULTI_CHOICE',
        field_paths: ['mobility.allowed_modes'],
        id: 'question:mobility',
        options: [...MOBILITY_OPTIONS],
        prompt: 'Как вы готовы передвигаться?',
      }),
    );
  }

  const participants = parseParticipants(text, evidence);
  if (!participants) {
    addQuestion(
      'participants.count',
      'PARTICIPANT_COUNT_REQUIRED',
      'Формулировка указывает на группу, но её размер неизвестен.',
      question({
        answer_kind: 'NUMBER',
        field_paths: ['participants.count'],
        id: 'question:participants',
        priority: 'SAFETY',
        prompt: 'Сколько человек будет в вашей компании?',
      }),
    );
  }

  const parsedBudget = parseBudget(text, evidence);
  if (parsedBudget.ambiguous) {
    addQuestion(
      'budget.state',
      'BUDGET_AMBIGUOUS',
      'Фраза «без бюджета» может означать только бесплатные места или отсутствие лимита.',
      question({
        answer_kind: 'SINGLE_CHOICE',
        field_paths: ['budget.state'],
        id: 'question:budget-ambiguous',
        options: [
          {
            option_id: 'budget:free-only',
            label: 'Только бесплатно',
            value: { limit: { amount_minor: 0, currency: 'RUB' }, state: 'LIMIT', strictness: 'HARD' },
          },
          { option_id: 'budget:no-limit', label: 'Лимита нет', value: { state: 'UNSPECIFIED' } },
        ],
        prompt: 'Что вы имеете в виду под «без бюджета»?',
      }),
    );
  }

  const interestProfile = parseInterests(text, evidence);
  if (!interestProfile) {
    addQuestion(
      'interest_profile',
      'INTERESTS_UNSPECIFIED',
      'Интересы не указаны.',
      question({
        answer_kind: 'MULTI_CHOICE',
        blocking: false,
        field_paths: ['interest_profile'],
        id: 'question:interests',
        options: [...INTEREST_OPTIONS],
        priority: 'QUALITY',
        prompt: 'Что вам сейчас интереснее?',
      }),
      false,
    );
  }

  const completion = parseCompletion(text, evidence);
  const draft = {
    schema_version: PLANNER_SCHEMA_VERSION,
    draft_id: input.draftId,
    created_at: input.createdAt.toISOString(),
    raw_text: text,
    ...(input.localityText ? { locality_text: input.localityText } : {}),
    ...(locality ? { locality } : {}),
    ...(Object.keys(window).length > 0 ? { window } : {}),
    ...(origin ? { origin } : {}),
    search_scope: { kind: 'LOCALITY_BOUNDARY' as const },
    completion,
    ...(participants ? { participants } : {}),
    budget: parsedBudget.budget ?? { state: 'UNSPECIFIED' as const },
    ...(interestProfile ? { interest_profile: interestProfile } : {}),
    ...(mobility ? { mobility } : {}),
    hard_constraints: [],
    soft_preferences: [],
    parse_evidence: evidence,
    clarification: {
      state: questions.length > 0 ? ('NEEDS_CLARIFICATION' as const) : ('READY_FOR_CONFIRMATION' as const),
      missing_fields: missingFields,
      reasons,
      questions,
    },
  };

  return PlanningRequestDraftSchema.parse(draft);
}

export function selectNextClarificationQuestion(
  draft: PlanningRequestDraft,
): ClarificationQuestion | undefined {
  const priority = { BLOCKER: 0, SAFETY: 1, QUALITY: 2 } as const;
  return [...draft.clarification.questions].sort(
    (left, right) => priority[left.priority] - priority[right.priority],
  )[0];
}

export function confirmPlanningRequestDraft(
  draftInput: PlanningRequestDraft,
  requestId: string,
  confirmationStatus: 'CONFIRMED' | 'AMENDED' = 'CONFIRMED',
): PlanningRequest {
  const draft = PlanningRequestDraftSchema.parse(draftInput);
  if (draft.clarification.state !== 'READY_FOR_CONFIRMATION') {
    throw new Error('Planning request cannot be confirmed while clarification is pending.');
  }

  return PlanningRequestSchema.parse({
    schema_version: PLANNER_SCHEMA_VERSION,
    request_id: requestId,
    created_at: draft.created_at,
    locality: draft.locality,
    window: draft.window
      ? {
          local_date: draft.window.local_date,
          timezone: draft.window.timezone,
          start_at: draft.window.start_at,
          end_at: draft.window.end_at,
        }
      : undefined,
    origin: draft.origin,
    search_scope: draft.search_scope,
    completion: draft.completion,
    participants: draft.participants,
    budget: draft.budget,
    interest_profile: draft.interest_profile,
    mobility: draft.mobility,
    hard_constraints: draft.hard_constraints,
    soft_preferences: draft.soft_preferences,
    parse_evidence: draft.parse_evidence,
    clarification: { state: 'READY', missing_fields: [], reasons: [], questions: [] },
    confirmation_status: confirmationStatus,
  });
}

function question(input: {
  answer_kind: ClarificationQuestion['answer_kind'];
  blocking?: boolean;
  field_paths: string[];
  id: string;
  options?: ClarificationQuestion['options'];
  priority?: ClarificationQuestion['priority'];
  prompt: string;
  scope?: ClarificationQuestion['apply_scope'];
}): ClarificationQuestion {
  return {
    question_id: input.id,
    priority: input.priority ?? 'BLOCKER',
    field_paths: input.field_paths,
    answer_kind: input.answer_kind,
    prompt: input.prompt,
    options: input.options ?? [],
    apply_scope: input.scope ?? 'REQUEST',
    blocking: input.blocking ?? true,
  };
}

function parseDate(text: string, referenceLocalDate: string | undefined) {
  const iso = text.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/u);
  if (iso) {
    return {
      expression: iso[0],
      localDate: isValidLocalDate(iso[0]) ? iso[0] : undefined,
      match: iso,
    };
  }

  const numeric = text.match(/(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{4})(?!\d)/u);
  if (numeric) {
    const localDate = `${numeric[3]}-${numeric[2]?.padStart(2, '0')}-${numeric[1]?.padStart(2, '0')}`;
    return {
      expression: numeric[0],
      localDate: isValidLocalDate(localDate) ? localDate : undefined,
      match: numeric,
    };
  }

  const relativeRules = [
    { days: 2, pattern: /послезавтра/iu },
    { days: 1, pattern: /завтра/iu },
    { days: 0, pattern: /сегодня/iu },
  ];
  for (const rule of relativeRules) {
    const match = text.match(rule.pattern);
    if (match) {
      return {
        expression: match[0],
        localDate: referenceLocalDate ? addLocalDays(referenceLocalDate, rule.days) : undefined,
        match,
      };
    }
  }
  return { expression: undefined, localDate: undefined, match: undefined };
}

function parseTimeWindow(text: string) {
  const interval = text.match(
    /(?:^|\s|[,;])(?:с\s*)?([01]?\d|2[0-3])(?::([0-5]\d))?\s*(?:до|[-–—])\s*([01]?\d|2[0-3])(?::([0-5]\d))?(?=$|\s|[,;.])/iu,
  );
  if (interval) {
    return {
      end: normalizeTime(interval[3], interval[4]),
      expression: interval[0].trim(),
      match: interval,
      start: normalizeTime(interval[1], interval[2]),
    };
  }

  const after = text.match(/(?:^|\s|[,;])после\s*([01]?\d|2[0-3])(?::([0-5]\d))?(?=$|\s|[,;.])/iu);
  if (after) {
    return {
      end: undefined,
      expression: after[0].trim(),
      match: after,
      start: normalizeTime(after[1], after[2]),
    };
  }
  return { end: undefined, expression: undefined, match: undefined, start: undefined };
}

function parseBudget(text: string, evidence: ParseEvidence) {
  const ambiguous = text.match(/без\s+бюджет[а-я]*/iu);
  if (ambiguous) return { ambiguous: true, budget: undefined };

  const match =
    text.match(/бюджет(?:ом)?\s*(?:до\s*)?([0-9][0-9\s]{0,8})(?:\s*(?:₽|руб(?:лей|ля|ль)?))?/iu) ??
    text.match(/до\s*([0-9][0-9\s]{0,8})\s*(?:₽|руб(?:лей|ля|ль)?)/iu);
  if (!match?.[1]) return { ambiguous: false, budget: { state: 'UNSPECIFIED' as const } };

  const rubles = Number(match[1].replaceAll(/\s/gu, ''));
  if (!Number.isSafeInteger(rubles) || rubles < 0) {
    return { ambiguous: false, budget: { state: 'UNSPECIFIED' as const } };
  }
  evidence.push(matchEvidence('budget.limit', match, text, `Лимит ${rubles} ₽`));
  return {
    ambiguous: false,
    budget: {
      state: 'LIMIT' as const,
      limit: { amount_minor: rubles * 100, currency: 'RUB' as const },
      strictness: 'HARD' as const,
    },
  };
}

function parseMobility(text: string, evidence: ParseEvidence) {
  const rules: Array<{ mode: MobilityMode; pattern: RegExp }> = [
    { mode: 'WALKING', pattern: /пеш(?:ком|ий|ая|ие)/iu },
    { mode: 'PUBLIC_TRANSPORT', pattern: /общественн\w*\s+транспорт|метро|автобус|трамва|троллей/iu },
    { mode: 'DRIVING', pattern: /машин|автомобил/iu },
    { mode: 'TAXI', pattern: /такси/iu },
    { mode: 'BICYCLE', pattern: /велосипед/iu },
  ];
  const modes: MobilityMode[] = [];
  for (const rule of rules) {
    const match = text.match(rule.pattern);
    if (!match || modes.includes(rule.mode)) continue;
    modes.push(rule.mode);
    evidence.push(matchEvidence('mobility.allowed_modes', match, text, rule.mode));
  }
  if (modes.length === 0) return undefined;
  return { allowed_modes: modes, accessibility_needs: [] };
}

function parseParticipants(text: string, evidence: ParseEvidence) {
  const explicit = text.match(/(?<!\d)(\d{1,3})\s*(?:человек|участник(?:а|ов)?)(?!\p{L})/iu);
  if (explicit?.[1]) {
    const count = Number(explicit[1]);
    if (count >= 1 && count <= 100) {
      evidence.push(matchEvidence('participants.count', explicit, text, `${count} участников`));
      return { age_context: 'UNKNOWN' as const, count, group_context: count === 1 ? ('SOLO' as const) : ('OTHER' as const) };
    }
  }

  const pair = text.match(/вдво[её]м/iu);
  if (pair) {
    evidence.push(matchEvidence('participants.count', pair, text, '2 участника'));
    return { age_context: 'UNKNOWN' as const, count: 2, group_context: 'COUPLE' as const };
  }
  const trio = text.match(/втро[её]м/iu);
  if (trio) {
    evidence.push(matchEvidence('participants.count', trio, text, '3 участника'));
    return { age_context: 'UNKNOWN' as const, count: 3, group_context: 'FRIENDS' as const };
  }
  if (/(?:^|\s)(?:мы|нас)(?=$|\s|[,;.])|с\s+(?:друзьями|семь[её]й|компанией)/iu.test(text)) return undefined;

  const singular = text.match(/(?:^|\s)(?:я|мне|хочу|свободен|свободна)(?=$|\s|[,;.])/iu);
  if (!singular) return undefined;
  evidence.push({
    confidence: 1,
    field_path: 'participants.count',
    interpretation: 'Запрос сформулирован от первого лица единственного числа; default нужно показать в summary.',
    value_origin: 'POLICY_DEFAULT',
  });
  return { age_context: 'UNKNOWN' as const, count: 1, group_context: 'SOLO' as const };
}

function parseInterests(text: string, evidence: ParseEvidence) {
  if (/не\s+знаю|удиви(?:те)?\s+меня|что[- ]нибудь\s+интересн/iu.test(text)) {
    evidence.push({
      confidence: 1,
      field_path: 'interest_profile.variety',
      interpretation: 'Пользователь явно разрешил exploratory-подбор.',
      value_origin: 'EXPLICIT',
    });
    return interestProfile([], 'EXPLORATORY', text);
  }

  const tags: string[] = [];
  for (const rule of INTEREST_RULES) {
    const match = text.match(rule.pattern);
    if (!match || tags.includes(rule.tag)) continue;
    tags.push(rule.tag);
    evidence.push(matchEvidence('interest_profile.themes', match, text, rule.tag));
  }
  return tags.length > 0 ? interestProfile(tags, 'BALANCED', text) : undefined;
}

function interestProfile(tags: string[], variety: 'BALANCED' | 'EXPLORATORY', rawText: string) {
  return {
    taxonomy_version: 'interest-taxonomy.v0.1',
    themes: tags.map((tag) => ({ tag, weight: 1 })),
    styles: [],
    environment: 'UNSPECIFIED' as const,
    energy: 'UNSPECIFIED' as const,
    must_include: [],
    exclusions: [],
    variety,
    raw_text: rawText,
  };
}

function parseCompletion(text: string, evidence: ParseEvidence) {
  const returnMatch = text.match(/вернут(?:ься|ся)|обратно|успеть\s+домой/iu);
  if (returnMatch) {
    evidence.push(matchEvidence('completion.kind', returnMatch, text, 'RETURN_TO_ORIGIN'));
    return { kind: 'RETURN_TO_ORIGIN' as const };
  }
  evidence.push({
    confidence: 1,
    field_path: 'completion.kind',
    interpretation: 'Нет признаков обязательного возврата или фиксированной конечной точки; default показывается в summary.',
    value_origin: 'POLICY_DEFAULT',
  });
  return { kind: 'END_ANYWHERE' as const };
}

function matchEvidence(fieldPath: string, match: RegExpMatchArray, text: string, interpretation: string) {
  const start = match.index ?? text.indexOf(match[0]);
  return {
    confidence: 1,
    field_path: fieldPath,
    interpretation,
    span_end: start + match[0].length,
    span_start: start,
    value_origin: 'EXPLICIT' as const,
  };
}

function isMultiDay(text: string) {
  return /(?:два|три|четыре|пять|[2-9])\s+дн|несколько\s+дн|кажд(?:ый|ые)\s+день/iu.test(text);
}

function normalizeTime(hour: string | undefined, minute: string | undefined) {
  if (hour === undefined) return undefined;
  return `${hour.padStart(2, '0')}:${minute ?? '00'}`;
}

function addLocalDays(localDate: string, days: number) {
  const [year, month, day] = localDate.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isValidLocalDate(localDate: string) {
  const [year, month, day] = localDate.split('-').map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function localDateAtInstant(instant: Date, timeZone: string) {
  const parts = dateTimeParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localDateTimeToRfc3339(localDate: string, localTime: string, timeZone: string) {
  const [year, month, day] = localDate.split('-').map(Number);
  const [hour, minute] = localTime.split(':').map(Number);
  const localAsUtc = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  let instant = localAsUtc;

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = dateTimeParts(new Date(instant), timeZone);
    const representedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    instant = localAsUtc - (representedAsUtc - instant);
  }

  const finalParts = dateTimeParts(new Date(instant), timeZone);
  const representedAsUtc = Date.UTC(
    Number(finalParts.year),
    Number(finalParts.month) - 1,
    Number(finalParts.day),
    Number(finalParts.hour),
    Number(finalParts.minute),
    Number(finalParts.second),
  );
  const offsetMinutes = Math.round((representedAsUtc - instant) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:${String(absoluteOffset % 60).padStart(2, '0')}`;
  return `${localDate}T${localTime}:00${offset}`;
}

function dateTimeParts(instant: Date, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      month: '2-digit',
      second: '2-digit',
      timeZone,
      year: 'numeric',
    })
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return values as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
}
