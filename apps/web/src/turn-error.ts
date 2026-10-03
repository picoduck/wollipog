import { withoutPromptFailedPrefix } from "./timeline.js";

/** The sentence a Turn Failed notice says when no known shape matches. */
export const TURN_ERROR_FALLBACK = "The agent stopped because of an error.";

/**
 * Known provider message shapes, most specific first. Drivers report failures as free text today;
 * once one carries a structured code (#1350) the code should decide the sentence and these
 * patterns only cover drivers that still send text. An unrecognized message never guesses.
 */
const TURN_ERROR_SHAPES: ReadonlyArray<{ pattern: RegExp; sentence: string }> = [
  {
    pattern: /\b(?:rate[ -]?limit|usage limit|quota|too many requests|429|credit balance (?:is )?too low|hit your limit)\b/i,
    sentence: "The provider's usage limit was reached. Wait for it to reset, then retry.",
  },
  {
    pattern: /\b(?:not (?:logged|signed) in|log ?in again|sign ?in again|please (?:log|sign) ?in|unauthori[sz]ed|unauthenticated|authentication (?:failed|required|error)|401|invalid (?:api[ _-]?key|x-api-key|credentials)|(?:oauth |access )?token (?:has )?expired)\b/i,
    sentence: "The provider account needs you to sign in again.",
  },
  {
    pattern: /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|socket hang up|fetch failed|network (?:error|request failed)|connection (?:was )?(?:lost|closed|reset|refused|error))\b/i,
    sentence: "The connection to the provider was lost.",
  },
  {
    pattern: /\b(?:content (?:policy|filter|management)|safety (?:system|filter)|usage polic(?:y|ies)|flagged as|violat(?:es|ed|ion) (?:of )?(?:our|the) (?:policy|policies|terms))\b/i,
    sentence: "The provider rejected the content of this turn.",
  },
];

/** A failed turn's error in plain words (docs/design-system.md §13.2): what happened and, where
 * one exists, what to do. The raw provider message stays behind Show Details. */
export function describeTurnError(message: string): string {
  const text = withoutPromptFailedPrefix(message);
  return TURN_ERROR_SHAPES.find(({ pattern }) => pattern.test(text))?.sentence ?? TURN_ERROR_FALLBACK;
}
