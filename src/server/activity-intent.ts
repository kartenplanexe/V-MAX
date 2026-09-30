// Classify an activity after validating its evidence against the user text.
export const ACTIVITY_INTENT_POLICY = 'activity-intent.v1';
export type ActivityIntentKind = 'route_walk' | 'area_walk' | 'place_visit';

type ActivityEvidence = { label: string; evidence?: string; namedTypes?: readonly string[] };
const walking = /прогул|погуля|гуля|пройтись|поброд|пеш(?:ая|ий|ую|его)\s+(?:экскурси|маршрут)|пешком\s+погуля/iu;
const outdoor = /парк|сквер|сад|набережн|улиц|площад|достопримеч|бульвар|город|центр|квартал|ландшафт/iu;
const singleArea = /(?:^|[^\p{L}])(?:в|по)\s+(?:одном\s+)?(?:парк(?:е|у)?|сквер(?:е|у)?|сад(?:у|е)|ботаническом\s+саду)(?=$|[^\p{L}])/iu;
const nonWalkDestination = /кафе|кофейн|рестора|столов|паб|бар|музей|театр|кино|магазин|торгов|выставк|концерт/iu;

export function hasWalkingRequest(text: string): boolean { return walking.test(text); }

export function classifyActivityIntent(activity: ActivityEvidence): ActivityIntentKind {
  const label = activity.label.trim();
  const evidence = activity.evidence?.trim() ?? '';
  const named = (activity.namedTypes ?? []).join(' ');
  const walkInLabel = walking.test(label);
  // A quote containing several activities must not turn a cafe or museum into a walk.
  const walkInQuote = walking.test(evidence) && outdoor.test(`${label} ${named}`) && !nonWalkDestination.test(label);
  if (!walkInLabel && !walkInQuote) return 'place_visit';
  return singleArea.test(`${label} ${evidence}`) ? 'area_walk' : 'route_walk';
}
