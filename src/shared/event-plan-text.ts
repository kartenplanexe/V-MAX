/** The bot and mini-app explain the same event gap without exposing provider diagnostics. */
export function eventGapText(code: string): string {
  const descriptions: Record<string, string> = {
    EVENT_HTTP_BUDGET_EXHAUSTED: 'Проверка события не завершена в пределах одного расчёта. Попробуйте ещё раз или измените набор занятий.',
    EVENT_DEADLINE_EXCEEDED: 'Проверка события не завершена вовремя. Попробуйте ещё раз.',
    EVENT_SELECTION_CHANGED: 'Сеанс изменился. Откройте афишу и выберите подходящий вариант заново.',
    EVENT_LOCATION_CHANGED: 'Площадка изменилась. Проверьте новый адрес и выберите событие заново.',
    EVENT_LOCALITY_UNSUPPORTED: 'Афиша этого города пока недоступна.',
    EVENT_OUTSIDE_LOCALITY: 'Площадка находится вне выбранного города. Выберите другое событие.',
    EVENT_OUTSIDE_DAY_WINDOW: 'Полный сеанс не помещается в выбранное время. Измените время или выберите другой сеанс.',
    EVENT_NOT_SCHEDULED: 'Не удалось включить событие с остальными условиями. Проверьте время, порядок и точку старта.',
    EVENT_RECHECK_REQUIRED: 'Срок проверки выбранного события истёк. Перепроверьте его в условиях плана.',
    AGE_ELIGIBILITY_DATA_REQUIRED: 'Недостаточно сведений для проверки возрастного ограничения.',
    EVENT_PROVIDER_UNAVAILABLE: 'Источник событий сейчас недоступен. Попробуйте позднее.',
    EVENT_PROVIDER_ERROR: 'Не удалось получить данные события. Ваш выбор сохранён; повторите проверку позже.',
    EVENT_PROVIDER_SCHEMA_ERROR: 'Источник не подтвердил пригодные сведения о событии. Выберите или перепроверьте событие.',
  };
  return descriptions[code] ?? 'Не удалось подтвердить событие. Нужно проверить выбор заново в приложении.';
}
