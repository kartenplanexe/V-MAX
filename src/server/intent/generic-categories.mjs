import fs from 'node:fs';
import { semanticAnchors } from './semantic-coverage.mjs';
const policy = JSON.parse(fs.readFileSync(new URL('./semantic-policy.v1.json', import.meta.url), 'utf8'));
export const genericCategoryPolicyVersion = 'generic-activity-categories.v1';
const fold = value => value.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
const families = new Map(policy.families.filter(f => ['walk', 'food'].includes(f.id))
  .map(f => [f.id, new Set(f.rubrics.split('|').map(fold))]));
const natureRubrics = new Set('природные достопримечательности|заповедники|лесопарки|ботанические сады|ботанический сад|парки|парки культуры и отдыха|водопады|родники|скалы|пляжи'.split('|').map(fold));

/** Only broad action-only clauses; named types, constraints, negatives and
 * mixed evidence stay with the full-catalog mapper. Never creates an activity. */
export function resolveGenericCategories(proposal, catalog) {
  const result = structuredClone(proposal), pending = [];
  for (const day of result.days) for (const activity of day.activity_edits) {
    const nature = /(?<!\p{L})природ[а-яё]*(?!\p{L})/iu.test(`${activity.label} ${activity.evidence}`) &&
      activity.selection.category_policy === 'related_allowed' && !activity.selection.named_types.length &&
      !activity.requirements.length;
    if (nature) {
      const ids = catalog.rows.filter(row => (row[3]?.type ?? 'rubric') === 'rubric' && natureRubrics.has(fold(row[1]))).map(row => row[0]);
      if (ids.length) {
        const match = day.category_matches.find(match => match.activity_id === activity.activity_id);
        match.state = 'matched'; match.include_any = [...new Set(ids)]; match.exclude = [];
        continue;
      }
    }
    const anchors = semanticAnchors(activity.evidence);
    const family = anchors[0]?.family, names = families.get(family);
    const generic = activity.selection.category_policy === 'related_allowed' && !activity.selection.named_types.length &&
      !activity.requirements.length && anchors.length > 0 && names &&
      anchors.every(anchor => anchor.family === family && anchor.action && !anchor.negative);
    if (!generic) { pending.push({ day_id: day.day_id, activity_id: activity.activity_id }); continue; }
    const ids = catalog.rows.filter(row => (row[3]?.type ?? 'rubric') === 'rubric' && names.has(fold(row[1]))).map(row => row[0]);
    const match = day.category_matches.find(match => match.activity_id === activity.activity_id);
    match.state = ids.length ? 'matched' : 'no_match'; match.include_any = [...new Set(ids)]; match.exclude = [];
  }
  return { proposal: result, pending };
}
