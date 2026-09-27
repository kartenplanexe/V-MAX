import { ManualOptions, type ManualChoices } from '../shared/manual-planning.js';
import type { ActivityChoice } from '../shared/activity-choice.js';
import { PlaceActivitySchema } from '../shared/planning-form.js';
import type { PlanningContext } from './planning-sessions.js';
import { classifyActivityIntent } from './activity-intent.js';

export function choicesFromCatalog(context: PlanningContext, localityName: string) {
  const categories = context.catalog.leaf_ids.flatMap(id => {
    const name = context.catalog.category_names?.[id], duration = context.visit_policy.by_category[id];
    return name && Number.isSafeInteger(duration) && duration! > 0
      ? [{ id, name, estimated_visit_minutes: duration! }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return ManualOptions.parse({ catalog_version: context.catalog.version, locality_name: localityName,
    categories, modes: context.modes, walking_available: context.visit_policy.walkable_category_ids?.some(id => categories.some(c => c.id === id)) ?? false });
}

export function catalogActivity(choice: ActivityChoice, id: string, context: PlanningContext, options: ManualChoices,
  reject: (code: string) => never) {
  const categories = new Map(options.categories.map(category => [category.id, category]));
  let ids: string[], named: string[], label: string;
  if (choice.kind === 'walk') {
    if (!options.walking_available) reject('MANUAL_WALK_UNAVAILABLE');
    ids = context.visit_policy.walkable_category_ids!.filter(id => categories.has(id));
    label = 'Прогулка по городу'; named = [];
  } else {
    if (choice.category_ids.some(id => !categories.has(id))) reject('MANUAL_CATEGORY_UNAVAILABLE');
    ids = choice.category_ids; named = ids.map(id => categories.get(id)!.name); label = named.join(' / ').slice(0, 500);
  }
  return PlaceActivitySchema.parse({ id, label, intent_kind: choice.kind === 'walk' ? 'route_walk' : classifyActivityIntent({ label, namedTypes: named }),
    selection: { category_policy: choice.kind === 'walk' ? 'related_allowed' : 'named_types_only', named_types: named }, requirements: [],
    categories: { state: 'matched', include_any: ids, exclude: [], region_id: context.catalog.region_id, catalog_version: options.catalog_version } });
}
