/**
 * Recognize provider/harness authentication failures without forwarding their raw text across the
 * driver boundary. Messages can contain tokens, authorization URLs, or credential diagnostics, so
 * callers must replace a match with static recovery guidance rather than logging the input.
 *
 * Keep this deliberately narrower than generic authorization. A 403, permission denial, account
 * entitlement, rate limit, or network failure is not evidence that the local harness must sign in.
 */
export function isProviderAuthenticationFailure(message: unknown): boolean {
  if (typeof message !== "string") return false;
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;

  if (/\bauthentication_failed\b/.test(normalized) ||
      /\b(?:not|never) (?:logged|signed) in\b/.test(normalized) ||
      /\blogin (?:is )?required\b/.test(normalized)) return true;

  const credential = /\b(?:api[ -]?key|oauth(?:2)? token|access token|auth(?:entication)? token|bearer token|credentials?)\b/;
  const invalid = /\b(?:invalid|incorrect|expired|revoked|missing|malformed|unrecognized)\b/;
  if (credential.test(normalized) && invalid.test(normalized)) return true;

  return /\b401\b|\bunauthorized\b/.test(normalized) &&
    /\b(?:auth(?:entication)?|bearer|basic|credential|token|api[ -]?key|login|sign[ -]?in)\b/.test(normalized);
}
