export const WALK_DISCOVERY_POLICY = 'walk-discovery.v1';
const scenic = new Set(['парки', 'парки культуры и отдыха', 'скверы', 'набережные',
  'смотровые площадки', 'природные достопримечательности', 'сады / цветники',
  'ботанический сад', 'пляжи', 'заповедники', 'туристические маршруты']);
const landmarks = new Set(['памятники и скульптуры', 'фонтаны', 'мост', 'водопады',
  'руины', 'родники', 'вершины гор', 'авиапамятники', 'скалы']);
export function walkRubricScores(ids: string[], names?: Record<string, string>) {
  return Object.fromEntries(ids.map(id => {
    const name = names?.[id]?.trim().toLocaleLowerCase('ru-RU');
    return [id, name && scenic.has(name) ? 2 : name && landmarks.has(name) ? 1 : 0];
  }));
}
