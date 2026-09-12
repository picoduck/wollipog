/**
 * Classification of provider failure text carried on a durable command receipt.
 *
 * A scheduled automation gets one shot at its window. When the provider ends the first turn
 * because a *concurrent* Claude Code process held the credential refresh, nothing about the job
 * was wrong: the same prompt runs normally a minute later. Those failures are worth another
 * attempt; a genuine refusal, an invalid command, or a missing account is not, and retrying it
 * only burns the window and the budget again.
 *
 * The runner forwards the provider's own words, so the evidence is text. Matching is therefore
 * deliberately narrow: the provider must either name a known transient credential condition or
 * state in its own message that the caller should retry. Anything else stays terminal.
 */

/**
 * Conditions Claude Code reports by name and resolves on its own within about a minute. Each one
 * has to describe *contention* — another holder, a refresh already under way — not merely a failed
 * refresh: a revoked or expired token is also reported as a refresh failure, and that never clears
 * on its own. These outrank the durable indicators below, because the contention message ends by
 * suggesting a fresh login if the contention persists.
 */
const TRANSIENT_CONDITIONS = [
  /another claude code process is refreshing it/iu,
  /exited mid-refresh/iu,
  /(token|credential(s)?) (refresh|renewal) is (already )?in progress/iu,
  /\bcredential(s)? (refresh|renewal) contention/iu,
];

/** The provider telling the caller, in its own message, that the condition passes. */
const RETRY_ADVICE = [
  /this is usually transient/iu,
  /failed to refresh (the )?oauth token/iu,
  /\bretry in a (minute|moment|few (seconds|minutes))/iu,
  /\b(please )?(retry|try again) (in|after|later|shortly)/iu,
  /\btemporarily unavailable\b/iu,
  /\b(overloaded_error|rate_limit_error)\b/iu,
];

/** Text that names a durable problem. It vetoes generic retry advice quoted alongside it, but not
 * a named transient condition: the credential-contention message ends by suggesting a fresh login
 * *if the contention persists*, and that conditional aside must not make the first retry moot. */
const TERMINAL_CONDITIONS = [
  /\b(sign|log) ?in (again|required)\b/iu,
  /\bauthentication (is )?required\b/iu,
  /\binvalid (api key|credentials|command)\b/iu,
  /\bcredit balance is too low\b/iu,
  /\bpermission denied\b/iu,
];

/**
 * True when a provider failure is worth exactly one more attempt after a delay. Absent or empty
 * text is never transient: a receipt that says nothing is not evidence of a passing condition.
 */
export function isTransientProviderError(text: string | undefined): boolean {
  const detail = text?.trim();
  if (!detail) return false;
  if (TRANSIENT_CONDITIONS.some((pattern) => pattern.test(detail))) return true;
  if (TERMINAL_CONDITIONS.some((pattern) => pattern.test(detail))) return false;
  return RETRY_ADVICE.some((pattern) => pattern.test(detail));
}
