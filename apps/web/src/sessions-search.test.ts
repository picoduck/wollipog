import assert from "node:assert/strict";
import test from "node:test";
import type { SessionView } from "@wollipog/protocol";
import type { InboxSplit } from "./inbox.js";
import {
  normalizeSessionsQuery,
  searchInboxSplits,
  sessionMatchesQuery,
  sessionsNoMatchesMessage,
} from "./sessions-search.js";

function session(id: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id,
    title: "Managed Session",
    preview: null,
    agentId: "codex",
    agentName: "Codex",
    driver: "codex-app-server",
    status: "idle",
    pendingApproval: null,
    ...overrides,
  } as SessionView;
}

function split(key: string | null, sessions: SessionView[], count = sessions.length): InboxSplit {
  return {
    key,
    kind: key === null ? "all" : "project",
    name: key ?? "All",
    project: null,
    sessions,
    count,
    blockedCount: 99,
    stalledCount: 99,
  };
}

test("a query is matched trimmed and lowercased", () => {
  assert.equal(normalizeSessionsQuery("  Terraform "), "terraform");
  assert.equal(normalizeSessionsQuery("   "), "");
});

test("search matches the title, latest message, agent and project", () => {
  assert.equal(sessionMatchesQuery(session("a", { title: "Plan Terraform" }), "terraform", "Docs"), true);
  assert.equal(sessionMatchesQuery(session("a", { preview: "ran terraform apply" }), "terraform", "Docs"), true);
  assert.equal(sessionMatchesQuery(session("a"), "app server", "Docs"), true, "the canonical transport label");
  assert.equal(sessionMatchesQuery(session("a"), "codex", "Docs"), true);
  assert.equal(sessionMatchesQuery(session("a"), "infra", "Infra Repo"), true);
  assert.equal(sessionMatchesQuery(session("a"), "terraform", "Docs"), false);
  assert.equal(sessionMatchesQuery(session("a"), "", "Docs"), true, "no query matches everything");
});

test("group counts follow the matches, badges included, and a group without any reads 0", () => {
  const blocked = session("blocked", { title: "terraform plan", status: "input_required" });
  const stalled = session("stalled", { title: "terraform apply" });
  const other = session("other", { title: "docs" });
  const splits = [split(null, [blocked, stalled, other], 40), split("infra", [blocked, stalled]), split("docs", [other])];
  const searched = searchInboxSplits(splits, "terraform", () => "Project", new Set(["stalled"]));
  assert.deepEqual(searched.map((group) => [group.key, group.count, group.blockedCount, group.stalledCount]), [
    [null, 2, 1, 1],
    ["infra", 2, 1, 1],
    ["docs", 0, 0, 0],
  ]);
  assert.deepEqual(searched[0]!.sessions.map((match) => match.id), ["blocked", "stalled"]);
});

test("clearing the query restores the groups and their totals unchanged", () => {
  const splits = [split(null, [session("a")], 40)];
  assert.equal(searchInboxSplits(splits, "", () => "Project", new Set()), splits);
});

test("the No Matches sentence names the query and the group, and All as every group", () => {
  assert.equal(
    sessionsNoMatchesMessage(" terraform ", { kind: "project", name: "Docs Site" }),
    "No sessions match “terraform” in Docs Site.",
  );
  assert.equal(sessionsNoMatchesMessage("terraform", { kind: "all", name: "All" }), "No sessions match “terraform” in any group.");
});
