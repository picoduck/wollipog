/**
 * v296 (#4137): the installed or user-authored rule that keeps a typed workflow decision for a
 * person. A requester names it on `request_workflow_decision`; the occurrence is then created
 * human-owned (`owner_kept`) under any mode, grant or category. It only ever narrows authority, and
 * it is a claim the requester makes, never something anyone can rely on to grant one.
 */
export interface WorkflowDecisionOwnerRule {
  /** The file that keeps the gate for a person, as the requester read it, such as
   * `~/.claude/skills/issue-workflow/SKILL.md` or `AGENTS.md`. */
  source: string;
  /** The requirement, quoted from that file. Untrusted text: render it only as plain text. */
  quote: string;
}

export const WORKFLOW_DECISION_OWNER_RULE_SOURCE_MAX_CHARS = 256;
export const WORKFLOW_DECISION_OWNER_RULE_QUOTE_MAX_CHARS = 1000;

/** A path: ASCII letters, digits and `._~/\@+:-`, without whitespace. Nothing reads the file; the
 * narrow alphabet only keeps the card's source line unambiguous. */
const SOURCE_PATTERN = /^[A-Za-z0-9._~/\\@+:-]+$/u;
/** Control characters, including line breaks, and the invisible formatting characters that could
 * make a quote read differently from what it says: bidirectional overrides and isolates,
 * zero-width characters, and the byte-order mark. */
const QUOTE_FORBIDDEN = /[\p{Cc}\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;

/** Validates an `ownerRule` exactly as given. Oversize or malformed values are refused, never
 * truncated or repaired, so what the person reads is what the requester sent. `undefined` means
 * the request named no rule. */
export function normalizeWorkflowDecisionOwnerRule(value: unknown):
  { ok: true; rule: WorkflowDecisionOwnerRule | undefined } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, rule: undefined };
  const refuse = (detail: string) => ({ ok: false as const, message: `ownerRule ${detail}` });
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse("must be an object with source and quote");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "source" && key !== "quote")) return refuse("accepts only source and quote");
  const { source, quote } = record;
  if (typeof source !== "string" || !source.length) return refuse("source must name the file that keeps the gate");
  if (source.length > WORKFLOW_DECISION_OWNER_RULE_SOURCE_MAX_CHARS) {
    return refuse(`source must be at most ${WORKFLOW_DECISION_OWNER_RULE_SOURCE_MAX_CHARS} characters`);
  }
  if (!SOURCE_PATTERN.test(source)) return refuse("source must be a file path of letters, digits and ._~/\\@+:- without spaces");
  if (typeof quote !== "string" || !quote.trim().length) return refuse("quote must quote the requirement");
  if (quote.length > WORKFLOW_DECISION_OWNER_RULE_QUOTE_MAX_CHARS) {
    return refuse(`quote must be at most ${WORKFLOW_DECISION_OWNER_RULE_QUOTE_MAX_CHARS} characters`);
  }
  if (quote !== quote.trim()) return refuse("quote must not start or end with whitespace");
  if (QUOTE_FORBIDDEN.test(quote)) return refuse("quote must be one line without control or invisible formatting characters");
  return { ok: true, rule: { source, quote } };
}

export function sameWorkflowDecisionOwnerRule(a: WorkflowDecisionOwnerRule | undefined, b: WorkflowDecisionOwnerRule | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.source === b.source && a.quote === b.quote;
}
