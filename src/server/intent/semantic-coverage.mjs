import fs from 'node:fs';
const policy = JSON.parse(fs.readFileSync(new URL('./semantic-policy.v1.json', import.meta.url), 'utf8'));
export const semanticPolicyVersion = policy.version;
const fold = value => value.trim().toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
const families = policy.families.map(family => ({ ...family,
  pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${family.anchors})(?![\\p{L}\\p{N}])`, 'giu'),
  action: new RegExp(`^(?:${family.action_anchors ?? '(?!)'})$`, 'iu'),
  rubrics: new Set(family.rubrics.split('|').map(fold)),
}));
const otherRubrics = new Set(policy.known_nonmatching_rubrics.map(fold));
const boundary = /[.!?;,\n]|(?<!\p{L})(?:но|а|затем|потом|после этого)(?!\p{L})/giu;
const connector = /[,;.!?\n]|(?<!\p{L})(?:и|или|либо|потом|затем|после)(?!\p{L})/iu;
const alternative = /(?<!\p{L})(?:или|либо)(?!\p{L})/iu;
const sequence = /(?<!\p{L})(?:потом|затем|после этого|после чего)(?!\p{L})/iu;
const everyDay = /(?<!\p{L})(?:каждый день|ежедневно|во все дни)(?!\p{L})/iu;
const venueNoun = /^(?:кафе|рестора[а-яё]*|музе[а-яё]*|кинотеатр[а-яё]*|парк[а-яё]*)$/iu;

function clause(text, start, end) {
  const boundaries = [...text.matchAll(boundary)];
  const before = boundaries.filter(match => match.index + match[0].length <= start).at(-1);
  const after = boundaries.find(match => match.index >= end);
  return { prefix: text.slice(before ? before.index + before[0].length : 0, start),
    suffix: text.slice(end, after?.index ?? text.length) };
}

export function semanticAnchors(text, { source = true } = {}) {
  const anchors = families.flatMap(family => [...text.matchAll(family.pattern)].map(match => ({
    family: family.id, start: match.index, end: match.index + match[0].length, word: match[0],
    action: family.action.test(match[0]), negative: false, negativeScope: null,
  }))).sort((a, b) => a.start - b.start);

  const namedSpans = [...text.matchAll(/[«"]([^»"]+)[»"]/gu)].filter(match =>
    /(?:кафе|рестора[а-яё]*|музе[а-яё]*|кинотеатр[а-яё]*|парк[а-яё]*)\s*$/iu.test(text.slice(0, match.index)));
  return anchors.filter(anchor => {
    if (namedSpans.some(match => anchor.start > match.index && anchor.end < match.index + match[0].length)) return false;
    const prior = anchors.filter(other => other.end <= anchor.start && other.family !== anchor.family).at(-1);
    if (prior && venueNoun.test(prior.word) && /^[\s«"]*$/u.test(text.slice(prior.end, anchor.start)) &&
      /^[А-ЯЁ]/u.test(anchor.word)) return false;
    if (!source) return true;
    const { prefix, suffix } = clause(text, anchor.start, anchor.end);

    if (fold(anchor.word) === 'еду' && !/(?:хочу|хотим|хочется|ищу|ищем|найти|заказать|люблю)\s*$/iu.test(prefix)) return false;

    if (fold(anchor.word) === 'есть' && !/(?:хочу|хотим|хочется|буду|будем|нужно|надо)\s*$/iu.test(prefix) &&
      !/^\s*(?:не\s+)?(?:хочу|хотим|буду|будем)/iu.test(suffix)) return false;

    if (/(?:старт|финиш|начало|начать|начнем|начнём|закончить|от|до|возле|около|рядом\s+с)\s+(?:у\s+)?$/iu.test(prefix)) return false;
    if (prior && !connector.test(text.slice(prior.end, anchor.start)) &&
      /^\s+(?:в|на|у|возле|около)\s*$/iu.test(text.slice(prior.end, anchor.start)) &&
      prior.family !== 'walk') return false;

    const next = anchors.find(other => other.start >= anchor.end && other.family !== anchor.family);
    if (anchor.family === 'walk' && next && ['culture', 'cinema', 'food', 'sport'].includes(next.family) &&
      /^\s+(?:в|по)\s*$/iu.test(text.slice(anchor.end, next.start))) return false;
    const preceding = anchors.filter(other => other.end <= anchor.start).at(-1);
    const negativeList = preceding?.negative && /^\s+(?:и|или|ни)\s*$/iu.test(text.slice(preceding.end, anchor.start)) &&
      !(preceding.negativeScope === 'noun_exclusion' && anchor.action);
    const nounExclusion = /(?<!\p{L})(?:без|никаких|никакого|никакой)\s*$/iu.test(prefix);
    const actionNegation = /(?<!\p{L})не\s+(?!(?:только|против)(?!\p{L}))(?:хочу\s+|хотим\s+|буду\s+|будем\s+|надо\s+|нужно\s+|хочется\s+)?(?:идти\s+|ходить\s+|посещать\s+|заходить\s+)?(?:в\s+|на\s+|ни\s+)?$/iu.test(prefix) ||
      /^\s+не\s+(?:хочу|хотим|буду|будем|нужно|надо|хочется)(?!\p{L})/iu.test(suffix);
    anchor.negative = Boolean(negativeList || nounExclusion || actionNegation);
    anchor.negativeScope = nounExclusion ? 'noun_exclusion' : actionNegation ? 'action_negation' : negativeList ? preceding.negativeScope : null;
    return true;
  });
}

function groups(anchors, text) {
  const result = [];
  for (const anchor of anchors.filter(value => !value.negative)) {
    const previous = result.at(-1);
    const between = previous ? text.slice(previous.end, anchor.start) : '';
    const sameMention = previous?.families.has(anchor.family) && !sequence.test(between) &&
      !/(?<!\p{L})(?:и|затем|далее)(?!\p{L})/iu.test(between) &&
      !/(?<!\p{L})(?:сегодня|завтра|послезавтра|день|дня)(?!\p{L})/iu.test(between);
    if (previous && (sameMention || alternative.test(between))) {
      previous.families.add(anchor.family); previous.end = anchor.end; previous.anchors.push(anchor);
    } else result.push({ families: new Set([anchor.family]), start: anchor.start, end: anchor.end, anchors: [anchor] });
  }
  return result;
}
function labelFamilies(activity) {

  let found = semanticAnchors(activity.label ?? '', { source: false });
  if (!found.length) found = semanticAnchors((activity.selection?.named_types ?? []).join(' '), { source: false });
  if (!found.length) {
    const quote = semanticAnchors(activity.evidence ?? '');
    if (new Set(quote.filter(a => !a.negative).map(a => a.family)).size === 1) found = quote.filter(a => !a.negative);
  }
  return new Set(found.map(anchor => anchor.family));
}
function hasPath(day, from, to) {
  const edges = day.order_changes.filter(edge => edge.op === 'add');
  const queue = [from], seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...edges.filter(edge => edge.before === current).map(edge => edge.after));
  }
  return false;
}

function matchesUnit(entry, unit, text) {
  if (![...unit.families].some(family => entry.families.has(family))) return false;

  const quotes = [entry.activity.evidence, entry.activity.selection?.evidence].filter(Boolean);
  const spans = [];
  for (const quote of quotes) {
    let at = text.indexOf(quote);
    while (at >= 0) { spans.push({ start: at, end: at + quote.length }); at = text.indexOf(quote, at + 1); }
  }
  return !spans.length || unit.anchors.some(anchor => entry.families.has(anchor.family) &&
    spans.some(span => span.start <= anchor.start && span.end >= anchor.end));
}

function assignUnits(units, entries, text) {
  const assigned = new Map(), owner = new Map();
  const candidates = units.map(unit => entries.filter(entry => matchesUnit(entry, unit, text)));
  function visit(index, seen) {
    for (const entry of candidates[index]) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      const old = owner.get(entry);
      if (old === undefined || visit(old, seen)) { owner.set(entry, index); assigned.set(index, entry); return true; }
    }
    return false;
  }
  for (let index = 0; index < units.length; index++) visit(index, new Set());
  return assigned;
}

export function inspectSemanticCoverage(proposal, input) {
  const result = { policy_version: policy.version, issues: [], unknown_category_count: 0,
    scope: 'unverified', semantic_guarantee: false };
  if (proposal?.action !== 'new_request' || !Array.isArray(proposal.days) || typeof input?.user_text !== 'string') return result;
  const text = input.user_text, anchors = semanticAnchors(text), units = groups(anchors, text);
  const positive = new Set(anchors.filter(a => !a.negative).map(a => a.family));
  const negative = new Set(anchors.filter(a => a.negative && !positive.has(a.family)).map(a => a.family));
  const rows = new Map((input.catalog?.rows ?? []).map(row => [row[0], row]));
  const add = (code, family, day_id = null) => {
    if (!result.issues.some(issue => issue.code === code && issue.family === family && issue.day_id === day_id))
      result.issues.push({ code, family, day_id });
  };
  const entries = proposal.days.flatMap(day => day.activity_edits.filter(a => a.op !== 'remove')
    .map(activity => ({ activity, day, families: labelFamilies(activity) })));
  for (const entry of entries) {
    const { activity, day, families: actual } = entry;
    for (const family of actual) if (negative.has(family)) add('SEMANTIC_ACTIVITY_NEGATED', family, day.day_id);
    const evidenceAt = text.indexOf(activity.evidence ?? '');
    if (activity.evidence && evidenceAt >= 0 && text.indexOf(activity.evidence, evidenceAt + 1) < 0) {
      const cited = anchors.filter(anchor => anchor.start >= evidenceAt && anchor.end <= evidenceAt + activity.evidence.length);
      for (const family of actual) if (cited.some(anchor => anchor.family === family && anchor.negative) &&
        !cited.some(anchor => anchor.family === family && !anchor.negative)) add('SEMANTIC_ACTIVITY_NEGATED', family, day.day_id);
    }
    if (actual.size > 1 && !units.some(unit => [...actual].every(family => unit.families.has(family))))
      add('SEMANTIC_ACTIVITY_MERGED', [...actual].sort().join('+'), day.day_id);
    const match = day.category_matches.find(c => c.activity_id === activity.activity_id);
    if (match?.state !== 'matched' || !actual.size) continue;
    for (const id of match.include_any) {
      const row = rows.get(id);
      const name = fold(row?.[1] ?? '');
      const categoryFamilies = families.filter(family => family.rubrics.has(name)).map(family => family.id);
      if (!categoryFamilies.length && !otherRubrics.has(name)) { result.unknown_category_count++; continue; }
      if (!categoryFamilies.some(family => actual.has(family)))
        add('SEMANTIC_CATEGORY_MISMATCH', [...actual].sort().join('+'), day.day_id);
    }
  }

  const markers = proposal.days.flatMap(day => {
    const quote = day.date_evidence;
    if (!quote || quote.length > 40 || semanticAnchors(quote).length) return [];
    const start = text.indexOf(quote);
    if (start < 0 || text.indexOf(quote, start + 1) >= 0 || proposal.days.filter(other => other.date_evidence === quote).length !== 1) return [];
    return [{ start, day }];
  });
  const sharedMarkers = [...text.matchAll(new RegExp(everyDay.source, 'giu'))].map(match => ({ start: match.index, day: null }));
  const scopeMarkers = [...markers, ...sharedMarkers].sort((a, b) => a.start - b.start);
  const scopeBoundaries = [...text.matchAll(/[;.!?,\n]/gu)].map(match => match.index);
  const scoped = units.map(unit => {
    const low = (scopeBoundaries.filter(at => at < unit.start).at(-1) ?? -1) + 1;
    const high = scopeBoundaries.find(at => at >= unit.end) ?? text.length;
    const local = scopeMarkers.filter(value => value.start >= low && value.start < high);

    const marker = local.length === 1 ? local[0] : local.length ? null
      : scopeMarkers.filter(value => value.start < low).at(-1);
    const days = proposal.days.length === 1 ? proposal.days : marker ? marker.day ? [marker.day] : proposal.days : [null];
    return { unit, days };
  });
  result.scope = proposal.days.length === 1 ? 'single_day' : markers.length ? 'anchored_days' : sharedMarkers.length ? 'every_day' : 'request_only';
  const scopes = [...new Set(scoped.flatMap(value => value.days))];
  const assignments = new Map();
  for (const day of scopes) {
    const dayUnits = scoped.filter(value => value.days.includes(day)).map(value => value.unit);
    const candidates = day ? entries.filter(entry => entry.day === day) : entries;
    const matches = assignUnits(dayUnits, candidates, text);
    assignments.set(day, new Map(dayUnits.map((unit, index) => [unit, matches.get(index)])));
    dayUnits.forEach((unit, index) => {
      if (!matches.has(index)) add('SEMANTIC_ACTIVITY_MISSING', [...unit.families].sort().join('|'), day?.day_id ?? null);
    });
  }
  for (const day of proposal.days) {

    for (let index = 1; index < scoped.length; index++) {
      if (!scoped[index - 1].days.includes(day) || !scoped[index].days.includes(day)) continue;
      const before = scoped[index - 1].unit, after = scoped[index].unit;
      if (!sequence.test(text.slice(before.end, after.start)) || before.families.size !== 1 || after.families.size !== 1) continue;
      const left = assignments.get(day)?.get(before), right = assignments.get(day)?.get(after);
      if (left && right && left !== right && !hasPath(day, left.activity.activity_id, right.activity.activity_id))
        add('SEMANTIC_ORDER_MISSING', `${[...before.families][0]}>${[...after.families][0]}`, day.day_id);
    }
  }
  return result;
}
