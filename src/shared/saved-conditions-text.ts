import type { SavedConditionsView } from './saved-conditions.js';

/** User-owned conditions only; never reconstruct an expired provider itinerary. */
export function savedConditionsText(saved: SavedConditionsView): string {
  const conditions = saved.conditions;
  const lines = ['Сохранённые условия', 'Места и прежний маршрут нужно проверить заново.'];
  for (const question of conditions.clarifications ?? []) lines.push(`Осталось уточнить: «${question.text}». До уточнения расчёт не выполняется.`);
  for (const day of conditions.days) {
    lines.push(`${day.date}${day.window ? ` · ${day.window.start}–${day.window.end}` : ' · время не указано'}`);
    lines.push(day.activities.map(activity => activity.label).join(' · ') || 'Занятия не выбраны');
    for (const [before, after] of day.order) {
      const left = day.activities.find(activity => activity.id === before), right = day.activities.find(activity => activity.id === after);
      if (left && right) lines.push(`Порядок: ${left.label} → ${right.label}`);
    }
    for (const activity of day.activities) {
      for (const requirement of activity.requirements) {
        lines.push(`${requirement.strength === 'required' ? 'Обязательно' : 'Пожелание'}: ${requirement.text}`);
      }
      if (activity.semantic_key === 'selected_event') {
        lines.push('Выбранное событие: сеанс, площадку и условия нужно проверить заново.');
        if (activity.target.visit_duration_minutes) lines.push(`Выбранная длительность посещения: ${activity.target.visit_duration_minutes} мин — ваша оценка.`);
      } else if (activity.category_reconfirmation_required) lines.push(`Для «${activity.label}» нужно заново уточнить ограничения выбора мест.`);
    }
  }
  const mobility = conditions.shared.mobility?.[0];
  const modes: Record<string, string> = { walking: 'пешком', driving: 'на машине', cycling: 'на велосипеде', public_transport: 'общественный транспорт с пешими участками' };
  if (mobility) lines.push(`Передвижение: ${modes[mobility] ?? mobility}`);
  if (conditions.shared.search_radius_meters !== undefined)
    lines.push(`Радиус от выбранного старта: ${new Intl.NumberFormat('ru-RU').format(conditions.shared.search_radius_meters / 1000)} км`);
  if (conditions.shared.party?.total) lines.push(`Участников: ${conditions.shared.party.total}`);
  const childAges = conditions.shared.party?.child_ages;
  if (childAges) lines.push(childAges.length ? `Возраст детей: ${childAges.join(', ')} лет` : 'Группа без детей');
  const budget = conditions.shared.budget;
  if (budget?.kind === 'limit') {
    const basis = budget.basis === 'per_person' ? 'на человека' : budget.basis === 'whole_party' ? 'на всех' : 'единицу нужно уточнить';
    const period = budget.period === 'per_day' ? 'за день' : budget.period === 'whole_trip' ? 'за поездку' : 'срок нужно уточнить';
    lines.push(`Бюджет: ${budget.amount_rub} ₽ ${basis}, ${period}${budget.enforcement === 'estimated' ? ' · приблизительный, соблюдение суммы не гарантируется' : ' · строгий лимит'}`);
  } else if (budget?.kind === 'unlimited') lines.push('Бюджет: без лимита');
  lines.push(conditions.points.origin
    ? 'Старт: сохранённая выбранная вами точка. Это не текущая геолокация.'
    : conditions.queries.origin ? `Старт: ${conditions.queries.origin}. Адрес нужно подтвердить заново.` : 'Старт нужно выбрать заново.');
  if (conditions.points.destination) lines.push('Финиш: сохранённая выбранная вами точка.');
  else if (conditions.queries.destination) lines.push(`Финиш: ${conditions.queries.destination}. Точку нужно подтвердить заново.`);
  else if (conditions.reconfirmation_required.some(issue => issue.field === 'points.destination'))
    lines.push('Финиш нужно выбрать заново; это условие остаётся обязательным до вашего изменения.');
  if (conditions.reconfirmation_required.some(issue => issue.code !== 'POINT_RECONFIRM_REQUIRED'))
    lines.push('Часть ограничений требует нового уточнения. Исходное пожелание остаётся в истории чата; автоматически снимать ограничения не будем.');
  if (Object.values(conditions.provenance).includes('suggested')) lines.push('Предложенные системой параметры остаются предложениями — проверьте их перед расчётом.');
  return lines.join('\n');
}
