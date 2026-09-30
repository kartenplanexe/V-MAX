export function relativeDateDays(evidence: string | null | undefined): number | null {
  if (!evidence) return null;
  const values = [...evidence.matchAll(/(?<!\p{L})(послезавтра|после\s+завтра|завтра|сегодня|через\s+(\d+)\s+д(?:ень|ня|ней))(?!\p{L})/giu)];
  if (values.length !== 1 || /(?<!\p{L})не\s/iu.test(evidence)) return null;
  const match = values[0]!;
  return match[2] ? Number(match[2]) : /после/iu.test(match[1]!) ? 2 : /завтра/iu.test(match[1]!) ? 1 : 0;
}
export function dateAfter(now: string, timezone: string, offset: number) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const part = (key: string) => Number(parts.find(value => value.type === key)!.value);
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day') + offset)).toISOString().slice(0, 10);
}
export function overlapsBusyTime(text: string, window: { start: string; end: string }) {
  const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const busy = /(?<!\p{L})(?:работаю|работа|занят[аы]?|уч[её]ба|учусь|встреча|совещание)(?!\p{L})[^.!?;\n]*?с\s*(\d{1,2})(?::(\d{2}))?\s*(?:до|[-–—])\s*(\d{1,2})(?::(\d{2}))?/giu;
  return [...text.matchAll(busy)].some(match => {
    const start = Number(match[1]) * 60 + Number(match[2] ?? 0), end = Number(match[3]) * 60 + Number(match[4] ?? 0);
    return start < end && end <= 1440 && Math.max(start, minute(window.start)) < Math.min(end, minute(window.end));
  });
}
