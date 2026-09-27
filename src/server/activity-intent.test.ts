import { describe, expect, it } from 'vitest';
import { classifyActivityIntent } from './activity-intent.js';

describe('activity intent as a general product policy', () => {
  it.each([
    ['Прогулка по центру', 'хочу погулять по центру', 'route_walk'],
    ['Пешая экскурсия по старым улицам', 'пешая экскурсия', 'route_walk'],
    ['Набережная', 'хочу пройтись по набережной', 'route_walk'],
    ['Прогулка по паркам', 'хочу прогуляться по паркам', 'route_walk'],
    ['Прогулка в парке', 'погулять в парке', 'area_walk'],
    ['Погулять по скверу', 'погулять по скверу', 'area_walk'],
    ['Кафе', 'погулять, а потом посидеть в кафе', 'place_visit'],
    ['Музей', 'пешком дойти до музея', 'place_visit'],
    ['Ресторан', 'поужинать в ресторане', 'place_visit'],
  ] as const)('classifies %s independently of one exact prompt', (label, evidence, expected) => {
    expect(classifyActivityIntent({ label, evidence })).toBe(expected);
  });
  it('does not convert an unfamiliar activity into a walk', () => {
    expect(classifyActivityIntent({ label: 'Мастер-класс по керамике', evidence: 'хочу что-то творческое' })).toBe('place_visit');
  });
});
