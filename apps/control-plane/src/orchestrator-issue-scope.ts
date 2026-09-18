const CAMPAIGN_REQUEST = /^\s*(?:please\s+)?(?:claim\s+and\s+)?(?:claim|delegate|orchestrate|coordinate|manage)\s+(?:github\s+)?issues?\s+(.+?)\s*[.!?]?\s*$/iu;
const ISSUE_LIST = /^(?:#?[1-9][0-9]{0,15})(?:(?:\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+)(?:issues?\s+)?#?[1-9][0-9]{0,15})*$/iu;
const ISSUE_RANGE = /^#?([1-9][0-9]{0,15})\s+(?:through|to)\s+#?([1-9][0-9]{0,15})$/iu;
const MAX_ISSUE_SCOPE = 100;

/** Extract the finite issue scope from an authenticated human's explicit initial campaign request.
 * Free-form mentions, negated prose, follow-up turns, and agent-created sessions never reach this
 * parser. Returning an empty set keeps every GitHub write on the ordinary approval path. */
export function orchestratorIssueNumbersFromInitialPrompt(prompt: string): number[] {
  const match = CAMPAIGN_REQUEST.exec(prompt);
  if (!match?.[1]) return [];
  const scope = match[1];
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
