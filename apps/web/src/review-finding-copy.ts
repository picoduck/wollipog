/**
 * How a review finding reads (#2850; docs/design-system.md §11.1, §11.3, §17): its one severity
 * badge, who wrote it and when, and where it points. Shared by the Findings section above the diff
 * and the inline findings in the diff (#2851), so both say the same thing in the same words.
 *
 * Nothing here prints a raw identifier: a local author is "You" or their display name, never a user
 * id; the scope shows only when it differs from the one on screen; the diff side never shows.
 */
import type { GitDiffScope, ReviewFinding, ReviewFindingSeverity, SourceLocation } from "@wollipog/protocol";
import { normalizeSourcePath } from "@wollipog/protocol";
import { formatRecordedRelativeTime } from "./format.js";
import { humanResolver, resolverName, type ViewerIdentity } from "./resolver-identity.js";
import type { StatusTone } from "./status-meta.js";

/** The severity badge (§11.1): Blocker danger, Major warning, Minor and Nit neutral. */
export const FINDING_SEVERITY: Readonly<Record<ReviewFindingSeverity, { label: string; tone: StatusTone }>> = {
  blocker: { label: "Blocker", tone: "danger" },
  major: { label: "Major", tone: "warning" },
  minor: { label: "Minor", tone: "neutral" },
  nit: { label: "Nit", tone: "neutral" },
};

/** The scope names Review's toolbar uses, for a finding written against another scope. */
const SCOPE_LABEL: Readonly<Record<GitDiffScope, string>> = {
  uncommitted: "Uncommitted",
  all_branch: "Branch",
  last_turn: "Last Turn",
};

export function forgeName(provider: "github" | "gitlab"): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

/** A finding that is still waiting on someone: open, or sent to the agent and not yet resolved. */
export function isOpenFinding(finding: ReviewFinding): boolean {
  return finding.status === "open" || finding.status === "sent";
}

/**
 * Who wrote the finding and when: "You · 12m ago", "Ada Lovelace · 1h ago", or for a forge thread
 * "octocat on GitHub · 1h ago". A local finding written against another scope adds it
 * ("You · 2h ago · Branch"). While the viewer's identity is unknown the author is left out rather
 * than guessed.
 */
export function findingProvenance(
  finding: ReviewFinding,
  { viewer, now, scope }: { viewer: ViewerIdentity | null; now: number; scope: GitDiffScope | null },
): string {
  const parts: string[] = [];
  if (finding.remote) {
    const forge = forgeName(finding.remote.provider);
    parts.push(finding.author.id ? `${finding.author.id} on ${forge}` : forge);
  } else if (finding.author.kind === "human") {
    const resolver = humanResolver(viewer, finding.author.id);
    if (resolver) parts.push(resolverName(resolver, { titleCase: true }));
  } else {
    parts.push(finding.author.kind === "agent" ? "Agent" : finding.author.kind === "policy" ? "Policy" : "System");
  }
  const age = formatRecordedRelativeTime(finding.createdAt, now);
  if (age) parts.push(age);
  if (!finding.remote && scope !== null && finding.scope !== scope) parts.push(SCOPE_LABEL[finding.scope]);
  return parts.join(" · ");
}

export interface FindingLocation {
  /** The file's base name and line, "CheckoutPage.tsx:54"; null for a forge discussion with no file. */
  label: string | null;
  /** The full path (and line), for the tooltip. */
  title: string | null;
  /** Where Files opens it, or null when there is nothing in the worktree to open. */
  source: SourceLocation | null;
}

/**
 * Where a finding points. A right-side finding opens Files at its line; a left-side one names a line
 * of the old file, so it opens the file without a line, as a file-level forge comment does.
 */
export function findingLocation(finding: ReviewFinding): FindingLocation {
  if (finding.remote?.subjectType === "remote") return { label: null, title: null, source: null };
  const fileLevel = finding.remote?.subjectType === "file";
  const base = finding.filePath.split("/").filter(Boolean).at(-1) ?? finding.filePath;
  const path = normalizeSourcePath(finding.filePath);
  return {
    label: fileLevel ? base : `${base}:${finding.line}`,
    title: fileLevel ? finding.filePath : `${finding.filePath}:${finding.line}`,
    source: path ? { path, ...(fileLevel || finding.side !== "right" ? {} : { line: finding.line }) } : null,
  };
}
