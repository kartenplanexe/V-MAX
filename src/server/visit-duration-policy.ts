/** Product defaults agreed with the owner; never provider session durations. */
export const VISIT_DURATION_POLICY = 'visit-duration-estimates.v7';
export const WALK_STOP_MINUTES = 5;
const food = new Set(['кафе', 'кофейни', 'рестораны', 'столовые', 'быстрое питание',
  'пиццерии', 'бистро', 'кафе-кондитерские', 'рестораны быстрого питания', 'суши-бары']);
const performances = new Set(['театры', 'кинотеатры', 'кинозалы', 'автокинотеатры',
  'опера', 'оперы', 'оперные театры', 'театры оперы и балета', 'филармонии', 'концертные залы', 'цирки']);
const outdoor = new Set(['парки', 'парки культуры и отдыха', 'скверы', 'набережные',
  'смотровые площадки', 'заповедники', 'природные достопримечательности', 'памятники и скульптуры',
  'интересные здания', 'памятные доски', 'стрит-арт', 'фонтаны', 'водопады', 'руины', 'усадьбы',
  'сады / цветники', 'мост', 'родники', 'вершины гор', 'точки интереса', 'авиапамятники',
  'скалы', 'туристические маршруты', 'ботанический сад', 'ботанические сады', 'пляжи']);
export function agreedVisitMinutes(categoryName: string): number | undefined {
  const name = categoryName.trim().toLocaleLowerCase('ru-RU');
  if (food.has(name) || name === 'музеи') return 60;
  if (performances.has(name)) return 150;
  if (outdoor.has(name)) return WALK_STOP_MINUTES;
  return undefined;
}
