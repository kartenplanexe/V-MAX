import type { InitialContext } from './intent-start.js';

/** Authored HTTP-boundary responses, NOT outputs from Alice. Exact replay only. */
export function intentFixture(count = 1) {
  const text = count === 3
    ? 'Завтра и ещё два дня с 16 до 19 хочу в музей, потом в кафе. Пешком. Общий бюджет на всю поездку 5000 рублей.'
    : 'Завтра с 16 до 19 хочу в музей, потом в кафе. Пешком.';
  const context: InitialContext = { now: '2026-09-24T09:30:00Z',
    locality: { id: 'mow', region_id: '32', name: 'Учебный город', timezone: 'Europe/Moscow' },
    catalog: { format: 'rows_defaults_v1', version: 'synthetic.v1', region_id: '32', complete: true, roots: [],
      rows: [['100', 'Музеи', []], ['200', 'Кафе', []]] } };
  const shared_updates: { op: string; field: string; value: unknown; evidence: string }[] = [
    { op: 'set', field: 'mobility', value: ['walking'], evidence: 'Пешком' },
  ];
  if (count === 3) shared_updates.push({ op: 'set', field: 'budget',
    value: { kind: 'limit', amount_rub: 5000, basis: 'whole_party', period: 'whole_trip' }, evidence: 'Общий бюджет на всю поездку 5000 рублей' });
  const response = { schema_version: 'intent-parser.v0.2', action: 'new_request',
    date_anchor: { value: { kind: 'relative', days: 1 }, evidence: 'Завтра' }, shared_updates,
    days: Array.from({ length: count }, (_, index) => ({ day_id: `new:${index + 1}`,
      date: { kind: 'anchor_offset', days: index }, date_evidence: null, scope_evidence: null,
      time_updates: [{ op: 'set', field: 'start', value: '16:00', evidence: 'с 16 до 19' }, { op: 'set', field: 'end', value: '19:00', evidence: 'с 16 до 19' }],
      activity_edits: ['музей', 'кафе'].map((label, i) => ({ op: 'add', activity_id: `new:${i + 1}`, label,
        selection: { category_policy: 'related_allowed', named_types: [label], evidence: label }, requirements: [], evidence: label })),
      category_matches: ['100', '200'].map((category, i) => ({ activity_id: `new:${i + 1}`, state: 'matched', include_any: [category], exclude: [], evidence: i === 0 ? 'музей' : 'кафе' })),
      order_changes: [{ op: 'add', before: 'new:1', after: 'new:2', evidence: 'музей, потом в кафе' }],
    })), unresolved: [] };
  return { text, context, response };
}
