/** Conservative screening is supplementary to the exact sanitized-payload review. Unknown
 * public content must go through human review, rather than being silently rewritten. */
export function campaignPublicationSafe(title: string, body: string, labels: string[]): boolean {
  const text = [title, body, ...labels].join("\n");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text) ||
      /(?:\b(?:sk-[a-z0-9]{12,}|gh[pousr]_[a-z0-9]{12,})\b|\bBearer\s+\S+|(?:password|api[_ -]?key|secret|access[_ -]?token)\s*[:=]\s*(?!<)[^\s]+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)|https?:\/\/(?:localhost|127\.|10\.|192\.168\.|[^\s/]+\.internal\b))/iu.test(text)) return false;
  const headings = [...body.matchAll(/^## (.+)$/gmu)].map((m) => m[1]);
  const feature = ["Problem", "Proposed Behavior", "Acceptance Criteria", "Security and Compatibility"];
  const bug = ["Problem", "Reproduction Steps", "Actual Behavior", "Expected Behavior", "Environment", "Acceptance Criteria"];
  return [feature, bug].some((required) => required.every((heading, i) => headings.indexOf(heading) >= 0 &&
    (i === 0 || headings.indexOf(heading) > headings.indexOf(required[i - 1]!)))) && /^\s*-\s+(?:\[[ xX]\]\s+)?\S/mu.test(body);
}

export function campaignPublicationTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}
