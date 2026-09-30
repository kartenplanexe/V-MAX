import type { PlanningView } from './planning-form.js';

type Plan = NonNullable<PlanningView['result']>;

export const partialSearchNotice = 'Получена только часть мест. Подходящие варианты могут остаться за пределами поиска.';
export const routingUnavailableNotice = 'Сервис проверки дороги сейчас недоступен. Ваши условия сохранены — повторите расчёт позже.';

export function planWarningCodes(plan: Plan): string[] {
  return [...new Set([...plan.warnings, ...(plan.search_scope?.coverage === 'PARTIAL' ? ['RETRIEVAL_PARTIAL'] : [])])];
}

export function planFailureNotice(plan: Plan): string {
  if (plan.issues?.includes('ROUTING_PROVIDER_UNAVAILABLE')) return routingUnavailableNotice;
  if (plan.issues?.some(issue => ['ROUTING_BUDGET_EXCEEDED', 'ROUTING_BUDGET_OR_DEADLINE_EXCEEDED'].includes(issue)))
    return 'Не удалось закончить проверку всех переходов в одном расчёте. Можно повторить расчёт или разделить занятия по дням.';
  return 'Не удалось завершить проверку маршрута. Ваши условия сохранены; можно повторить расчёт.';
}

export function unavailablePlanNotice(plan: Plan): string {
  if (plan.warnings.some(warning => ['ROUTING_PROVIDER_FAILURE', 'ROUTE_MATRIX_INCOMPLETE'].includes(warning)))
    return 'Места могли найтись, но сейчас не удалось проверить путь до них. Можно повторить расчёт позже или выбрать другой старт.';
  return 'Подходящий маршрут не получился. Попробуйте изменить запрос и выполните запрос снова.';
}
