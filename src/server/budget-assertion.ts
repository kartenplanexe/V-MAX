/** Narrow evidence check, not a monetary intent parser. Unknown wording asks
 * for a typed answer instead of authorizing unlimited spending. */
export const budgetAssertionVersion = 'budget-assertion.v1';
const explicitUnlimited = [
  /^(?:(?:мой|наш|общий)\s+)?бюджет\s*(?:—|-|:)?\s*(?:не\s+ограничен|неограниченный|без\s+(?:ограничений|лимита)|любой|не\s+важен)$/iu,
  /^без\s+ограничени[яй]\s+(?:бюджета|расходов|трат)$/iu,
  /^(?:на|по)\s+(?:расходы|расходам|бюджет|бюджету)\s+ограничений\s+нет$/iu,
  /^(?:цена|стоимость|сумма)\s+не\s+имеет\s+значения$/iu,
  /^(?:расходы|траты)\s+(?:не\s+ограничены|без\s+ограничений)$/iu,
];
const budgetMention = /(?<!\p{L})бюджет(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?!\p{L})/iu;

export function reviewBudgetAssertion(input: {
  userText: string;
  budgetKind?: string;
  evidence?: string;
  hasBudgetQuestion: boolean;
}) {
  const quote = input.evidence?.trim().replace(/[.!]+$/u, '').trim() ?? '';
  const discardBudget = input.budgetKind === 'unlimited' && !explicitUnlimited.some(pattern => pattern.test(quote));
  const missingBudget = (!input.budgetKind || input.budgetKind === 'unspecified') && budgetMention.test(input.userText);
  return { discardBudget, question: !input.hasBudgetQuestion && (discardBudget || missingBudget)
    ? { field: 'budget' as const, day_ids: [] as string[], text: discardBudget && input.evidence ? input.evidence : input.userText,
      reason: 'ambiguous' as const } : null };
}
