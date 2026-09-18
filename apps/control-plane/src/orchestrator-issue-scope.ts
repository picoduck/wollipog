const CAMPAIGN_REQUEST = /^\s*(?:please\s+)?(?:claim\s+and\s+)?(?:claim|delegate|orchestrate|coordinate|manage)\s+(?:github\s+)?issues?\s+/iu;
const ISSUE_LIST = /^(?:#?[1-9][0-9]{0,15})(?:(?:\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+)(?:issues?\s+)?#?[1-9][0-9]{0,15})*$/iu;
const ISSUE_RANGE = /^#?([1-9][0-9]{0,15})\s+(?:through|to)\s+#?([1-9][0-9]{0,15})$/iu;
const ISSUE_SCOPE_PREFIX = /^(#?[1-9][0-9]{0,15}\s+(?:through|to)\s+#?[1-9][0-9]{0,15}|#?[1-9][0-9]{0,15}(?:(?:\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+)(?:issues?\s+)?#?[1-9][0-9]{0,15})*)(?=\s*(?:[.!?](?:\s|$)|$))/iu;
const AMBIGUOUS_TRAILING_SCOPE = /(?:#?[1-9][0-9]{0,15}|\b(?:but|except|exclude|instead|not)\b|\bdo\s+not\b|\bdon['’]t\b)/iu;
const MAX_ISSUE_SCOPE = 100;

/** Extract the finite issue scope from an authenticated human's explicit initial campaign request.
 * Free-form mentions, negated prose, follow-up turns, and agent-created sessions never reach this
 * parser. Returning an empty set keeps every GitHub write on the ordinary approval path. */
export function orchestratorIssueNumbersFromInitialPrompt(prompt: string): number[] {
  const match = CAMPAIGN_REQUEST.exec(prompt);
  if (!match) return [];
  const remainder = prompt.slice(match[0].length);
  const scopeMatch = ISSUE_SCOPE_PREFIX.exec(remainder);
  if (!scopeMatch?.[1]) return [];
  const scope = scopeMatch[1];
  const trailing = remainder.slice(scopeMatch[0].length);
  if (AMBIGUOUS_TRAILING_SCOPE.test(trailing)) return [];
  const range = ISSUE_RANGE.exec(scope);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start ||
        end - start + 1 > MAX_ISSUE_SCOPE) return [];
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }
  if (!ISSUE_LIST.test(scope)) return [];
  const numbers = scope.match(/[1-9][0-9]{0,15}/gu) ?? [];
  const unique = [...new Set(numbers.map(Number).filter(Number.isSafeInteger))];
  return unique.length <= MAX_ISSUE_SCOPE ? unique : [];
}
