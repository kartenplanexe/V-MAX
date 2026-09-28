import { expect, it } from 'vitest';
import { intentFixture } from './intent-start.fixture.js';
import { resolveGenericCategories } from './intent/generic-categories.mjs';

function food() {
  const f = intentFixture();
  const a = f.response.days[0]!.activity_edits[0]!;
  a.label = 'еда'; a.evidence = 'поесть'; a.selection = { category_policy: 'related_allowed', named_types: [], evidence: 'поесть' };
  return f;
}
it.each(['named', 'strict', 'requirement', 'negative', 'mixed', 'quoted'])('leaves %s evidence to the full mapper without changing conditions', variant => {
  const f = food(), a = f.response.days[0]!.activity_edits[0]!;
  if (variant === 'named') a.selection.named_types = ['кафе'];
  if (variant === 'strict') a.selection.category_policy = 'named_types_only';
  if (variant === 'requirement') a.requirements = [{ text: 'без кафе', strength: 'required', evidence: 'без кафе' }] as never[];
  if (variant === 'negative') a.evidence = 'не хочу поесть';
  if (variant === 'mixed') a.evidence = 'погулять и поесть';
  if (variant === 'quoted') a.evidence = 'кафе «Поесть»';
  const before = structuredClone(f.response);
  const result = resolveGenericCategories(f.response, f.context.catalog);
  expect(result.pending).toContainEqual({ day_id: 'new:1', activity_id: 'new:1' });
  expect(result.proposal).toEqual(before);
  expect(f.response).toEqual(before);
});
it('retains an unmatched broad request and never substitutes an unrelated available category', () => {
  const f = food(); f.context.catalog.rows = [['800', 'Сельхозкорма', []]];
  const result = resolveGenericCategories(f.response, f.context.catalog);
  expect(result.proposal.days[0]!.activity_edits[0]).toEqual(f.response.days[0]!.activity_edits[0]);
  expect(result.proposal.days[0]!.category_matches[0]).toMatchObject({ state: 'no_match', include_any: [], exclude: [] });
  expect(result.pending).not.toContainEqual({ day_id: 'new:1', activity_id: 'new:1' });
});
