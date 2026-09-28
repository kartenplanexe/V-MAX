import type { PlanningView } from './planning-form.js';
type Draft = PlanningView['draft'];
type Question = NonNullable<Draft['clarifications']>[number];
export function clarificationReview(draft: Draft, question: Question) {
  const days = question.day_ids.length ? draft.days.filter(day => question.day_ids.includes(day.day_id)) : draft.days;
  const result = (label: string, current: string, section: 'time' | 'people' | 'budget' | 'points' | 'activities', ready: boolean) =>
    ({ label, current, section, ready });
  switch (question.field) {
    case 'dates': return result('Подтвердить даты', days.map(day => day.date).join(' · '), 'time', days.length > 0);
    case 'time': return result('Подтвердить время', days.map(day => `${day.date}: ${day.window ? `${day.window.start}–${day.window.end}` : 'время не указано'}`).join(' · '),
      'time', days.length > 0 && days.every(day => !!day.window));
    case 'mobility': return result('Подтвердить способ', ({ walking: 'Пешком', driving: 'На машине', cycling: 'На велосипеде', public_transport: 'Общественным транспортом' } as Record<string, string>)[draft.shared.mobility?.[0] ?? ''] ?? 'Не выбран',
      'people', draft.shared.mobility?.length === 1);
    case 'budget': {
      const budget = draft.shared.budget;
      return result('Подтвердить бюджет', budget?.kind === 'unlimited' ? 'Без ограничения бюджета' : budget?.kind === 'limit'
        ? `${budget.amount_rub} ₽ · ${budget.basis === 'whole_party' ? 'на всех' : budget.basis === 'per_person' ? 'на человека' : 'на кого — не указано'} · ${budget.period === 'per_day' ? 'за день' : budget.period === 'whole_trip' ? 'за поездку' : 'срок не указан'}` : 'Не указан',
      'budget', budget?.kind === 'unlimited' || budget?.kind === 'limit' && budget.basis !== 'unknown' && budget.period !== 'unknown');
    }
    case 'party': return result('Подтвердить состав', `Участников: ${draft.shared.party?.total ?? 'не указано'}; возраст детей: ${draft.shared.party?.child_ages?.length ? draft.shared.party.child_ages.join(', ') : draft.shared.party?.child_ages ? 'детей нет' : 'не указан'}`,
      'people', !!draft.shared.party?.total && draft.shared.party.child_ages !== undefined);
    case 'origin': case 'destination': {
      const point = draft.points[question.field];
      return result(question.field === 'origin' ? 'Подтвердить старт' : 'Подтвердить финиш', point?.label ?? (point ? `${point.lat}, ${point.lon}` : 'Не выбран'), 'points', !!point);
    }
    case 'activities': case 'order': return result(question.field === 'activities' ? 'Только эти занятия' : 'Подтвердить порядок',
      days.map(day => `${day.date}: ${day.activities.map(activity => activity.label).join(' · ') || 'занятия не выбраны'}${day.activities.length > 1 ? day.order.length
        ? '; порядок: ' + day.order.map(([a, b]) => `${day.activities.find(activity => activity.id === a)?.label} → ${day.activities.find(activity => activity.id === b)?.label}`).join(', ')
        : ' (порядок не задан)' : ''}`).join(' · '),
      'activities', days.length > 0 && days.every(day => day.activities.length > 0 && day.activities.every(activity => activity.intent_kind === 'event_visit' || activity.categories.state === 'matched' && activity.categories.include_any.length > 0)));
    default: return null;
  }
}
