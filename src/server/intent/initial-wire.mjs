// Add mechanical IDs to the provider response before v0.2 validation.
import fs from 'node:fs';
import AjvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import { schema as dailySchema } from './daily-contract.mjs';
const Ajv = AjvModule.default ?? AjvModule;
const addFormats = formatsModule.default ?? formatsModule;
const ref = name => ({ $ref: `#/$defs/${name}` });
const array = items => ({ type: 'array', items });
const object = properties => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });

function pruneDefinitions(schema) {
  const needed = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/$defs/')) {
      const key = value.$ref.slice(8);
      if (!needed.has(key)) { needed.add(key); visit(schema.$defs[key]); }
    }
    for (const [key, child] of Object.entries(value)) if (key !== '$defs') visit(child);
  };
  visit(schema);
  schema.$defs = Object.fromEntries([...needed].map(key => [key, schema.$defs[key]]));
}
function wireCompatible(value) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) {
    delete value.uniqueItems;
    if (value.oneOf) { value.anyOf = value.oneOf; delete value.oneOf; }
  }
  Object.values(value).forEach(wireCompatible);
}

export function initialWireAdapter(request) {
  if (request.response_format?.json_schema?.name === 'initial_categories_bridge_v1') return categoryWireAdapter(request);
  if (request.response_format?.json_schema?.name !== 'leisure_intent_parser_v02') return null;
  const message = request.messages?.find(message => message.role === 'user');
  if (typeof message?.content !== 'string') return null;
  const input = JSON.parse(message.content);
  if (input.mode !== 'parse' || input.draft !== null) return null;
  const defs = structuredClone(dailySchema.$defs);
  defs.sharedChange.oneOf = defs.sharedChange.oneOf.filter(branch => branch.properties.op.const !== 'clear');
  const mobilityChange = defs.sharedChange.oneOf.find(branch => branch.properties.field.const === 'mobility');
  mobilityChange.properties.value.description = 'Способ из user_text. Для одного «поехать/съездить» верни оба варианта ["public_transport","driving"]; для «на машине» — ["driving"]. Не пропускай явно названный транспорт.';
  const timeField = (value, description) => ({ description, anyOf: [{ type: 'null' }, object({ value, evidence: ref('quote') })] });
  defs.initialTime = object({
    start: timeField(ref('clock'), 'Начало доступного времени. null только если начало не задано.'),
    end: timeField(ref('clock'), 'Конец доступного времени. При диапазоне сохраняй оба конца, даже если окно короткое.'),
    period: timeField({ enum: ['morning', 'day', 'evening', 'night'] }, 'Явное время суток, иначе null.'),
    duration_minutes: timeField({ type: 'integer', minimum: 1 }, 'Явная длительность в минутах, иначе null. Не вычисляй её из start/end.'),
  });
  defs.dayDate.oneOf = defs.dayDate.oneOf.filter(branch => branch.type !== 'null');
  defs.initialActivity = object({ label: ref('text'), evidence: ref('quote'), selection: ref('selection'),
    requirements: array(ref('requirement')) });
  defs.initialOrder = object({ before: { type: 'integer', minimum: 1 }, after: { type: 'integer', minimum: 1 }, evidence: ref('quote') });
  defs.initialDay = object({ date: ref('dayDate'), date_evidence: { type: ['string', 'null'], minLength: 1 },
    time: ref('initialTime'), activities: array(ref('initialActivity')), order: array(ref('initialOrder')) });
  defs.initialUnresolved = object({ field: dailySchema.$defs.unresolved.properties.field,
    day_indices: { ...array({ type: 'integer', minimum: 1 }), uniqueItems: true },
    text: { ...ref('quote'), description: 'Дословный непрерывный фрагмент user_text, вызвавший неопределённость. Не вопрос, не нормализованное название и не пересказ.' }, reason: dailySchema.$defs.unresolved.properties.reason });
  const schema = { $schema: dailySchema.$schema, ...object({
    schema_version: { const: 'initial-intent.v1' }, action: { enum: ['new_request', 'off_topic', 'unclear'] },
    date_anchor: dailySchema.properties.date_anchor, shared_updates: array(ref('sharedChange')),
    days: array(ref('initialDay')), unresolved: array(ref('initialUnresolved')),
  }), $defs: defs };
  schema.properties.shared_updates.description = 'Обязательные явно сообщённые общие условия. При «поехать» или названном способе добавь mobility с дословной evidence; не оставляй массив пустым.';
  pruneDefinitions(schema);
  const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv);
  const validate = ajv.compile(schema);
  const wireSchema = structuredClone(schema); wireCompatible(wireSchema);
  const repairErrors = Array.isArray(request.initial_repair_errors)
    ? request.initial_repair_errors.filter(code => typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)) : [];
  const system = fs.readFileSync(new URL('./initial-intent-system-v1.md', import.meta.url), 'utf8') +
    (repairErrors.includes('UNSUPPORTED_EVIDENCE') ? '\nUNSUPPORTED_EVIDENCE: все evidence, date_evidence, scope_evidence и unresolved.text должны быть дословными непрерывными фрагментами user_text. Не меняй окончания, не подставляй нормализованное название из locality_context и не пиши вопрос вместо цитаты. Проверь особенно unresolved.text. Если неопределённость реальна, сохрани её с точной цитатой, а не удаляй.' : '') +
    (repairErrors.length ? `\nПредыдущее предложение отклонено проверкой: ${repairErrors.join(', ')}. ` +
      'Заново проверь исходный текст, область каждого дня, буквальные цитаты и индексы порядка. before — занятие раньше, after — занятие позже. ' +
      'TIME_LITERAL_MISSING означает пропущенное цифровое время: проверь оба конца time.start/time.end; чужое или неоднозначное время сохрани в unresolved, не превращай занятость в свободное окно. Верни полный исправленный JSON.' : '');
  const invalid = () => ({ action: 'new_request' }); // Existing SCHEMA guard + bounded repair.
  const id = index => `new:${index}`;
  return {
    messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({
      now: input.now, locality_context: input.locality_context, user_text: input.user_text,
    }) }],
    response_format: { type: 'json_schema', json_schema: { name: 'initial_intent_v1', schema: wireSchema } },
    decode(raw) {
      if (!validate(raw)) return invalid();
      if (raw.days.some(day => day.order.some(edge => edge.before > day.activities.length || edge.after > day.activities.length)) ||
        raw.unresolved.some(issue => issue.day_indices.some(index => index > raw.days.length))) return invalid();
      const proposal = { schema_version: 'intent-parser.v0.2', action: raw.action,
        date_anchor: raw.date_anchor, shared_updates: raw.shared_updates,
        days: raw.days.map((day, dayIndex) => ({ day_id: id(dayIndex + 1), date: day.date,
          date_evidence: day.date_evidence, scope_evidence: null,
          time_updates: Object.entries(day.time).filter(([, value]) => value !== null)
            .map(([field, value]) => ({ op: 'set', field, value: value.value, evidence: value.evidence })),
          activity_edits: day.activities.map((activity, index) => ({ op: 'add', activity_id: id(index + 1),
            label: activity.label, evidence: activity.evidence, selection: activity.selection, requirements: activity.requirements })),
          category_matches: day.activities.map((activity, index) => ({ activity_id: id(index + 1), state: 'no_match',
            include_any: [], exclude: [], evidence: activity.evidence })),
          order_changes: day.order.map(edge => ({ op: 'add', before: id(edge.before), after: id(edge.after), evidence: edge.evidence })),
        })), unresolved: raw.unresolved.map(issue => ({ field: issue.field, day_ids: issue.day_indices.map(id), text: issue.text, reason: issue.reason })),
      };
      return raw.action === 'new_request' ? { kind: 'initial_extraction_v1', proposal } : proposal;
    },
  };
}

export function buildInitialCategoryRequest(input, proposal, pending) {
  return { response_format: { type: 'json_schema', json_schema: { name: 'initial_categories_bridge_v1' } },
    messages: [{ role: 'user', content: JSON.stringify({ input, proposal, pending }) }] };
}

function categoryWireAdapter(request) {
  const { input, proposal, pending } = JSON.parse(request.messages[0].content);
  const needsMapping = (day, activity) => !pending || pending.some(item => item.day_id === day.day_id && item.activity_id === activity.activity_id);
  const byName = new Map();
  for (const row of input.catalog.rows) {
    if ((row[3]?.type ?? 'rubric') !== 'rubric') continue;
    const ids = byName.get(row[1]) ?? []; if (!ids.includes(row[0])) ids.push(row[0]); byName.set(row[1], ids);
  }
  if (!byName.size) throw new Error('INITIAL_WIRE_CATALOG_EMPTY');
  const groups = {}, signatureKeys = new Map();
  const groupFor = activity => {
    const value = { label: activity.label, evidence: activity.evidence, selection: activity.selection, requirements: activity.requirements };
    const signature = JSON.stringify(value);
    if (!signatureKeys.has(signature)) {
      const key = `group_${signatureKeys.size + 1}`; signatureKeys.set(signature, key); groups[key] = value;
    }
    return signatureKeys.get(signature);
  };
  for (const day of proposal.days) for (const activity of day.activity_edits) if (needsMapping(day, activity)) groupFor(activity);
  const schema = { $schema: dailySchema.$schema, ...object({ schema_version: { const: 'initial-categories.v1' },
    matches: object(Object.fromEntries(Object.keys(groups).map(key => [key, ref('match')]))),
  }), $defs: {
    catalogName: { type: 'string', enum: [...byName.keys()] },
    match: object({ state: { enum: ['matched', 'no_match'] }, include_any: { ...array(ref('catalogName')), uniqueItems: true },
      exclude: { ...array(ref('catalogName')), uniqueItems: true } }),
  } };
  const ajv = new Ajv({ strict: true, allErrors: true }), validate = ajv.compile(schema);
  const wireSchema = structuredClone(schema); wireCompatible(wireSchema);
  return {
    messages: [{ role: 'system', content: fs.readFileSync(new URL('./initial-category-system-v1.md', import.meta.url), 'utf8') },
      { role: 'user', content: JSON.stringify({ catalog: input.catalog, user_text: input.user_text, activities: groups }) }],
    response_format: { type: 'json_schema', json_schema: { name: 'initial_categories_v1', schema: wireSchema } },
    decode(raw) {
      if (!validate(raw)) return { action: 'new_request' };
      const result = structuredClone(proposal);
      const idsFor = names => [...new Set(names.flatMap(name => byName.get(name)))];
      for (const day of result.days) day.category_matches = day.activity_edits.map(activity => {
        if (!needsMapping(day, activity)) return day.category_matches.find(match => match.activity_id === activity.activity_id);
        const match = raw.matches[groupFor(activity)];
        return { activity_id: activity.activity_id, state: match.state, include_any: idsFor(match.include_any),
          exclude: idsFor(match.exclude), evidence: activity.evidence };
      });
      return result;
    },
  };
}
