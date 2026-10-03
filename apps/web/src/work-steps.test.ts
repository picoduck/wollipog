import assert from "node:assert/strict";
import { test } from "node:test";
import type { TimelineItem } from "./timeline.js";
import {
  diffLineCounts,
  failureLines,
  foldRetries,
  mergeWork,
  retryNeighbours,
  splitStepTitle,
  subagentName,
  summarizeWork,
  workspaceRelativePath,
} from "./work-steps.js";

const tool = (id: number, title: string, status: string, toolKind = "execute"): TimelineItem => ({
  kind: "tool_call", id, toolCallId: `call-${id}`, title, toolKind, status, text: "",
});

test("consecutive attempts at a failed call fold into one step whose latest attempt is its status", () => {
  const steps = foldRetries([
    tool(1, "Bash: npm test", "failed"),
    tool(2, "Bash: npm test", "failed"),
    tool(3, "Bash: npm test", "failed"),
    tool(4, "Bash: npm run lint", "completed"),
  ]);
  assert.deepEqual(steps.map((step) => [step.item.id, step.attempts?.map((attempt) => attempt.id) ?? null]), [
    [3, [1, 2, 3]],
    [4, null],
  ]);
});

test("only a failure folds the next attempt: a success, another kind or another title starts a new step", () => {
  const steps = foldRetries([
    tool(1, "Read: a.ts", "completed", "read"),
    tool(2, "Read: a.ts", "completed", "read"),
    tool(3, "Bash: make", "failed"),
    tool(4, "Bash: make", "completed"),
    tool(5, "Bash: make", "failed"),
    tool(6, "Bash: make", "running", "other"),
    tool(7, "Bash: make", "failed"),
    { kind: "agent_thought", id: 8, text: "Try again" },
    tool(9, "Bash: make", "running"),
  ]);
  assert.deepEqual(steps.map((step) => [step.item.id, step.attempts?.length ?? 1]), [
    [1, 1], [2, 1], [4, 2], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1],
  ]);
});

test("an agent call never folds, because it owns its subagent's rows", () => {
  const steps = foldRetries([tool(1, "Task: audit", "failed", "agent"), tool(2, "Task: audit", "failed", "agent")]);
  assert.equal(steps.length, 2);
  assert.equal(retryNeighbours([tool(1, "Task: audit", "failed", "agent"), tool(2, "Task: audit", "failed", "agent")], 1, null), false);
});

test("the ledger counts a folded retry once and a failure by its latest attempt", () => {
  const ledger = summarizeWork([
    { ...tool(1, "Bash: build", "failed"), startedAt: 1_000, completedAt: 2_000 } as TimelineItem,
    { ...tool(2, "Bash: build", "completed"), startedAt: 3_000, completedAt: 27_000 } as TimelineItem,
    tool(3, "Bash: test", "failed"),
    { kind: "file_edit", id: 4, path: "src/a.ts" },
    { kind: "agent_thought", id: 5, text: "", createdAt: 500, completedAt: 900 },
    { kind: "review_decision", id: 6, reviewId: "r", reviewer: { kind: "policy" }, outcome: "allowed", riskLevel: "medium" },
  ]);
  assert.deepEqual(ledger, {
    tools: 2, edits: 1, thoughts: 1, failed: 1, autoApproved: 1, highestReviewRisk: "medium", startedAt: 500, finishedAt: 27_000,
  });
  assert.deepEqual(mergeWork(ledger, summarizeWork([tool(7, "Bash: x", "failed")])), { ...ledger, tools: 3, failed: 2 });
  assert.deepEqual(summarizeWork([]), { tools: 0, edits: 0, thoughts: 0, failed: 0, autoApproved: 0 },
    "an absent risk or span is omitted, never undefined, so incremental and full rows compare equal");
});

test("a provider title becomes a verb and a workspace-relative object", () => {
  const root = "/home/dev/repo";
  assert.deepEqual(splitStepTitle("Edit: /home/dev/repo/src/components/Header.tsx", root), {
    verb: "Edit", object: "src/components/Header.tsx",
  });
  assert.deepEqual(splitStepTitle("Bash: npm test", root), { verb: "Run", object: "npm test" });
  assert.deepEqual(splitStepTitle("$ cargo build --release"), { verb: "Run", object: "cargo build --release" });
  assert.deepEqual(splitStepTitle("Grep: TODO"), { verb: "Search", object: "TODO" });
  assert.deepEqual(splitStepTitle("Read /etc/hosts"), { verb: "Read /etc/hosts" });
  assert.deepEqual(splitStepTitle("Read: /elsewhere/a.ts", root), { verb: "Read", object: "/elsewhere/a.ts" },
    "a path outside the session root stays as given");
  assert.equal(workspaceRelativePath("C:\\work\\repo\\src\\a.ts", "C:\\work\\repo\\"), "src/a.ts");
  assert.equal(workspaceRelativePath("/home/dev/repo-other/a.ts", "/home/dev/repo"), "/home/dev/repo-other/a.ts");
});

test("a diff's line counts ignore its file headers", () => {
  assert.deepEqual(diffLineCounts("--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more\n ctx"), { added: 2, removed: 1 });
  assert.deepEqual(diffLineCounts("--- a/x\n+++ b/x\n@@ -1 +1 @@\n---counter;\n+++counter;"), { added: 1, removed: 1 },
    "a changed line that starts with -- or ++ is a change inside its hunk, not a file header");
  assert.deepEqual(diffLineCounts("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -0,0 +1 @@\n+c"),
    { added: 2, removed: 1 }, "each file's header is skipped");
  assert.deepEqual(diffLineCounts("-old\n+new"), { added: 1, removed: 1 }, "a bare body without a hunk header still counts");
  assert.equal(diffLineCounts(undefined), null);
});

test("a failure's exit code and error lines are found; output with neither is all error", () => {
  const found = failureLines("Exit code 2\nCompiling…\nerror[E0308]: mismatched types\n  --> src/main.rs:4:5");
  assert.equal(found.exitCode, 2);
  assert.deepEqual(found.failing, [true, false, true, false]);
  const plain = failureLines("File does not exist.\n");
  assert.deepEqual(plain.failing, [true, false]);
  assert.equal(plain.exitCode, undefined);
});

test("an agent is named after its spawning call, never the provider's bare tool name (#2183)", () => {
  assert.equal(subagentName({ title: "Coordinate Release Audit", text: "" }), "Coordinate Release Audit");
  assert.equal(subagentName({ title: "Agent: Investigate the flaky parser test", text: "" }), "Investigate the flaky parser test",
    "Codex's spawn label is dropped; the Bot icon already says it is an agent");
  assert.equal(
    subagentName({ title: "Task", text: '{"description":"Audit  release\\ngates","prompt":"Check every gate","subagent_type":"Explore"}\nDone.' }),
    "Audit release gates",
    "Claude Code titles a spawn just Task; its input leads with the description",
  );
  assert.equal(subagentName({ title: "Task", text: '{"description":"Audit rel' }), "Agent", "a truncated description names nothing");
  assert.equal(subagentName({ title: "Task", text: '{"prompt":"Check every gate","description":"Later"}' }), "Agent",
    "only a leading description is read, never prose inside the prompt");
  assert.equal(subagentName({ title: "Agent", text: "" }), "Agent");
});
