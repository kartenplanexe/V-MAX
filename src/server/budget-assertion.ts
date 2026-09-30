// Check quoted budget evidence; ambiguous input requires a form answer.
export const budgetAssertionVersion = 'budget-assertion.v2';
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
  amountRub?: number;
  evidence?: string;
  hasBudgetQuestion: boolean;
}) {
  const quote = input.evidence?.trim().replace(/[.!]+$/u, '').trim() ?? '';
  const amounts = [...quote.matchAll(/(?<![\p{L}\d])([0-9]+(?:[ \u00a0\u202f][0-9]{3})*(?:[.,][0-9]{1,2})?)\s*(тыс(?:яч[аиу]?)?\.?|млн\.?)?\s*(?:руб(?:л[её]й|ля|ль|лей)?\.?|₽|р\.(?!\p{L}))/giu)]
    .map(match => Number(match[1]!.replace(/[ \u00a0\u202f]/gu, '').replace(',', '.')) *
      (match[2]?.startsWith('тыс') ? 1000 : match[2]?.startsWith('млн') ? 1_000_000 : 1));
  // Without currency, accept only a single number in an explicit budget quote.
  if (!amounts.length && budgetMention.test(quote)) {
    const plain = [...quote.matchAll(/\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d{1,2})?/gu)];
    if (plain.length === 1 && !/тыс|млн/iu.test(quote)) amounts.push(Number(plain[0]![0].replace(/[ \u00a0\u202f]/gu, '').replace(',', '.')));
  }
  const mismatch = input.budgetKind === 'limit' && (amounts.length !== 1 ||
    !Number.isFinite(input.amountRub) || Math.round(amounts[0]! * 100) !== Math.round(input.amountRub! * 100));
  const discardBudget = mismatch || input.budgetKind === 'unlimited' && !explicitUnlimited.some(pattern => pattern.test(quote));
  const missingBudget = (!input.budgetKind || input.budgetKind === 'unspecified') && budgetMention.test(input.userText);
  return { discardBudget, question: !input.hasBudgetQuestion && (discardBudget || missingBudget)
    ? { field: 'budget' as const, day_ids: [] as string[], text: discardBudget && input.evidence ? input.evidence : input.userText,
      reason: 'ambiguous' as const } : null };
}
