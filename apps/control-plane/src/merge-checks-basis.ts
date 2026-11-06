import type { PullRequestChecksRead, WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";

/** A runner's answer as the wire carries it: an exact `PullRequestChecksRead`, or null. Runner
 * frames are not validated on the wire, so nothing else is read. */
export function validPullRequestChecksRead(value: unknown): PullRequestChecksRead | null {
  const read = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!read || !Number.isSafeInteger(read.required) || (read.required as number) < 0 || typeof read.clean !== "boolean" ||
      !Array.isArray(read.reported) || read.reported.length > 100) return null;
  const reported: PullRequestChecksRead["reported"] = [];
  for (const raw of read.reported) {
    const check = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!check || typeof check.name !== "string" || check.name.length < 1 || check.name.length > 256 ||
        (check.state !== "passed" && check.state !== "pending" && check.state !== "failing")) return null;
    reported.push({ name: check.name, state: check.state });
  }
  return { required: read.required as number, reported, clean: read.clean };
}

/** Why GitHub's checks do not support a merge on the all-reported basis (#4119), or null when they
 * do. A repository whose head reports required checks uses them as before; every reported check
 * must pass, under a clean merge state, and the snapshot must name exactly those checks. A head
 * with no checks at all is admitted here only to be the person's (`no_checks`). `revoke` says the
 * snapshot itself is wrong; otherwise the same snapshot may be tried again once GitHub agrees. */
export function allReportedChecksRefusal(
  snapshot: Extract<WorkflowDecisionResourceSnapshot, { category: "pr_merge" }>,
  read: PullRequestChecksRead,
): { revoke: boolean; message: string } | null {
  if (read.required > 0) {
    return { revoke: true, message: "GitHub marks checks of this pull request as required, so the merge must cite its required checks: request it again without checksBasis." };
  }
  if (read.reported.some((check) => check.state === "failing")) {
    return { revoke: false, message: "A check GitHub reports for this pull request's head is failing, so nothing changed." };
  }
  if (read.reported.some((check) => check.state === "pending")) {
    return { revoke: false, message: "A check GitHub reports for this pull request's head has not finished, so nothing changed. Try again once every check passes." };
  }
  const reported = new Set(read.reported.map((check) => check.name));
  const cited = new Set(snapshot.requiredChecks.checks.map((check) => check.name));
  if (reported.size !== cited.size || [...cited].some((name) => !reported.has(name))) {
    return { revoke: true, message: "The merge must cite exactly the checks GitHub reports for this pull request's head, each passing." };
  }
  if (reported.size > 0 && !read.clean) {
    return { revoke: false, message: "GitHub does not report this pull request's merge state as clean, so nothing changed. Try again once it is." };
  }
  return null;
}
