// Check literal time coverage without changing the parsed window.
export const timeLiteralCoverageVersion = 'time-literal-coverage.v1';
const hour = '(?:[01]?\\d|2[0-3])';
const clock = `${hour}(?::[0-5]\\d)?`;
const unit = '(?:час(?:а|ов)?|ч)(?!\\p{L})';
const nonTimeUnit = /^\s*(?:руб|₽|доллар|евро|€|\$|тыс|млн|миллион|человек|люд|дет|реб[её]н|лет|год|день|дня|дней|сут|минут|километр|метр|км|кг|процент|%|январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)/iu;
const valueOf = token => token.includes(':') ? token.padStart(5, '0') : `${token.padStart(2, '0')}:00`;

function literals(text) {
  const found = new Map();
  // Skip ambiguous 1..12 clock values when a day part is present.
  const dayPart = /(?<!\p{L})(?:утр[ао]|утром|дня|дн[её]м|вечер[ао]м?|ноч[иь]|ночью)(?!\p{L})/iu.test(text);
  const add = (token, index) => {
    const hours = Number(token.split(':')[0]);
    if (dayPart && hours >= 1 && hours <= 12) return;
    found.set(index, { token, value: valueOf(token) });
  };
  for (const m of text.matchAll(/(?<![\p{L}\p{N}:])(?:[01]?\d|2[0-3]):[0-5]\d(?![\p{L}\p{N}:])/gu)) add(m[0], m.index);
  const range = new RegExp(`(?<![\\p{L}\\p{N}])с\\s+(${clock})(?:\\s*${unit})?\\s+(?:до|по)\\s+(${clock})(?![\\p{L}\\p{N}:]|[.,]\\d)`, 'giu');
  for (const m of text.matchAll(range)) {
    if (nonTimeUnit.test(text.slice(m.index + m[0].length))) continue;
    add(m[1], m.index + m[0].indexOf(m[1])); add(m[2], m.index + m[0].lastIndexOf(m[2]));
  }
  // A bare «1–2 часа» can be a duration, not clock bounds. Do not guess.
  const bound = new RegExp(`(?<!\\p{L})(?:после|раньше|позже)\\s+(${clock})(?![\\p{L}\\p{N}:]|[.,]\\d)|(?<!\\p{L})(?:с|до|в|к)\\s+(${clock})\\s*${unit}`, 'giu');
  for (const m of text.matchAll(bound)) {
    if (nonTimeUnit.test(text.slice(m.index + m[0].length))) continue;
    const token = m[1] ?? m[2]; add(token, m.index + m[0].indexOf(token));
  }
  return [...found.values()];
}

export function inspectTimeLiteralCoverage(proposal, text) {
  const result = { version: timeLiteralCoverageVersion, errors: [], mentions: 0, missing: 0 };
  if (proposal?.action !== 'new_request') return result;
  const mentions = literals(text), updates = proposal.days.flatMap(day => day.time_updates)
    .filter(update => update.op === 'set' && ['start', 'end'].includes(update.field));
  result.mentions = mentions.length;
  for (const mention of mentions) {
    const literal = new RegExp(`(?<![\\p{L}\\p{N}:])${mention.token}(?![\\p{L}\\p{N}:])`, 'u');
    if (!updates.some(update => update.value === mention.value && literal.test(update.evidence))) result.missing++;
  }
  if (result.missing) result.errors.push('TIME_LITERAL_MISSING');
  return result;
}
