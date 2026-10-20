import assert from "node:assert/strict";
import test from "node:test";
import type { PodContextEntry, PodMemberRole, PodView, SessionView } from "@wollipog/protocol";
import { podBadgeStatus, podEntrySourceName, podMemberNames, podMemberShortName, podTurnsStopNotice, type PodMemberNameStart } from "./pod-presentation.js";

function session(id: string, title: string, agentName = "Codex"): SessionView {
  return { id, title, agentName, agentId: agentName.toLowerCase(), driver: "claude-code" } as SessionView;
}

function podOf(members: [string, PodMemberRole][]): PodView {
  return {
    id: "pod", title: "Pod", objective: "", status: "active", createdAt: 1, updatedAt: 1,
    members: members.map(([sessionId, role]) => ({ sessionId, role, joinedAt: 1, contextTokenBudget: null, lastContextSeq: 0 })),
  };
}

const sessionMap = (sessions: SessionView[]) => new Map(sessions.map((entry) => [entry.id, entry]));
const key = (name: string) => name.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();

function assertDistinct(names: Map<string, string>, label: string) {
  const keys = [...names.values()].map(key);
  assert.equal(new Set(keys).size, keys.length, `${label}: ${JSON.stringify([...names.values()])}`);
}

test("a member is named by the shortest step no other member shares", () => {
  const sessions = sessionMap([
    session("lead", "Lead: plan the migration", "Claude Code"),
    session("w1", "Worker: migrate call sites"),
    session("w2", "Worker: update the tests"),
    session("w3", "Worker: migrate call sites", "Claude Code"),
    session("rev", "Reviewer: check the sites"),
  ]);
  const pod = podOf([["lead", "lead"], ["w1", "worker"], ["w2", "worker"], ["w3", "worker"], ["rev", "reviewer"]]);
  assert.deepEqual(Object.fromEntries(podMemberNames(pod, sessions, ["lead", "w1", "w2", "w3", "rev"])), {
    lead: "Lead",
    rev: "Reviewer",
    // Shares role and agent with w2, so it takes the task.
    w1: "Worker · Codex: migrate call sites",
    w2: "Worker · Codex: update the tests",
    // Shares the role only; the agent tells it apart.
    w3: "Worker · Claude Code",
  });
});

test("names stay distinct when titles match exactly, after the role prefix, or in case and spacing only", () => {
  for (const [label, first, second] of [
    ["identical titles", "Worker: migrate call sites", "Worker: migrate call sites"],
    ["identical after the role prefix", "Worker: migrate call sites", "migrate call sites"],
    ["case and spacing only", "Worker: Migrate  call sites", "worker - migrate call sites"],
    ["no titles", "", ""],
  ] as const) {
    const sessions = sessionMap([session("lead", "Lead"), session("w1", first), session("w2", second)]);
    const pod = podOf([["lead", "lead"], ["w1", "worker"], ["w2", "worker"]]);
    for (const start of ["role", "agent", "task"] as PodMemberNameStart[]) {
      const names = podMemberNames(pod, sessions, ["lead", "w1", "w2"], start);
      assertDistinct(names, `${label}, from ${start}`);
      assert.match(names.get("w1")!, /\(w1\)$/u, `${label}: the session id is the last resort`);
      assert.match(names.get("w2")!, /\(w2\)$/u);
    }
    // The lead never needed the id.
    assert.equal(podMemberNames(pod, sessions, ["lead", "w1", "w2"]).get("lead"), "Lead");
  }
});

test("former members in Recent Merges are named apart from each other and from current members", () => {
  const sessions = sessionMap([session("w1", "Worker"), session("gone-1", "Worker"), session("gone-2", "Worker")]);
  const pod = podOf([["w1", "worker"]]);
  const names = podMemberNames(pod, sessions, ["w1", "gone-1", "gone-2", "gone-3", "gone-4"]);
  assertDistinct(names, "former members");
  // "Worker" reads like the former members' titles, so the current member takes its agent.
  assert.equal(names.get("w1"), "Worker · Codex");
  assert.equal(names.get("gone-1"), "Worker (gone-1)");
  assert.equal(names.get("gone-3"), "A former member (gone-3)");
});

test("every combination of roles, agents and titles yields distinct names", () => {
  const roles: PodMemberRole[] = ["lead", "worker", "reviewer"];
  const agents = ["Codex", "Claude Code"];
  const titles = ["", "Worker: task", "task", "Task", "Lead: task"];
  let cases = 0;
  for (let mask = 0; mask < 3 ** 4; mask += 1) {
    const members: [string, PodMemberRole][] = [];
    const sessions: SessionView[] = [];
    for (let index = 0; index < 4; index += 1) {
      const pick = Math.floor(mask / 3 ** index) % 3;
      const id = `m${index}`;
      members.push([id, roles[pick]!]);
      sessions.push(session(id, titles[(mask + index) % titles.length]!, agents[(pick + index) % agents.length]));
    }
    const pod = podOf(members);
    for (const start of ["role", "agent", "task"] as PodMemberNameStart[]) {
      assertDistinct(podMemberNames(pod, sessionMap(sessions), members.map(([id]) => id), start), `case ${mask} from ${start}`);
      cases += 1;
    }
  }
  assert.equal(cases, 243);
});

test("podMemberShortName names one member among the pod's members", () => {
  const sessions = sessionMap([session("w1", "Worker: a"), session("w2", "Worker: a")]);
  const pod = podOf([["w1", "worker"], ["w2", "worker"]]);
  assert.equal(podMemberShortName(pod, sessions, "w1"), "Worker · Codex: a (w1)");
});

test("turns that stop for a reason say why; a person's own Stop says nothing", () => {
  const state = (stopReason: string, status: "stopped" | "paused" = "stopped") => ({ status, stopReason, turnsUsed: 1, updatedAt: 1 });
  assert.equal(podTurnsStopNotice(state("max_turns"))?.sentence, "Automatic turns stopped: the turn limit was reached.");
  assert.match(podTurnsStopNotice(state("repeated_output:abc"))!.sentence, /same answer/u);
  assert.equal(podTurnsStopNotice(state("stopped_by_human")), null);
  assert.equal(podTurnsStopNotice(state("pod_closed")), null);
  assert.deepEqual(podTurnsStopNotice(state("runner went away")), { sentence: "Automatic turns stopped.", details: "runner went away" });
  assert.equal(podTurnsStopNotice({ status: "running", turnsUsed: 1, updatedAt: 1 }), null);
});

test("a pod's one badge reads Closed, Running while any turn runs, or Active (#2981)", () => {
  const pod = podOf([["lead", "lead"], ["worker", "worker"]]);
  const idle = sessionMap([session("lead", "Lead"), session("worker", "Worker")].map((entry) => ({ ...entry, status: "idle" as const })));
  assert.equal(podBadgeStatus(pod, idle), "active");
  for (const status of ["running", "starting"] as const) {
    const busy = new Map(idle);
    busy.set("worker", { ...idle.get("worker")!, status });
    assert.equal(podBadgeStatus(pod, busy), "running", status);
  }
  const turns: PodView = { ...pod, orchestration: {
    policy: { mode: "round_robin", contextTokenBudget: 1, summaryTokenBudget: 1, maxTurns: 2, maxRepeatedOutputs: 1 },
    state: { status: "running", turnsUsed: 1, updatedAt: 1 },
  } };
  assert.equal(podBadgeStatus(turns, idle), "running");
  assert.equal(podBadgeStatus({ ...turns, status: "closed" }, idle), "closed");
});

test("a huddle entry names its member by role and agent, a former member by agent, and a person as given (#2981)", () => {
  const pod = podOf([["lead", "lead"], ["w1", "worker"], ["w2", "worker"]]);
  const sessions = sessionMap([session("lead", "Lead: plan"), session("w1", "Worker: a"), session("w2", "Worker: b", "Claude Code")]);
  const entry = (source: PodContextEntry["source"]): PodContextEntry => ({ id: "e", podId: "pod", seq: 1, ts: 1, source, content: "x" });
  const fromSession = (sessionId: string, agentLabel = "Codex") =>
    entry({ kind: "session", sessionId, sessionTitle: "Worker: gone", agentLabel, fromSeq: 1, toSeq: 2 });
  assert.equal(podEntrySourceName(fromSession("lead"), pod, sessions, "You"), "Lead · Codex");
  assert.equal(podEntrySourceName(fromSession("w1"), pod, sessions, "You"), "Worker · Codex");
  assert.equal(podEntrySourceName(fromSession("w2"), pod, sessions, "You"), "Worker · Claude Code");
  assert.equal(podEntrySourceName(fromSession("gone", "OpenCode"), pod, sessions, "You"), "OpenCode");
  assert.equal(podEntrySourceName(fromSession("gone", " "), pod, sessions, "You"), "Worker: gone");
  assert.equal(podEntrySourceName(entry({ kind: "human", actorId: "local" }), pod, sessions, "You"), "You");
});
