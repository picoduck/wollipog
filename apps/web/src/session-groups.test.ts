import assert from "node:assert/strict";
import test from "node:test";
import type { SessionView } from "@wollipog/protocol";
import type { InboxSplit } from "./inbox.js";
import {
  sessionGroupAttentionWords,
  sessionGroupFullName,
  sessionGroupLabels,
  sessionGroupRunnerId,
  sessionGroupSummary,
} from "./session-groups.js";

const legacy = (key: string, name: string, runnerId: string): Pick<InboxSplit, "key" | "name" | "project"> => ({
  key,
  name,
  project: { kind: "legacy", runnerId, workspaceId: key },
});
const machines: Record<string, string> = { "runner-a": "Studio Mac", "runner-b": "Build Server 02" };
const machineName = (runnerId: string) => machines[runnerId] ?? runnerId;

test("only a name two groups share carries its machine", () => {
  const labels = sessionGroupLabels([
    { key: null, name: "All", project: null },
    legacy("docs-a", "Docs Site", "runner-a"),
    legacy("docs-b", "Docs Site", "runner-b"),
    legacy("api", "API", "runner-a"),
  ], machineName);
  assert.deepEqual([...labels.entries()], [
    [null, { name: "All" }],
    ["docs-a", { name: "Docs Site", machine: "Studio Mac" }],
    ["docs-b", { name: "Docs Site", machine: "Build Server 02" }],
    ["api", { name: "API" }],
  ]);
  assert.equal(sessionGroupFullName(labels.get("docs-b")!), "Docs Site on Build Server 02");
  assert.equal(sessionGroupFullName(labels.get("api")!), "API");
});

test("a shared name with no machine to tell it apart stays bare", () => {
  const labels = sessionGroupLabels([
    { key: "durable-a", name: "Docs Site", project: null },
    legacy("docs-b", "Docs Site", "runner-b"),
    legacy("docs-c", "Docs Site", "runner-blank"),
  ], (runnerId) => runnerId === "runner-blank" ? "  " : machineName(runnerId));
  assert.deepEqual(labels.get("durable-a"), { name: "Docs Site" });
  assert.deepEqual(labels.get("docs-b"), { name: "Docs Site", machine: "Build Server 02" });
  assert.deepEqual(labels.get("docs-c"), { name: "Docs Site" });
});

test("a durable Project's machine is its primary Location's", () => {
  assert.equal(sessionGroupRunnerId({ project: null }), null);
  assert.equal(sessionGroupRunnerId(legacy("docs", "Docs", "runner-b")), "runner-b");
  const durable = (runnerId: string | null) => ({
    project: {
      kind: "durable" as const,
      project: {} as never,
      primaryLocation: runnerId === null ? null : { runnerId } as never,
      legacyKeys: [],
    },
  });
  assert.equal(sessionGroupRunnerId(durable("runner-a")), "runner-a");
  assert.equal(sessionGroupRunnerId(durable(null)), null);
});

test("the summary names nonzero parts in sentence case, and Snoozed counts only snoozed sessions", () => {
  const running = { status: "running" } as SessionView;
  const idle = { status: "idle" } as SessionView;
  const split = (count: number, blockedCount: number, stalledCount: number, sessions: SessionView[]) =>
    ({ count, blockedCount, stalledCount, sessions });
  assert.equal(sessionGroupSummary(split(9, 1, 1, [running, running, idle])), "9 sessions: 1 needs you, 1 stalled, 2 running");
  assert.equal(sessionGroupSummary(split(4, 2, 0, [idle])), "4 sessions: 2 need you");
  assert.equal(sessionGroupSummary(split(1, 0, 0, [idle])), "1 session");
  assert.equal(sessionGroupSummary(split(0, 0, 0, [])), "0 sessions");
  assert.equal(sessionGroupSummary(split(3, 1, 1, [running]), true), "3 snoozed sessions");
  assert.equal(sessionGroupSummary(split(1, 0, 0, []), true), "1 snoozed session");
});

test("attention words name only the nonzero counts", () => {
  assert.equal(sessionGroupAttentionWords({ blockedCount: 2, stalledCount: 1 }), "2 Blocked, 1 Stalled");
  assert.equal(sessionGroupAttentionWords({ blockedCount: 0, stalledCount: 1 }), "1 Stalled");
  assert.equal(sessionGroupAttentionWords({ blockedCount: 0, stalledCount: 0 }), "");
});
