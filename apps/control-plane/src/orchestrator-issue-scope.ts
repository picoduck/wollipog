const CAMPAIGN_REQUEST = /^\s*(?:please\s+)?(?:claim\s+and\s+)?(?:claim|orchestrate|coordinate|manage)\s+(?:github\s+)?issues?\s+((?:#?[1-9][0-9]{0,15})(?:(?:\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+)#?[1-9][0-9]{0,15})*)\b/iu;

/** Extract the finite issue scope from an authenticated human's explicit initial campaign request.
 * Free-form mentions, negated prose, follow-up turns, and agent-created sessions never reach this
 * parser. Returning an empty set keeps every GitHub write on the ordinary approval path. */
export function orchestratorIssueNumbersFromInitialPrompt(prompt: string): number[] {
  const match = CAMPAIGN_REQUEST.exec(prompt);
  if (!match?.[1]) return [];
  const numbers = match[1].match(/[1-9][0-9]{0,15}/gu) ?? [];
  const unique = [...new Set(numbers.map(Number).filter(Number.isSafeInteger))];
  return unique.length <= 100 ? unique : [];
}
