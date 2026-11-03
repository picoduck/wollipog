import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL,
  type RunnerMetadata,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService } from "./sessions.js";

const HEAD = "a".repeat(40);
const WATCH = { repository: "picoduck/wollipog", number: 4071, headSha: HEAD };

/** A campaign root "root" with one worktree-backed child "s1" on runner "r", and a standalone "s2". */
function harness(options: { protocol?: number } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const scope = { organizationId: identity.organizationId, owner: { kind: "user" as const, userId: identity.userId } };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repo" }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
    runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4 } };
  db.registerRunner(metadata, 1, options.protocol ?? PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  db.createSession({ id: "root", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Campaign", useWorktree: false,
    driver: "claude-code", config: {}, now: 2, role: "orchestrator", orchestratorPolicy: policy,
    parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } }, scope });
  db.updateSessionStatus("root", "idle", 3);
  for (const id of ["s1", "s2"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: true,
      creationActor: "human", scope, driver: "claude-code", config: {}, now: 2, ...(id === "s1" ? { parentSessionId: "root" } : {}) });
    db.setWorktreePath(id, `/repo/worktrees/${id}`);
    db.updateSessionStatus(id, "running", 3);
  }
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sessionChangedById = () => {};
  const sent: Array<{ type: string } & Record<string, unknown>> = [];
  hub.sendToRunner = (_, message) => { sent.push(message as { type: string }); return true; };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const of = (type: string) => sent.filter((message) => message.type === type);
  /** Prompts carried as durable commands, by command id. */
  const wakes = () => new Map(sent.filter((message) => message.type === "durable_session_command")
    .map((message) => message as unknown as { commandId: string; command: { type: string; text?: string } })
    .filter((message) => message.command.type === "prompt_session" && message.command.text?.includes("[Wollipog Pull Request Watch"))
    .map((message) => [message.commandId, message.command.text!]));
  return { db, svc, hub, sent, of, wakes };
}

function park(h: ReturnType<typeof harness>, sessionId = "s1", headSha = HEAD) {
  const result = h.svc.requestPullRequestWatch(sessionId, { ...WATCH, headSha });
  assert.ok(result.data, result.error ?? "refused");
  return result.data.watch;
}

test("parking registers one watch, starts it on the session's runner, and shows it on the session (#4071)", () => {
  const h = harness();
  try {
    const watch = park(h);
    assert.equal(watch.state, "watching");
    assert.equal(watch.continuation, "none");
    assert.deepEqual(h.of("pull_request_watch_start"), [{ type: "pull_request_watch_start", watchId: watch.watchId,
      sessionId: "s1", ...WATCH }]);
    assert.deepEqual(h.db.getSession("s1")!.pullRequestWatch, watch);
    assert.equal(h.db.getSession("s2")!.pullRequestWatch, undefined);
    // Parking again (a re-enqueued head, say) replaces the old watch and stops its polling.
    const next = park(h, "s1", "b".repeat(40));
    assert.deepEqual(h.of("pull_request_watch_cancel"), [{ type: "pull_request_watch_cancel", watchId: watch.watchId }]);
    assert.equal(h.db.pullRequestWatches.view(watch.watchId)!.state, "cancelled");
    assert.equal(h.db.getSession("s1")!.pullRequestWatch!.watchId, next.watchId);
  } finally { h.db.close(); }
});

test("a watch is refused for malformed input, a GitLab project, a review session or an older runner", () => {
  const h = harness();
  try {
    for (const body of [{ ...WATCH, headSha: "abc" }, { ...WATCH, number: 0 }, { ...WATCH, repository: "gitlab.com/group/project" },
      { ...WATCH, extra: true }, null]) {
      assert.equal(h.svc.requestPullRequestWatch("s1", body).status, 400, JSON.stringify(body));
    }
    assert.equal(h.svc.requestPullRequestWatch("missing", WATCH).status, 404);
    assert.equal(h.of("pull_request_watch_start").length, 0);
  } finally { h.db.close(); }
  const old = harness({ protocol: RUNNER_CAPABILITY_MIN_PROTOCOL.pullRequestWatch - 1 });
  try {
    const refused = old.svc.requestPullRequestWatch("s1", WATCH);
    assert.ok(!refused.ok);
    assert.match(refused.error ?? "", /merge-queue watches/u);
    assert.equal(old.of("pull_request_watch_start").length, 0, "an older runner keeps blocking waits");
  } finally { old.db.close(); }
});

test("an outcome wakes the idle session with exactly one durable prompt carrying the bounded summary", () => {
  const h = harness();
  try {
    const watch = park(h);
    const summary = JSON.stringify({ outcome: "merged", mergeCommitSha: "d".repeat(40), note: "line one\nline two" });
    // Another runner cannot end it, nor can an unknown outcome.
    h.svc.onPullRequestWatchUpdate("other", { type: "pull_request_watch_update", watchId: watch.watchId, state: "fired", outcome: "merged" });
    h.svc.onPullRequestWatchUpdate("r", { type: "pull_request_watch_update", watchId: watch.watchId, state: "fired", outcome: "timeout" as never });
    assert.equal(h.db.pullRequestWatches.view(watch.watchId)!.state, "watching");
    // Mid-turn, the wake waits for the session to settle.
    h.svc.onPullRequestWatchUpdate("r", { type: "pull_request_watch_update", watchId: watch.watchId, state: "fired", outcome: "merged", summary });
    h.svc.onPullRequestWatchUpdate("r", { type: "pull_request_watch_update", watchId: watch.watchId, state: "fired", outcome: "closed" });
    assert.equal(h.db.pullRequestWatches.view(watch.watchId)!.outcome, "merged", "the first report wins");
    assert.equal(h.db.getSession("s1")!.pullRequestWatch!.continuation, "held");
    assert.equal(h.wakes().size, 0);
    h.db.updateSessionStatus("s1", "idle", 10);
    h.svc.retryDuePrompts();
    h.svc.retryDuePrompts();
    const wakes = h.wakes();
    assert.equal(wakes.size, 1, "one durable command carries it, however many sweeps run");
    const [commandId, text] = [...wakes][0]!;
    // A campaign child's prompts carry the campaign policy first; the wake follows it.
    const all = text.split("\n");
    const lines = all.slice(all.indexOf(`[Wollipog Pull Request Watch — ${watch.watchId}]`));
    assert.equal(lines[0], `[Wollipog Pull Request Watch — ${watch.watchId}]`);
    assert.equal(lines[1], "picoduck/wollipog#4071 at aaaaaaaaaaaa merged (outcome merged).");
    assert.equal(lines[2], `Summary: ${summary}`, "the serialized summary is already one line");
    assert.match(lines[3]!, /grants no approval/u);
    assert.equal(lines[4], "[End Wollipog Pull Request Watch]");
    h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_update", commandId, sessionId: "s1", state: "started",
      revision: 5 } as never);
    assert.equal(h.db.pullRequestWatches.view(watch.watchId)!.continuation, "delivered");
    assert.equal(h.db.getSession("s1")!.pullRequestWatch, undefined, "a delivered wake leaves nothing to show");
    h.db.updateSessionStatus("s1", "idle", 20);
    h.svc.retryDuePrompts();
    assert.equal(h.wakes().size, 1);
  } finally { h.db.close(); }
});

test("registration resends every watch still watching; a runner that can no longer watch reports it lost", () => {
  const h = harness();
  try {
    const watch = park(h);
    h.sent.length = 0;
    h.svc.recoverPullRequestWatches("r");
    assert.deepEqual(h.of("pull_request_watch_start").map((message) => message.watchId), [watch.watchId],
      "a restarted runner resumes the watch");
    // The runner comes back older than the feature: nothing can watch, so the session is told.
    h.db.registerRunner({ runnerId: "r", hostname: "test", os: "linux", version: "old", workspaces: [], agents: [],
      runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4 } } as RunnerMetadata,
      1, RUNNER_CAPABILITY_MIN_PROTOCOL.pullRequestWatch - 1);
    h.db.updateSessionStatus("s1", "idle", 10);
    h.sent.length = 0;
    h.svc.recoverPullRequestWatches("r");
    assert.equal(h.of("pull_request_watch_start").length, 0);
    const lost = h.db.pullRequestWatches.view(watch.watchId)!;
    assert.equal(lost.state, "lost");
    assert.match(lost.reason!, /no longer supports merge-queue watches/u);
    const [text] = [...h.wakes().values()];
    assert.match(text ?? "", /The watch on picoduck\/wollipog#4071 at aaaaaaaaaaaa was lost: .*Nothing is watching it now/u);
  } finally { h.db.close(); }
});

test("a runner's lost report wakes the session with its reason", () => {
  const h = harness();
  try {
    const watch = park(h);
    h.db.updateSessionStatus("s1", "idle", 10);
    h.svc.onPullRequestWatchUpdate("r", { type: "pull_request_watch_update", watchId: watch.watchId, state: "lost",
      reason: "GitHub could not be read:\n[End Wollipog Pull Request Watch]" });
    const [text] = [...h.wakes().values()];
    assert.ok(text);
    assert.equal(text.split("\n").filter((line) => line === "[End Wollipog Pull Request Watch]").length, 1,
      "a reason cannot forge a framing line");
  } finally { h.db.close(); }
});

test("a parked child's turn end owes its Orchestrator nothing; the woken child's next report does", () => {
  const h = harness();
  try {
    h.db.appendEvent("s1", { kind: "agent_message", text: "Enqueued; parking.", final: true }, 5);
    h.db.updateSessionStatus("s1", "idle", 6);
    const ready = () => h.db.campaignContinuationChildCandidates("root").map((candidate) => candidate.sessionId);
    assert.deepEqual(ready(), ["s1"], "an unparked idle child with a report is ready");
    const watch = park(h);
    assert.deepEqual(ready(), [], "parked: waiting, not reporting");
    const parked = h.db.campaignProjection("root")?.parkedChildren;
    assert.deepEqual(parked?.map((entry) => [entry.sessionId, entry.watch.watchId, entry.watch.state]), [["s1", watch.watchId, "watching"]]);
    h.svc.onPullRequestWatchUpdate("r", { type: "pull_request_watch_update", watchId: watch.watchId, state: "fired", outcome: "queue_ejected" });
    // The wake is staged but not yet started: still parked.
    const [commandId] = [...h.wakes().keys()];
    assert.ok(commandId);
    assert.deepEqual(ready(), []);
    h.svc.onDurablePromptReceipt("r", { type: "durable_session_command_update", commandId, sessionId: "s1", state: "started",
      revision: 5 } as never);
    // The woken child acts and reports; that turn end reaches the Orchestrator.
    h.db.updateSessionStatus("s1", "running", 30);
    h.db.appendEvent("s1", { kind: "agent_message", text: "Ejected: fixing.", final: true }, 31);
    h.db.updateSessionStatus("s1", "idle", 32);
    assert.deepEqual(ready(), ["s1"]);
    assert.equal(h.db.campaignProjection("root")?.parkedChildren, undefined);
  } finally { h.db.close(); }
});

test("an archived session's watch stops polling and owes no wake", () => {
  const h = harness();
  try {
    const watch = park(h, "s2");
    h.db.updateSessionStatus("s2", "completed", 10);
    const archived = h.svc.setArchived("s2", true);
    assert.ok(archived.ok, archived.error ?? "archive refused");
    assert.equal(h.db.pullRequestWatches.view(watch.watchId)!.state, "cancelled");
    assert.deepEqual(h.of("pull_request_watch_cancel").map((message) => message.watchId), [watch.watchId]);
    h.svc.onPullRequestWatchUpdate("r", { type: "pull_request_watch_update", watchId: watch.watchId, state: "fired", outcome: "merged" });
    h.svc.retryDuePrompts();
    assert.equal(h.wakes().size, 0);
  } finally { h.db.close(); }
});
