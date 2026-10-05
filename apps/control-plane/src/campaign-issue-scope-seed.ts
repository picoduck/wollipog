export function initialCampaignEpic(prompt: string): number | null {
  const match = /^\s*(?:please\s+)?(?:claim\s+and\s+)?(?:orchestrate|coordinate|manage|delegate)\s+(?:(?:github\s+)?epic\s+|(?:github\s+)?issue\s+)(?:#?)([1-9][0-9]{0,15})(?:\s+and\s+its\s+(?:child|member)\s+issues)?\s*[.!?]?\s*$/iu.exec(prompt);
  if (!match) return null;
  // Ordinary explicit issue requests retain their existing initial authorization.
  if (!/\bepic\b|\bits\s+(?:child|member)\s+issues\b/iu.test(prompt)) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}
