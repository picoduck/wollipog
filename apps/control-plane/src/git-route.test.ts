import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitActionRequest, SessionStatus } from "@wollipog/protocol";
import {
  gitActionAllowed,
  gitActionCapability,
  gitActionRequiresLinkedWorktree,
  parseGitAction,
} from "./git-route.js";

test("parseGitAction: status", () => {
  assert.deepEqual(parseGitAction({ action: "status" }), { action: { kind: "status" } });
});

test("parseGitAction: summary", () => {
  assert.deepEqual(parseGitAction({ action: "summary" }), { action: { kind: "summary" } });
});

test("GitHub review sync is a version-gated read", () => {
  assert.deepEqual(parseGitAction({ action: "github_review_sync" }), { action: { kind: "github_review_sync" } });
  assert.deepEqual(gitActionAllowed({ kind: "github_review_sync" }, "running"), { ok: true });
  assert.deepEqual(
    gitActionCapability({ kind: "github_review_sync" }),
    ["githubReviewReconciliation", "GitHub review reconciliation"],
  );
});

test("forge review sync is a v106-gated read and legacy GitHub remains available", () => {
  assert.deepEqual(parseGitAction({ action: "forge_review_sync" }), { action: { kind: "forge_review_sync" } });
  assert.deepEqual(gitActionAllowed({ kind: "forge_review_sync" }, "running"), { ok: true });
  assert.deepEqual(gitActionCapability({ kind: "forge_review_sync" }), ["forgeIntegration", "Forge review reconciliation"]);
  assert.equal(gitActionRequiresLinkedWorktree({ kind: "forge_review_sync" }), true);
  assert.deepEqual(gitActionCapability({ kind: "github_review_sync" }), ["githubReviewReconciliation", "GitHub review reconciliation"]);
});

test("gitActionAllowed: summary is a read — allowed even while a turn runs", () => {
  for (const s of ["queued", "running", "input_required", "idle", "completed"] as SessionStatus[]) {
    assert.deepEqual(gitActionAllowed({ kind: "summary" }, s), { ok: true });
  }
});

test("parseGitAction: commit requires a non-empty string message", () => {
  assert.deepEqual(parseGitAction({ action: "commit", message: "fix bug" }), {
    action: { kind: "commit", message: "fix bug" },
  });
  assert.deepEqual(parseGitAction({ action: "commit" }), { error: "a commit message is required" });
  assert.deepEqual(parseGitAction({ action: "commit", message: "   " }), { error: "a commit message is required" });
  // non-string must not throw — returns a validation error (P3)
  assert.deepEqual(parseGitAction({ action: "commit", message: 123 as unknown as string }), {
    error: "a commit message is required",
  });
});

test("parseGitAction: open_pr requires a title and carries optional message/branch/body", () => {
  assert.deepEqual(parseGitAction({ action: "open_pr", title: "Add X", body: "desc", branch: "feat", message: "commit msg" }), {
    action: { kind: "open_pr", title: "Add X", body: "desc", branch: "feat", message: "commit msg" },
  });
  // defaults: empty body, no branch/message
  assert.deepEqual(parseGitAction({ action: "open_pr", title: "Add X" }), {
    action: { kind: "open_pr", title: "Add X", body: "", branch: undefined, message: undefined },
  });
  assert.deepEqual(parseGitAction({ action: "open_pr" }), { error: "a PR title is required" });
  // non-string title is rejected, not thrown
  assert.deepEqual(parseGitAction({ action: "open_pr", title: 5 as unknown as string }), { error: "a PR title is required" });
});

test("parseGitAction: diff accepts each valid scope", () => {
  for (const scope of ["uncommitted", "all_branch", "last_turn"] as const) {
    assert.deepEqual(parseGitAction({ action: "diff", scope }), { action: { kind: "diff", scope } });
  }
});

test("parseGitAction: diff rejects a missing or invalid scope", () => {
  const noScope = parseGitAction({ action: "diff" });
  assert.ok("error" in noScope && /invalid diff scope/.test(noScope.error));
  const badScope = parseGitAction({ action: "diff", scope: "everything" as unknown as "uncommitted" });
  assert.ok("error" in badScope && /invalid diff scope/.test(badScope.error));
});

test("parseGitAction: unknown action", () => {
  const r = parseGitAction({ action: "nuke" as GitActionRequest["action"] });
  assert.ok("error" in r && /unknown git action/.test(r.error));
});

test("gitActionAllowed: status is always allowed", () => {
  for (const s of ["running", "input_required", "idle", "completed"] as SessionStatus[]) {
    assert.deepEqual(gitActionAllowed({ kind: "status" }, s), { ok: true });
  }
});

test("only status and summary may target a primary checkout", () => {
  assert.equal(gitActionRequiresLinkedWorktree({ kind: "status" }), false);
  assert.equal(gitActionRequiresLinkedWorktree({ kind: "summary" }), false);
  assert.equal(gitActionRequiresLinkedWorktree({ kind: "diff", scope: "uncommitted" }), true);
  assert.equal(gitActionRequiresLinkedWorktree({ kind: "commit", message: "m" }), true);
  assert.equal(gitActionRequiresLinkedWorktree({ kind: "github_review_sync" }), true);
});

test("gitActionAllowed: diff is a read — allowed in every status", () => {
  const statuses: SessionStatus[] = [
    "queued",
    "starting",
    "running",
    "input_required",
    "idle",
    "completed",
    "failed",
    "stopped",
  ];
  for (const s of statuses) {
    assert.deepEqual(gitActionAllowed({ kind: "diff", scope: "uncommitted" }, s), { ok: true });
    assert.deepEqual(gitActionAllowed({ kind: "diff", scope: "all_branch" }, s), { ok: true });
  }
});

test("gitActionAllowed: mutations blocked while busy, allowed when quiescent", () => {
  const commit = { kind: "commit", message: "m" } as const;
  for (const busy of ["queued", "starting", "running", "input_required"] as SessionStatus[]) {
    const r = gitActionAllowed(commit, busy);
    assert.equal(r.ok, false);
  }
  for (const quiet of ["idle", "completed", "stopped", "failed"] as SessionStatus[]) {
    assert.deepEqual(gitActionAllowed(commit, quiet), { ok: true });
    assert.deepEqual(gitActionAllowed({ kind: "open_pr", title: "t", body: "" }, quiet), { ok: true });
  }
});

test("parseGitAction: stage_hunk parses stage and unstage with a full identity", () => {
  const hash = "a".repeat(64);
  for (const direction of ["stage", "unstage"] as const) {
    const r = parseGitAction({ action: "stage_hunk", direction, filePath: "src/a.ts", hunkIndex: 2, diffHash: hash });
    assert.deepEqual(r, { action: { kind: "stage_hunk", direction, filePath: "src/a.ts", hunkIndex: 2, diffHash: hash } });
  }
});

test("parseGitAction: stage_hunk rejects bad direction, path, index, and hash", () => {
  const hash = "a".repeat(64);
  const base = { action: "stage_hunk" as const, direction: "stage" as const, filePath: "a.ts", hunkIndex: 0, diffHash: hash };
  assert.ok("error" in parseGitAction({ ...base, direction: "sideways" as never }));
  assert.ok("error" in parseGitAction({ ...base, filePath: "" }));
  assert.ok("error" in parseGitAction({ ...base, filePath: 42 as never }));
  assert.ok("error" in parseGitAction({ ...base, hunkIndex: -1 }));
  assert.ok("error" in parseGitAction({ ...base, hunkIndex: 1.5 }));
  assert.ok("error" in parseGitAction({ ...base, hunkIndex: "0" as never }));
  assert.ok("error" in parseGitAction({ ...base, diffHash: "zz" }));
  assert.ok("error" in parseGitAction({ ...base, diffHash: undefined }));
  assert.ok("error" in parseGitAction({ ...base, diffHash: "A".repeat(64) }), "uppercase hex rejected");
});

test("parseGitAction: stage_lines and discard_file validate stale-safe identities", () => {
  const hash = "b".repeat(64);
  assert.deepEqual(parseGitAction({
    action: "stage_lines", direction: "stage", filePath: "src/a.ts", hunkIndex: 1,
    lineIndices: [2, 4], diffHash: hash,
  }), {
    action: {
      kind: "stage_lines", direction: "stage", filePath: "src/a.ts", hunkIndex: 1,
      lineIndices: [2, 4], diffHash: hash,
    },
  });
  assert.deepEqual(parseGitAction({ action: "discard_file", filePath: "src/a.ts", diffHash: hash }), {
    action: { kind: "discard_file", filePath: "src/a.ts", diffHash: hash },
  });
  const base = {
    action: "stage_lines" as const, direction: "stage" as const, filePath: "a.ts",
    hunkIndex: 0, lineIndices: [1], diffHash: hash,
  };
  assert.ok("error" in parseGitAction({ ...base, lineIndices: [] }));
  assert.ok("error" in parseGitAction({ ...base, lineIndices: [1, 1] }));
  assert.ok("error" in parseGitAction({ ...base, lineIndices: [-1] }));
  assert.ok("error" in parseGitAction({ ...base, lineIndices: [1.5] }));
  assert.ok("error" in parseGitAction({ ...base, lineIndices: Array.from({ length: 501 }, (_, i) => i) }));
  assert.ok("error" in parseGitAction({ action: "discard_file", filePath: "", diffHash: hash }));
  assert.ok("error" in parseGitAction({ action: "discard_file", filePath: "a.ts", diffHash: "bad" }));
});

test("parseGitAction: commit accepts an optional boolean `all` and rejects non-booleans", () => {
  assert.deepEqual(parseGitAction({ action: "commit", message: "m", all: true }), {
    action: { kind: "commit", message: "m", all: true },
  });
  assert.deepEqual(parseGitAction({ action: "commit", message: "m" }), { action: { kind: "commit", message: "m" } });
  assert.ok("error" in parseGitAction({ action: "commit", message: "m", all: "yes" as never }));
});

test("gitActionAllowed: stage_hunk is a mutation — blocked while busy, allowed when quiescent", () => {
  const stage = { kind: "stage_hunk", direction: "stage", filePath: "a.ts", hunkIndex: 0, diffHash: "a".repeat(64) } as const;
  for (const busy of ["queued", "starting", "running", "input_required"] as SessionStatus[]) {
    const r = gitActionAllowed(stage, busy);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /staging/);
  }
  for (const quiet of ["idle", "completed", "stopped", "failed"] as SessionStatus[]) {
    assert.deepEqual(gitActionAllowed(stage, quiet), { ok: true });
  }
});

test("gitActionAllowed: fine-grained diff mutations are quiescent-only", () => {
  const hash = "a".repeat(64);
  const actions = [
    { kind: "stage_lines", direction: "stage", filePath: "a.ts", hunkIndex: 0, lineIndices: [1], diffHash: hash } as const,
    { kind: "discard_file", filePath: "a.ts", diffHash: hash } as const,
  ];
  for (const action of actions) {
    assert.equal(gitActionAllowed(action, "running").ok, false);
    assert.deepEqual(gitActionAllowed(action, "idle"), { ok: true });
  }
});

test("parseGitAction: commit accepts an optional boolean expectStaged and rejects non-booleans", () => {
  assert.deepEqual(parseGitAction({ action: "commit", message: "m", expectStaged: true }), {
    action: { kind: "commit", message: "m", expectStaged: true },
  });
  assert.deepEqual(parseGitAction({ action: "commit", message: "m", expectStaged: false }), {
    action: { kind: "commit", message: "m", expectStaged: false },
  });
  assert.ok("error" in parseGitAction({ action: "commit", message: "m", expectStaged: "yes" as never }));
});

test("gitActionCapability: rich diff and hunk staging are version-gated", () => {
  assert.deepEqual(gitActionCapability({ kind: "diff", scope: "uncommitted" }), ["richDiff", "Rich diff loading"]);
  assert.deepEqual(
    gitActionCapability({
      kind: "stage_hunk",
      direction: "stage",
      filePath: "a.ts",
      hunkIndex: 0,
      diffHash: "a".repeat(64),
    }),
    ["hunkStaging", "Hunk staging"],
  );
  assert.equal(gitActionCapability({ kind: "status" }), null);
  assert.equal(gitActionCapability({ kind: "commit", message: "m" }), null);
  assert.deepEqual(gitActionCapability({
    kind: "stage_lines", direction: "stage", filePath: "a.ts", hunkIndex: 0,
    lineIndices: [1], diffHash: "a".repeat(64),
  }), ["fineGrainedDiff", "Line staging and tracked-file discard"]);
  assert.deepEqual(gitActionCapability({
    kind: "discard_file", filePath: "a.ts", diffHash: "a".repeat(64),
  }), ["fineGrainedDiff", "Line staging and tracked-file discard"]);
});
