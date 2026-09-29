export const EVENT_CATEGORIES = [
  { id: 'exhibition', label: 'Выставки и экспозиции' },
  { id: 'theater', label: 'Спектакли, опера и балет' },
  { id: 'concert', label: 'Концерты' },
  { id: 'cinema', label: 'Кинопоказы' },
  { id: 'tour', label: 'Экскурсии' },
  { id: 'festival', label: 'Фестивали' },
  { id: 'kids', label: 'Детские события' },
  { id: 'quest', label: 'Квесты' },
  { id: 'education', label: 'Лекции и мастер-классы' },
  { id: 'party', label: 'Вечеринки' },
  { id: 'recreation', label: 'Активный отдых' },
] as const;

export function eventUnavailableText(code: string): string {
  if (['EVENT_OUTSIDE_DAY_WINDOW', 'NO_WINDOWS_IN_SCOPE', 'EVENT_NO_VISIT_WINDOW'].includes(code)) return 'Не попадает в выбранное время. Попробуйте другой день или расширьте время плана.';
  if (code.includes('HOURS') || code === 'VENUE_DAY_UNKNOWN') return 'Не указаны часы работы площадки на этот день. Уточните их у организатора или выберите другое событие.';
  if (code === 'DURATION_UNKNOWN') return 'Есть начало, но не указано время окончания. Пока нельзя проверить, успеете ли вы на остальные занятия.';
  if (code.includes('COORDINATES') || code.includes('VENUE_UNKNOWN')) return 'Нет точного адреса площадки. Добавить её в маршрут пока не получится.';
  if (code.includes('OUTSIDE') || code.includes('LOCALITY')) return 'Площадка за пределами выбранной области. Измените область поиска или выберите другое событие.';
  if (code === 'VENUE_UNAVAILABLE') return 'Площадка закрыта или её доступность не подтверждена.';
  return 'Не удалось подтвердить расписание этого события. Проверьте страницу организатора или выберите другое.';
}
