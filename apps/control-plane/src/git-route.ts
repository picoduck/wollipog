/** Validation + gating for POST /api/sessions/:id/git. Pure + unit-tested. */

import type {
  GitAction,
  GitActionRequest,
  GitDiffScope,
  RunnerProtocolCapability,
  SessionStatus,
} from "@wollipog/protocol";

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

const DIFF_SCOPES: readonly GitDiffScope[] = ["uncommitted", "all_branch", "last_turn"];
const isDiffScope = (v: unknown): v is GitDiffScope => DIFF_SCOPES.includes(v as GitDiffScope);

/**
 * Parse + validate a git action request body into a typed GitAction. Guards against
 * non-string field types (e.g. `{"message": 123}`) so the route returns a 400 instead
 * of throwing when `.trim()` is called on a non-string.
 */
export function parseGitAction(body: GitActionRequest): { action: GitAction } | { error: string } {
  switch (body?.action) {
    case "status":
      return { action: { kind: "status" } };
    case "summary":
      return { action: { kind: "summary" } };
    case "github_review_sync":
      return { action: { kind: "github_review_sync" } };
    case "diff": {
      if (!isDiffScope(body.scope)) {
        return { error: `invalid diff scope: ${String(body.scope)} (expected uncommitted | all_branch | last_turn)` };
      }
      return { action: { kind: "diff", scope: body.scope } };
    }
    case "commit": {
      const message = asString(body.message)?.trim();
      if (!message) return { error: "a commit message is required" };
      if (body.all !== undefined && typeof body.all !== "boolean") return { error: "all must be a boolean" };
      if (body.expectStaged !== undefined && typeof body.expectStaged !== "boolean") {
        return { error: "expectStaged must be a boolean" };
      }
      return {
        action: {
          kind: "commit",
          message,
          ...(body.all === undefined ? {} : { all: body.all }),
          ...(body.expectStaged === undefined ? {} : { expectStaged: body.expectStaged }),
        },
      };
    }
    case "stage_hunk": {
      if (body.direction !== "stage" && body.direction !== "unstage") {
        return { error: `invalid stage direction: ${String(body.direction)} (expected stage | unstage)` };
      }
      const filePath = asString(body.filePath);
      if (!filePath) return { error: "a filePath is required" };
      if (typeof body.hunkIndex !== "number" || !Number.isInteger(body.hunkIndex) || body.hunkIndex < 0) {
        return { error: `invalid hunkIndex: ${String(body.hunkIndex)} (expected a non-negative integer)` };
      }
      const diffHash = asString(body.diffHash);
      if (!diffHash || !/^[0-9a-f]{64}$/.test(diffHash)) {
        return { error: "a diffHash (sha256 hex from the diff response) is required" };
      }
      return { action: { kind: "stage_hunk", direction: body.direction, filePath, hunkIndex: body.hunkIndex, diffHash } };
    }
    case "stage_lines": {
      if (body.direction !== "stage" && body.direction !== "unstage") {
        return { error: `invalid stage direction: ${String(body.direction)} (expected stage | unstage)` };
      }
      const filePath = asString(body.filePath);
      if (!filePath) return { error: "a filePath is required" };
      if (typeof body.hunkIndex !== "number" || !Number.isInteger(body.hunkIndex) || body.hunkIndex < 0) {
        return { error: `invalid hunkIndex: ${String(body.hunkIndex)} (expected a non-negative integer)` };
      }
      if (!Array.isArray(body.lineIndices) || body.lineIndices.length < 1 || body.lineIndices.length > 500 ||
          body.lineIndices.some((index) => !Number.isInteger(index) || index < 0) ||
          new Set(body.lineIndices).size !== body.lineIndices.length) {
        return { error: "lineIndices must contain 1 to 500 unique non-negative integers" };
      }
      const diffHash = asString(body.diffHash);
      if (!diffHash || !/^[0-9a-f]{64}$/.test(diffHash)) {
        return { error: "a diffHash (sha256 hex from the diff response) is required" };
      }
      return {
        action: {
          kind: "stage_lines",
          direction: body.direction,
          filePath,
          hunkIndex: body.hunkIndex,
          lineIndices: body.lineIndices,
          diffHash,
        },
      };
    }
    case "discard_file": {
      const filePath = asString(body.filePath);
      if (!filePath) return { error: "a filePath is required" };
      const diffHash = asString(body.diffHash);
      if (!diffHash || !/^[0-9a-f]{64}$/.test(diffHash)) {
        return { error: "a diffHash (sha256 hex from the diff response) is required" };
      }
      return { action: { kind: "discard_file", filePath, diffHash } };
    }
    case "open_pr": {
      const title = asString(body.title)?.trim();
      if (!title) return { error: "a PR title is required" };
      return {
        action: {
          kind: "open_pr",
          title,
          body: asString(body.body) ?? "",
          branch: asString(body.branch)?.trim() || undefined,
          message: asString(body.message)?.trim() || undefined,
        },
      };
    }
    default:
      return { error: `unknown git action: ${String(body?.action)}` };
  }
}

/** A session is "busy" (a turn is running or an approval is pending) — unsafe to mutate git. */
const GIT_BUSY: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "queued",
  "starting",
  "running",
  "input_required",
]);

/**
 * Whether a git action may run for a session in the given state. Reads (status / diff) are
 * always allowed; mutations (staging / discard / commit / open_pr) require a quiescent session so they
 * don't stage or commit a partial snapshot mid-turn or race the post-turn diff capture.
 */
export function gitActionAllowed(action: GitAction, status: SessionStatus): { ok: true } | { ok: false; error: string } {
  if (action.kind === "status" || action.kind === "summary" || action.kind === "diff" || action.kind === "github_review_sync") return { ok: true };
  if (GIT_BUSY.has(status)) {
    return {
      ok: false,
      error: "the session is busy — wait for the current turn or approval to finish before staging, discarding, committing, or opening a PR",
    };
  }
  return { ok: true };
}

/** Primary-checkout sessions expose facts only. Every other Git surface remains isolated to a
 * runner-owned linked worktree, including read-only diffs and GitHub review reconciliation. */
export function gitActionRequiresLinkedWorktree(action: GitAction): boolean {
  return action.kind !== "status" && action.kind !== "summary";
}

/** Runner capability required by protocol-backed git actions; baseline actions predate capability gates. */
export function gitActionCapability(action: GitAction): readonly [RunnerProtocolCapability, string] | null {
  if (action.kind === "diff") return ["richDiff", "Rich diff loading"];
  if (action.kind === "stage_hunk") return ["hunkStaging", "Hunk staging"];
  if (action.kind === "stage_lines" || action.kind === "discard_file") {
    return ["fineGrainedDiff", "Line staging and tracked-file discard"];
  }
  if (action.kind === "github_review_sync") return ["githubReviewReconciliation", "GitHub review reconciliation"];
  return null;
}
