import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExecutionTargetRef, GithubIssueClosureSnapshot } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

const sessionId = "s_issue_closure";
const issue = 123;
const connection = () => ({ nodes: [], pageInfo: { hasNextPage: false } });
type CloseMode = "closed" | "lost_receipt" | "still_open";
type Command = { file: string; args: string[]; cwd: string | undefined; persistedAttempts?: Record<string, string> };

function fixture(t: TestContext, mode: CloseMode = "closed") {
  const root = mkdtempSync(join(tmpdir(), "wollipog-issue-closure-recovery-"));
  const repository = { nameWithOwner: "example/project", issue: {
    id: "issue-id", number: issue, title: "Obsolete task", body: "Original description",
    url: `https://github.com/example/project/issues/${issue}`, state: "OPEN", updatedAt: "2026-10-01T10:00:00Z",
    labels: connection(), assignees: connection(), timelineItems: connection(),
  }, pullRequests: connection() };
  let store = new SessionStore(join(root, "sessions"));
  store.create({
    sessionId, agentId: "claude", workspaceId: "repo", repoPath: root, worktreePath: null,
    driver: "claude-code", command: "claude", args: [], env: {}, context: { kind: "native" },
    agentSessionId: null, status: "idle", title: "Issue closure", config: {},
    orchestrator: { strictProjectIsolation: true, issueNumbers: [issue] },
    tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
    seq: 0, createdAt: 1000, updatedAt: 1000,
  });
  let manager = new SessionManager(() => {}, () => {}, store, "test-runner");
  const commands: Command[] = [];
  const diskMeta = () => JSON.parse(readFileSync(join(store.sessionPath(sessionId), "meta.json"), "utf8")) as SessionMeta;

  // Only the OS command transport is replaced. The manager, context-command path, GitHub
  // inspection/digest checks, and durable SessionStore writes all run unchanged.
  const execFile = ((file: string, args: string[], options: ExecFileOptions,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
    const command: Command = { file, args: [...args], cwd: options.cwd?.toString() };
    commands.push(command);
    let stdout = "";
    let error: ExecFileException | null = null;
    if (file === "git" && args.join(" ") === "remote get-url origin") {
      stdout = "git@github.com:example/project.git";
    } else if (file === "gh" && args[0] === "api" && args[1] === "graphql") {
      stdout = JSON.stringify({ data: { repository } });
    } else if (file === "gh" && args[0] === "issue" && args[1] === "close") {
      // Observe disk at the mutation boundary, before either success or failure is returned.
      // A store cache or a patch after the command cannot satisfy this observation.
      command.persistedAttempts = diskMeta().githubIssueClosureAttempts;
      if (mode === "closed") repository.issue.state = "CLOSED";
      if (mode === "lost_receipt") error = Object.assign(new Error("Connection lost after posting the comment"), { cmd: "gh issue close" });
    } else {
      error = Object.assign(new Error(`Unexpected fixture command: ${file}`), { cmd: file });
    }
    queueMicrotask(() => callback(error, stdout, ""));
    return { stdin: null } as ChildProcess;
  }) as typeof childProcess.execFile;
  t.mock.method(childProcess, "execFile", execFile);
  syncBuiltinESMExports();
  t.after(() => {
    manager.shutdownAll();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });

  const inspect = () => manager.githubIssueClosure({
    type: "github_issue_closure", operation: "inspect", requestId: "inspect", sessionId, issue,
  });
  const execute = (snapshot: GithubIssueClosureSnapshot, occurrenceId = "approved-once") => manager.githubIssueClosure({
    type: "github_issue_closure", operation: "execute", requestId: "execute", sessionId, occurrenceId, snapshot,
  });
  const snapshot = async (): Promise<GithubIssueClosureSnapshot> => {
    const inspected = await inspect();
    assert.equal(inspected.ok, true, inspected.error ?? "Expected a successful runner response");
    assert.ok(inspected.inspection);
    const { state: _state, ...evidence } = inspected.inspection;
    return { ...evidence, category: "issue_closure", reason: "not_planned", explanation: "Retire obsolete work.",
      evidence: ["Superseded by the new design."], comment: "Approved retirement. `literal` $(literal)", activeChildren: [] };
  };
  const restart = () => {
    manager.shutdownAll();
    // New instances have no previous in-memory metadata or occurrence state.
    store = new SessionStore(join(root, "sessions"));
    manager = new SessionManager(() => {}, () => {}, store, "test-runner");
    return store;
  };
  return { root, repository, commands, inspect, execute, snapshot, restart, diskMeta, scope: (message: Omit<Extract<import("@wollipog/protocol").CampaignIssueScopeMessage, {operation:"synchronize"}>, "sessionId" | "requestId" | "type">) => manager.campaignIssueScope({ type: "campaign_issue_scope", requestId: "scope", sessionId, ...message } as import("@wollipog/protocol").CampaignIssueScopeMessage),
    store: () => store, mutations: () => commands.filter((command) => command.file === "gh" && command.args[0] === "issue") };
}

const digest = (snapshot: GithubIssueClosureSnapshot) => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

for (const mode of ["closed", "lost_receipt", "still_open"] as const) {
  test(`runner persists the closure attempt before ${mode} and refuses replay after recreation`, async (t) => {
    const f = fixture(t, mode);
    const snapshot = await f.snapshot();
    const first = await f.execute(snapshot);
    assert.equal(first.ok, true, first.error ?? "Expected a successful runner response");
    assert.equal(first.result?.outcome, mode === "closed" ? "closed" : "uncertain");
    assert.equal(f.mutations().length, 1);
    const expectedAttempts = { "approved-once": digest(snapshot) };
    assert.deepEqual(f.mutations()[0]?.persistedAttempts, expectedAttempts);
    assert.deepEqual(f.mutations()[0]?.args, ["issue", "close", snapshot.url, "--reason", "not planned", "--comment", snapshot.comment!]);
    assert.equal(f.mutations()[0]?.cwd, f.root);

    // Restore the original open evidence to ensure neither the already-closed shortcut nor
    // a stale forge digest can mask a missing durable replay guard.
    f.repository.issue.state = "OPEN";
    const restartedStore = f.restart();
    assert.deepEqual(restartedStore.readMeta(sessionId)?.githubIssueClosureAttempts, expectedAttempts);
    const inspected = await f.inspect();
    assert.equal(inspected.inspection?.forgeDigest, snapshot.forgeDigest);
    const replay = await f.execute(snapshot);
    assert.equal(replay.ok, true, replay.error ?? "Expected a successful runner response");
    assert.equal(replay.result?.outcome, "refused");
    assert.equal(f.mutations().length, 1, "neither the close nor its comment can be replayed");
    assert.deepEqual(f.diskMeta().githubIssueClosureAttempts, expectedAttempts);
  });
}

test("a new approved occurrence remains executable after runner recreation", async (t) => {
  const f = fixture(t);
  const snapshot = await f.snapshot();
  assert.equal((await f.execute(snapshot)).result?.outcome, "closed");
  f.repository.issue.state = "OPEN";
  f.restart();
  assert.equal((await f.execute(snapshot, "approved-new")).result?.outcome, "closed");
  assert.equal(f.mutations().length, 2);
  assert.deepEqual(f.mutations()[1]?.persistedAttempts, {
    "approved-once": digest(snapshot), "approved-new": digest(snapshot),
  });
});

test("an already-closed issue never posts a comment or records a mutation attempt, including after recreation", async (t) => {
  const f = fixture(t);
  const snapshot = await f.snapshot();
  f.repository.issue.state = "CLOSED";
  assert.equal((await f.execute(snapshot)).result?.outcome, "already_closed");
  f.restart();
  assert.equal((await f.execute(snapshot)).result?.outcome, "already_closed");
  assert.equal(f.mutations().length, 0);
  assert.equal(f.diskMeta().githubIssueClosureAttempts, undefined);
});

function target(kind: ExecutionTargetRef["kind"]): ExecutionTargetRef {
  return { id: `target-${kind}`, runnerId: "test-runner", kind, workspaceStrategy: "in_place",
    adapter: kind === "cloud" ? "cloud" : kind === "container" ? "container" : "host",
    boundaries: { filesystem: "host", network: "inherit", secrets: "none", billing: "none" } };
}

const refusedSessions: Array<{ name: string; patch: Partial<SessionMeta>; error: string }> = [
  { name: "non-Orchestrator", patch: { orchestrator: undefined }, error: "runner-local Orchestrator" },
  { name: "missing repository", patch: { repoPath: "" }, error: "runner-local Orchestrator" },
  { name: "issue outside campaign scope", patch: { orchestrator: { strictProjectIsolation: true, issueNumbers: [456] } }, error: "outside the human-authorized campaign scope" },
  { name: "missing campaign scope", patch: { orchestrator: { strictProjectIsolation: true } }, error: "outside the human-authorized campaign scope" },
  ...(["ssh", "container", "cloud"] as const).map((kind) => ({
    name: `${kind} execution target`, patch: { executionTarget: target(kind) }, error: "runner-local Orchestrator",
  })),
];

for (const { name, patch, error } of refusedSessions) {
  test(`runner refuses inspection and execution for ${name} before invoking commands`, async (t) => {
    const f = fixture(t);
    const snapshot = await f.snapshot();
    f.store().patchMeta(sessionId, patch);
    f.restart();
    f.commands.length = 0;
    for (const operation of ["inspect", "execute"] as const) {
      const result = operation === "inspect" ? await f.inspect() : await f.execute(snapshot);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", new RegExp(error));
      assert.equal(f.commands.length, 0, `${operation} must refuse before external inspection or mutation`);
      assert.equal(f.diskMeta().githubIssueClosureAttempts, undefined);
    }
  });
}

test("an explicitly local target can inspect and execute a scoped closure", async (t) => {
  const f = fixture(t);
  f.store().patchMeta(sessionId, { executionTarget: target("local") });
  f.restart();
  const snapshot = await f.snapshot();
  const result = await f.execute(snapshot);
  assert.equal(result.ok, true, result.error ?? "Expected a successful runner response");
  assert.equal(result.result?.outcome, "closed");
  assert.equal(f.mutations().length, 1);
});


test("runner scope synchronization persists across recreation and refuses stale revisions and repositories", async (t) => {
  const f=fixture(t);
  const original = await f.snapshot();
  const scope = { repository: "example/project", issueNumbers: [123,124], revision: 1, authorizedByUserId: "human", authorizedAt: Date.now() };
  const applied=await f.scope({operation:"synchronize",scope});
  assert.equal(applied.ok,true,applied.error ?? "Expected synchronization");
  assert.deepEqual(f.diskMeta().orchestrator!.issueScope,scope);
  f.restart();
  assert.deepEqual(f.store().readMeta(sessionId)!.orchestrator!.issueNumbers,[123,124]);
  assert.equal((await f.execute(original)).ok,false,"old closure without scope revision cannot execute");
  assert.equal((await f.execute({...original,scopeRevision:1,repository:"other/project"})).ok,false,"repository is authority-bound");
  const removed={...scope,issueNumbers:[124],revision:2};
  assert.equal((await f.scope({operation:"synchronize",scope:removed})).ok,true);
  assert.equal((await f.scope({operation:"synchronize",scope})).ok,false);
  assert.equal((await f.scope({operation:"synchronize",scope:{...removed,issueNumbers:[123]}})).ok,false,"same revision cannot change authority");
  assert.equal((await f.execute({...original,scopeRevision:1})).ok,false);
  assert.equal(f.mutations().length,0);
});
