import { describe, expect, it } from 'vitest';
import { parseInitialIntent } from './intent-start.js';
import { intentFixture } from './intent-start.fixture.js';

function sample(text: string, activities: { label: string; evidence: string; categories: string[] }[],
  order: [number, number][] = []) {
  const f = intentFixture();
  f.context.catalog.rows = [['168', 'Парки', []], ['200', 'Кафе', []], ['100', 'Музеи', []],
    ['300', 'Кинотеатры', []], ['400', 'Спортивные залы', []], ['999', 'Мастерские ремёсел', []],
    ['210', 'Кофейни', []], ['110', 'Художественные галереи', []]];
  f.response.date_anchor = null as unknown as typeof f.response.date_anchor;
  f.response.shared_updates = [];
  const day = f.response.days[0]!;
  day.time_updates = [];
  day.activity_edits = activities.map((a, i) => ({ op: 'add', activity_id: `new:${i + 1}`,
    label: a.label, evidence: a.evidence, selection: { category_policy: 'related_allowed', named_types: [], evidence: a.evidence }, requirements: [] }));
  day.category_matches = activities.map((a, i) => ({ activity_id: `new:${i + 1}`,
    state: 'matched', include_any: a.categories, exclude: [], evidence: a.evidence }));
  day.order_changes = order.map(([a, b]) => ({ op: 'add', before: `new:${a}`, after: `new:${b}`, evidence: text }));
  return { ...f, text };
}
const parse = (f: ReturnType<typeof sample>, provider: (request: Record<string, unknown>) => Promise<unknown> = async () => f.response) =>
  parseInitialIntent({ ...f.context, userText: f.text, inputId: 'semantic-regression' }, provider);

describe('bounded semantic coverage across text, activities and catalog', () => {
  it('does not mistake a transport verb for a food noun', async () => {
    await expect(parse(sample('Хочу погулять, еду туда на метро', [
      { label: 'Прогулка', evidence: 'погулять', categories: ['168'] },
    ]))).resolves.toMatchObject({ status: 'draft' });
  });

  it('does not treat a parking requirement as a park visit', async () => {
    await expect(parse(sample('Хочу в музей, нужна парковка рядом', [
      { label: 'Музей', evidence: 'музей', categories: ['100'] },
    ]))).resolves.toMatchObject({ status: 'draft' });
  });

  it('does not assert that a coffee shop cannot provide a requested meal', async () => {
    await expect(parse(sample('Хочу поесть в кофейне', [
      { label: 'Обед', evidence: 'поесть', categories: ['210'] },
    ]))).resolves.toMatchObject({ status: 'draft' });
  });

  it('requires separate activities for explicit sequential visits in one family', async () => {
    await expect(parse(sample('Хочу в музей, потом в галерею', [
      { label: 'Музей', evidence: 'музей', categories: ['100'] },
    ]))).rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
  });

  it.each([false, true])('checks same-family sequential order through distinct source units (reversed=%s)', async reversed => {
    const f = sample('Музей, затем галерея', [{ label: 'Музей', evidence: 'Музей', categories: ['100'] },
      { label: 'Галерея', evidence: 'галерея', categories: ['110'] }], reversed ? [[2, 1]] : [[1, 2]]);
    if (reversed) await expect(parse(f)).rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
    else await expect(parse(f)).resolves.toMatchObject({ status: 'draft' });
  });

  it('ends a noun exclusion when a separate positive action starts', async () => {
    await expect(parse(sample('Хочу погулять без музеев и поесть', [
      { label: 'Прогулка', evidence: 'погулять', categories: ['168'] },
      { label: 'Обед', evidence: 'поесть', categories: ['200'] },
    ]))).resolves.toMatchObject({ status: 'draft' });
  });

  it.each([
    ['хочу погулять, а потом поесть', 'Прогулка', 'погулять', ['168']],
    ['Посетить музей и поужинать', 'Музей', 'музей', ['100']],
    ['Кино, затем пройтись по набережной', 'Кино', 'Кино', ['300']],
    ['Потренироваться и перекусить', 'Тренировка', 'Потренироваться', ['400']],
  ])('does not silently lose a known independent activity: %s', async (text, label, evidence, categories) => {
    const f = sample(text as string, [{ label: label as string, evidence: evidence as string, categories: categories as string[] }]);
    let calls = 0;
    await expect(parse(f, async () => { calls++; return f.response; }))
      .rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
    expect(calls).toBe(2);
  });

  it.each([
    ['Хочу пообедать', 'Обед', 'пообедать', ['168']],
    ['Посмотреть кино', 'Кино', 'кино', ['100']],
    ['Хочу в музей', 'Музей', 'музей', ['200']],
  ])('rejects known incompatible rubric families: %s', async (text, label, evidence, categories) => {
    await expect(parse(sample(text as string, [{ label: label as string, evidence: evidence as string, categories: categories as string[] }])))
      .rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
  });

  it('does not accept one merged walk/meal activity even with both categories', async () => {
    await expect(parse(sample('Прогуляться и поесть', [{ label: 'Прогулка и обед', evidence: 'Прогуляться и поесть', categories: ['168', '200'] }])))
      .rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
  });

  it.each(['Не хочу есть, только погулять', 'Без кафе, хочу пройтись', 'Погулять, а есть не хочу'])
  ('does not turn negated food into an obligation: %s', async text => {
    const evidence = text.includes('пройтись') ? 'пройтись' : text.includes('Погулять') ? 'Погулять' : 'погулять';
    await expect(parse(sample(text, [{ label: 'Прогулка', evidence, categories: ['168'] }]))).resolves.toMatchObject({ status: 'draft' });
  });

  it('does not permit explicitly negated food as an activity', async () => {
    await expect(parse(sample('Не хочу есть, только погулять', [
      { label: 'Прогулка', evidence: 'погулять', categories: ['168'] },
      { label: 'Поесть', evidence: 'есть', categories: ['200'] },
    ]))).rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
  });

  it('keeps alternatives within a single activity', async () => {
    await expect(parse(sample('Музей или кино', [{ label: 'Музей или кино', evidence: 'Музей или кино', categories: ['100', '300'] }])))
      .resolves.toMatchObject({ status: 'draft' });
  });

  it('does not turn the location of a meal into an independent walk', async () => {
    await expect(parse(sample('Хочу поесть в парке', [{ label: 'Обед', evidence: 'поесть', categories: ['200'] }])))
      .resolves.toMatchObject({ status: 'draft' });
  });

  it.each([
    ['В кафе «Кино», потом пройтись', 'Кафе «Кино»', 'В кафе «Кино»'],
    ['В кафе Кино, потом пройтись', 'Кафе Кино', 'кафе Кино'],
  ])('does not reinterpret venue names as separate wishes: %s', async (text, label, evidence) => {
    await expect(parse(sample(text, [{ label, evidence, categories: ['200'] },
      { label: 'Прогулка', evidence: 'пройтись', categories: ['168'] }], [[1, 2]])))
      .resolves.toMatchObject({ status: 'draft' });
  });

  it.each(['Не хочу в музей, хочу поесть', 'Никаких музеев, только поесть'])
  ('does not require a negated destination: %s', async text => {
    await expect(parse(sample(text, [{ label: 'Обед', evidence: 'поесть', categories: ['200'] }])))
      .resolves.toMatchObject({ status: 'draft' });
  });

  it('does not make a style constraint negate independent wishes', async () => {
    await expect(parse(sample('Без спешки погулять и поесть', [{ label: 'Прогулка', evidence: 'погулять', categories: ['168'] },
      { label: 'Обед', evidence: 'поесть', categories: ['200'] }])))
      .resolves.toMatchObject({ status: 'draft' });
  });

  it('treats walking inside an indoor attraction as that visit', async () => {
    await expect(parse(sample('Погулять в музее', [{ label: 'Музей', evidence: 'Погулять в музее', categories: ['100'] }])))
      .resolves.toMatchObject({ status: 'draft' });
  });

  it('does not treat possession of time as a food wish', async () => {
    await expect(parse(sample('Есть два часа, хочу в музей', [{ label: 'Музей', evidence: 'музей', categories: ['100'] }])))
      .resolves.toMatchObject({ status: 'draft' });
  });

  it('requires an explicitly stated activity order', async () => {
    await expect(parse(sample('Музей, затем поесть', [{ label: 'Музей', evidence: 'Музей', categories: ['100'] },
      { label: 'Обед', evidence: 'поесть', categories: ['200'] }])))
      .rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
  });

  it('keeps a broad evidence quote from merging correctly separate labels', async () => {
    const text = 'Погулять, а потом поесть';
    const f = sample(text, [{ label: 'Прогулка', evidence: text, categories: ['168'] },
      { label: 'Обед', evidence: text, categories: ['200'] }], [[1, 2]]);
    const r = await parse(f);
    expect(r.status).toBe('draft');
    if (r.status === 'draft') expect(r.draft.days[0]!.order).toEqual([['day-1-activity-1', 'day-1-activity-2']]);
  });

  it('repairs once using the original request and preserves both activities and order', async () => {
    const text = 'Хочу пройтись, после этого перекусить';
    const bad = sample(text, [{ label: 'Прогулка', evidence: 'пройтись', categories: ['168'] }]);
    const good = sample(text, [{ label: 'Прогулка', evidence: 'пройтись', categories: ['168'] },
      { label: 'Перекус', evidence: 'перекусить', categories: ['200'] }], [[1, 2]]);
    const requests: Record<string, unknown>[] = [];
    const r = await parse(bad, async request => { requests.push(request); return requests.length === 1 ? bad.response : good.response; });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain(text);
    expect(JSON.stringify(requests[1])).toContain('SEMANTIC_ACTIVITY_MISSING');
    expect(r.status).toBe('draft');
    if (r.status === 'draft') expect(r.draft.days[0]!.activities).toHaveLength(2);
  });

  it('does not invent support for unfamiliar activities or reject their unknown taxonomy', async () => {
    await expect(parse(sample('Мастер-класс по керамике', [{ label: 'Мастер-класс', evidence: 'Мастер-класс', categories: ['999'] }])))
      .resolves.toMatchObject({ status: 'draft' });
  });

  it('preserves different scopes across independently dated days', async () => {
    const text = 'Сегодня музей, завтра поесть';
    const f = sample(text, [{ label: 'Музей', evidence: 'музей', categories: ['100'] }]);
    const second = sample(text, [{ label: 'Обед', evidence: 'поесть', categories: ['200'] }]).response.days[0]!;
    f.response.days[0]!.date = { kind: 'relative', days: 0 };
    f.response.days[0]!.date_evidence = 'Сегодня';
    second.day_id = 'new:2'; second.date = { kind: 'relative', days: 1 }; second.date_evidence = 'завтра';
    f.response.days.push(second);
    await expect(parse(f)).resolves.toMatchObject({ status: 'draft' });
  });

  it.each([false, true])('uses postfix dates without inverting the scope (swapped=%s)', async swapped => {
    const text = 'Музей сегодня, кафе завтра';
    const museum = { label: 'Музей', evidence: 'Музей', categories: ['100'] };
    const cafe = { label: 'Кафе', evidence: 'кафе', categories: ['200'] };
    const f = sample(text, [swapped ? cafe : museum]);
    const second = sample(text, [swapped ? museum : cafe]).response.days[0]!;
    f.response.days[0]!.date = { kind: 'relative', days: 0 }; f.response.days[0]!.date_evidence = 'сегодня';
    second.day_id = 'new:2'; second.date = { kind: 'relative', days: 1 }; second.date_evidence = 'завтра';
    f.response.days.push(second);
    if (swapped) await expect(parse(f)).rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
    else await expect(parse(f)).resolves.toMatchObject({ status: 'draft' });
  });

  it('does not accept activities moved to the wrong explicitly dated day', async () => {
    const text = 'Сегодня музей, завтра поесть';
    const f = sample(text, [{ label: 'Обед', evidence: 'поесть', categories: ['200'] }]);
    const second = sample(text, [{ label: 'Музей', evidence: 'музей', categories: ['100'] }]).response.days[0]!;
    f.response.days[0]!.date = { kind: 'relative', days: 0 }; f.response.days[0]!.date_evidence = 'Сегодня';
    second.day_id = 'new:2'; second.date = { kind: 'relative', days: 1 }; second.date_evidence = 'завтра';
    f.response.days.push(second);
    await expect(parse(f)).rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
  });

  it('checks repeated families on independently scoped days separately', async () => {
    const text = 'Сегодня музей, завтра музей';
    const f = sample(text, [{ label: 'Музей', evidence: 'музей', categories: ['100'] }]);
    const second = structuredClone(f.response.days[0]!);
    f.response.days[0]!.date = { kind: 'relative', days: 0 }; f.response.days[0]!.date_evidence = 'Сегодня';
    second.day_id = 'new:2'; second.date = { kind: 'relative', days: 1 }; second.date_evidence = 'завтра';
    second.activity_edits = []; second.category_matches = []; f.response.days.push(second);
    await expect(parse(f)).rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
  });

  it('keeps an explicit daily wish distinct from a single-day addition', async () => {
    const text = 'Каждый день поесть, сегодня музей, завтра кино';
    const f = sample(text, [{ label: 'Обед', evidence: 'поесть', categories: ['200'] },
      { label: 'Музей', evidence: 'музей', categories: ['100'] }]);
    const second = sample(text, [{ label: 'Обед', evidence: 'поесть', categories: ['200'] },
      { label: 'Кино', evidence: 'кино', categories: ['300'] }]).response.days[0]!;
    f.response.days[0]!.date = { kind: 'relative', days: 0 }; f.response.days[0]!.date_evidence = 'сегодня';
    second.day_id = 'new:2'; second.date = { kind: 'relative', days: 1 }; second.date_evidence = 'завтра';
    f.response.days.push(second);
    await expect(parse(f)).resolves.toMatchObject({ status: 'draft' });
  });

  it('does not lose a daily activity in an explicit every-day scope', async () => {
    const text = 'Два дня подряд каждый день музей и поесть';
    const f = sample(text, [{ label: 'Музей', evidence: 'музей', categories: ['100'] },
      { label: 'Обед', evidence: 'поесть', categories: ['200'] }]);
    const second = structuredClone(f.response.days[0]!); second.day_id = 'new:2'; second.date.days = 1;
    second.activity_edits.pop(); second.category_matches.pop(); f.response.days.push(second);
    await expect(parse(f)).rejects.toMatchObject({ code: 'INTENT_NEEDS_CLARIFICATION' });
  });
});
