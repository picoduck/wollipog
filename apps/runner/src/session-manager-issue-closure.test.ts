import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { CampaignIssueScopeMessage, ExecutionTargetRef, HostExecutionTargetRefusalReason, GithubIssueClosureSnapshot } from "@wollipog/protocol";
import type { GhRunner } from "./campaign-forge-status.js";
import { classifyRoutineClaudeOrchestratorPermission } from "./orchestrator-provider-permissions.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

const sessionId = "s_issue_closure";
const issue = 123;
const connection = () => ({ nodes: [], pageInfo: { hasNextPage: false } });
type CloseMode = "closed" | "lost_receipt" | "still_open";
type Command = { file: string; args: string[]; cwd: string | undefined; persistedAttempts?: Record<string, string> };
type ScopeOperation<T = CampaignIssueScopeMessage> = T extends CampaignIssueScopeMessage
  ? Omit<T, "type" | "requestId" | "sessionId"> : never;

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
  const logs: string[] = [];
  let manager = new SessionManager(() => {}, (line) => { logs.push(line); }, store, "test-runner");
  const commands: Command[] = [];
  let origin = "example/project";
  let beforeNextInspection: (() => void) | undefined;
  let inspectionDelayMs = 0;
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
      stdout = `git@github.com:${origin}.git`;
    } else if (file === "gh" && args[0] === "api" && args.at(-1) === `repos/${origin}/issues/${issue}`) {
      stdout = JSON.stringify({ number: issue, title: repository.issue.title, body: repository.issue.body,
        html_url: repository.issue.url });
    } else if (file === "gh" && args[0] === "api" && args[1] === "graphql") {
      const before = beforeNextInspection;
      beforeNextInspection = undefined;
      before?.();
      stdout = JSON.stringify({ data: { repository } });
      if (inspectionDelayMs) {
        const delay = inspectionDelayMs;
        inspectionDelayMs = 0;
        setTimeout(() => callback(null, stdout, ""), delay);
        return { stdin: null } as ChildProcess;
      }
    } else if (file === "gh" && args[0] === "api" && args.includes("search/issues")) {
      stdout = JSON.stringify({ items: [], total_count: 0, incomplete_results: false });
    } else if (file === "gh" && args[0] === "api" && args.some((arg) => arg.includes("issues?state=all"))) {
      stdout = "[]";
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
    manager = new SessionManager(() => {}, (line) => { logs.push(line); }, store, "test-runner");
    return store;
  };
  return { root, repository, commands, logs, inspect, execute, snapshot, restart, diskMeta, scope: (message: ScopeOperation) => manager.campaignIssueScope({ type: "campaign_issue_scope", requestId: "scope", sessionId, ...message }),
    setOrigin: (value: string) => { origin=value; },
    beforeNextInspection: (callback: () => void) => { beforeNextInspection=callback; },
    delayNextInspection: (ms: number) => { inspectionDelayMs=ms; },
    manager: () => manager, store: () => store, mutations: () => commands.filter((command) => command.file === "gh" && command.args[0] === "issue") };
}

const digest = (snapshot: GithubIssueClosureSnapshot) => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

for (const mode of ["commit", "scope_changed", "timeout"] as const) {
  test(`#4403 a root's fresh campaign PR inspection waits for ${mode} at its durable fence`, async (t) => {
    const f = fixture(t);
    const approved = { ...await f.snapshot(), campaignPullRequests: [] };
    const prepared = await f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "execute", requestId: "prepare",
      sessionId, occurrenceId: "root-prepared", snapshot: approved, prepare: true, campaignPullRequests: [77] },
    { locationCommitWaitMs: mode === "timeout" ? 1 : 1000 });
    assert.equal(prepared.prepared, true, prepared.error ?? mode);
    assert.equal(f.mutations().length, 0);
    assert.equal(f.diskMeta().githubIssueClosureAttempts, undefined);
    if (mode === "scope_changed") f.store().patchMeta(sessionId, { orchestrator: { ...f.diskMeta().orchestrator!, issueNumbers: [] } });
    if (mode === "timeout") await new Promise((resolve) => setTimeout(resolve, 10));
    const other = await f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "commit", requestId: "wrong-session",
      sessionId: "another-session", occurrenceId: "root-prepared" });
    assert.equal(other.ok, false, "another session cannot commit this preparation");
    const result = await f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "commit", requestId: "commit",
      sessionId, occurrenceId: "root-prepared" });
    assert.equal(f.mutations().length, mode === "commit" ? 1 : 0);
    assert.equal(result.result?.outcome, mode === "commit" ? "closed" : mode === "scope_changed" ? "refused" : undefined);
    if (mode === "timeout") assert.equal(result.ok, false);
    assert.deepEqual(f.diskMeta().githubIssueClosureAttempts, mode === "commit" ? { "root-prepared": digest(approved) } : undefined);
    assert.equal((await f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "commit", requestId: "replay",
      sessionId, occurrenceId: "root-prepared" })).ok, false);
    assert.equal(f.mutations().length, mode === "commit" ? 1 : 0, "no repeat comment or close");
  });
}

test("#4403 filtered root closures refuse inline execution or missing execution context", async (t) => {
  const f = fixture(t);
  const approved = { ...await f.snapshot(), campaignPullRequests: [] };
  for (const prepare of [undefined, true] as const) {
    const result = await f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "execute", requestId: "incomplete",
      sessionId, occurrenceId: "missing-context", snapshot: approved, ...(prepare ? { prepare } : {}) });
    assert.equal(result.ok, false);
    assert.match(result.error!, /fresh campaign PR context/u);
    assert.equal(f.mutations().length, 0);
  }
});

test("4398 read-only reconciliation reaches the forge after the issue leaves current scope", async (t) => {
  const f = fixture(t);
  const approved = await f.snapshot();
  f.store().patchMeta(sessionId, { orchestrator: { ...f.diskMeta().orchestrator!, issueNumbers: [],
    issueScope: { repository: approved.repository, issueNumbers: [], revision: 2, authorizedByUserId: "owner", authorizedAt: 1 } } });
  const before = f.commands.length;
  const read = await f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "reconcile", sessionId,
    requestId: "recovery", occurrenceId: "consumed", snapshot: { ...approved, scopeRevision: 1 }, consumedAt: 1 });
  assert.equal(read.ok, true, read.error ?? "recovery read refused");
  assert.equal(read.reconciled, false, "fixture is still open, so no success is invented");
  assert.ok(f.commands.slice(before).some(c => c.file === "gh" && c.args[1] === "graphql"));
  assert.equal(f.mutations().length, 0);
});

for (const change of ["unchanged", "custom", "revision", "operation", "reason", "launch"] as const) {
  test(`bounded closure rechecks ${change} authority after forge inspection at its mutation fence`, async (t) => {
    const f = fixture(t);
    const original = await f.snapshot();
    const scope = { repository: "example/project", issueNumbers: [issue], revision: 1,
      authorizedByUserId: "owner", authorizedAt: 1000 };
    const control: import("@wollipog/protocol").CampaignControl = { mode: "full_control", boundary: {
      version: 1, revision: 2, issueScopeRevision: 1, repository: scope.repository, objective: "Retire scoped work",
      authorizedByUserId: "owner", authorizedAt: 2000, operations: ["issue_closure"], delegatablePolicyIds: [],
      issueAuthority: { epics: [], relatedFollowUps: false, maxIssues: 1, closureReasons: ["not_planned"] },
    } };
    assert.equal((await f.scope({ operation: "synchronize", scope, control })).ok, true);
    f.store().patchMeta(sessionId, { controlPlaneLaunchId: "original-launch" });
    const snapshot: GithubIssueClosureSnapshot = { ...original, scopeRevision: 1,
      issueAdmission: { boundaryRevision: 2, evidenceDigest: "a".repeat(64) } };
    f.beforeNextInspection(() => {
      const updated = structuredClone(control);
      if (change === "revision") updated.boundary.revision++;
      if (change === "operation") updated.boundary.operations = [];
      if (change === "reason") updated.boundary.issueAuthority!.closureReasons = ["completed"];
      f.store().patchMeta(sessionId, {
        orchestrator: { ...f.diskMeta().orchestrator!, control: change === "custom" ? { mode: "custom" } : updated },
        ...(change === "launch" ? { controlPlaneLaunchId: "replacement-launch" } : {}),
      });
    });
    const result = await f.execute(snapshot);
    assert.equal(result.ok, true, result.error ?? "Expected an inspected refusal");
    assert.equal(result.result?.outcome, change === "unchanged" ? "closed" : "refused");
    assert.equal(result.result?.refusal?.reason, change === "unchanged" ? undefined : "mutation_fence_unavailable");
    assert.equal(f.mutations().length, change === "unchanged" ? 1 : 0);
    assert.deepEqual(f.diskMeta().githubIssueClosureAttempts,
      change === "unchanged" ? { "approved-once": digest(snapshot) } : undefined);
    const refusal = f.logs.find((line) => line.includes('"campaign_issue_closure_authority_changed"'));
    assert.deepEqual(refusal === undefined ? undefined : JSON.parse(refusal), change === "unchanged" ? undefined : {
      event: "campaign_issue_closure_authority_changed", entryPoint: "closure_mutation_fence",
      requestId: "execute", sessionId, occurrenceId: "approved-once", boundaryRevision: 2,
      scopeRevision: 1, outcome: "refused",
    });
  });
}

test("a closure at a Location runs in that path on this runner with no session of its own, and fences one durable attempt (#4119)", async (t) => {
  const f = fixture(t);
  const location = { workspaceId: "api", workspacePath: f.root, repository: "Example/Project" };
  const attempts = join(f.store().rootPath(), ".runner-data", "location-issue-closures");
  const inspect = (at = location) => f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "inspect", requestId: "inspect", sessionId: "s_on_another_runner", issue, location: at });
  const execute = (snapshot: GithubIssueClosureSnapshot, occurrenceId = "approved-once", options: { locationCommitWaitMs?: number } = {}) => f.manager().githubIssueClosure({
    type: "github_issue_closure", operation: "execute", requestId: "execute", sessionId: "s_on_another_runner", occurrenceId, snapshot, location }, options);
  const commit = (occurrenceId = "approved-once") => f.manager().githubIssueClosure({
    type: "github_issue_closure", operation: "commit", requestId: "commit", sessionId: "s_on_another_runner", occurrenceId, location });

  // No Orchestrator session exists here for that id: the control plane holds the campaign's scope.
  const inspected = await inspect();
  assert.equal(inspected.ok, true, inspected.error ?? "Expected an inspection");
  assert.equal(inspected.inspection?.repository, "example/project");
  assert.ok(f.commands.length > 0 && f.commands.every((command) => command.cwd === realpathSync(f.root)), "every command ran in the Location's own path");
  const { state: _state, ...evidence } = inspected.inspection!;
  const snapshot: GithubIssueClosureSnapshot = { ...evidence, category: "issue_closure", reason: "not_planned", explanation: "Retire obsolete work.",
    evidence: ["Superseded."], activeChildren: [] };

  // An origin other than the Location's repository is refused, before and at execution.
  f.setOrigin("example/other");
  const elsewhere = await inspect();
  assert.deepEqual([elsewhere.ok, elsewhere.failure], [false, "repository_changed"]);
  f.setOrigin("example/project");
  const named = await execute({ ...snapshot, repository: "example/other" });
  assert.deepEqual([named.ok, named.failure], [false, "repository_changed"]);
  assert.equal(f.mutations().length, 0);
  assert.equal(existsSync(attempts), false, "nothing was recorded for a closure that never reached its fence");

  // A commit with nothing prepared writes nothing, and neither does a non-Location commit.
  const unprepared = await commit("never-prepared");
  assert.deepEqual([unprepared.ok, unprepared.failure], [false, "runner_failed"]);
  const noLocation = await f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "commit", requestId: "commit", sessionId, occurrenceId: "approved-once" });
  assert.deepEqual([noLocation.ok, noLocation.failure], [false, "runner_failed"]);

  // The forge changing during its checks is answered at once, with no fence reached.
  const original = f.repository.issue.title;
  f.repository.issue.title = "Changed task";
  const changed = await execute(snapshot, "changed");
  assert.deepEqual([changed.prepared, changed.result?.outcome, changed.result?.refusal?.reason], [undefined, "refused", "issue_changed"]);
  f.repository.issue.title = original;

  // Prepared means every forge check passed and nothing was written: it waits for the commit, and
  // without one in time it writes nothing, ever.
  const abandoned = await execute(snapshot, "abandoned", { locationCommitWaitMs: 10 });
  assert.deepEqual([abandoned.ok, abandoned.prepared], [true, true], abandoned.error ?? "");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const late = await commit("abandoned");
  assert.deepEqual([late.ok, late.failure], [false, "runner_failed"]);
  assert.equal(f.mutations().length, 0);
  assert.equal(existsSync(attempts), false, "a closure that got no commit recorded no attempt");

  // Only one closure of an approval waits at the fence.
  const prepared = await execute(snapshot);
  assert.deepEqual([prepared.ok, prepared.prepared, prepared.result], [true, true, undefined], prepared.error ?? "");
  const again = await execute(snapshot);
  assert.deepEqual([again.ok, again.failure], [false, "runner_failed"]);
  assert.equal(f.mutations().length, 0);
  assert.equal(existsSync(attempts), false);

  // The commit lets it go on. The record is durable before the mutation, and a replay or a restart can't pass it again.
  const closed = await commit();
  assert.equal(closed.requestId, "commit");
  assert.equal(closed.result?.outcome, "closed", closed.error ?? "");
  const recorded = readdirSync(attempts);
  assert.equal(recorded.length, 1);
  assert.equal(readFileSync(join(attempts, recorded[0]!), "utf8").trim(), digest(snapshot));
  assert.equal(f.mutations().length, 1);
  f.repository.issue.state = "OPEN";
  assert.equal((await execute(snapshot)).prepared, true);
  const replay = await commit();
  assert.equal(replay.result?.refusal?.reason, "mutation_fence_unavailable");
  f.restart();
  assert.equal((await execute(snapshot)).prepared, true);
  const afterRestart = await commit();
  assert.equal(afterRestart.result?.refusal?.reason, "mutation_fence_unavailable");
  assert.equal(f.mutations().length, 1);

  // A path this runner doesn't have runs nothing.
  const before = f.commands.length;
  const missing = await inspect({ ...location, workspacePath: join(f.root, "missing") });
  assert.deepEqual([missing.ok, missing.failure], [false, "runner_failed"]);
  assert.equal(f.commands.length, before);
});

test("forge facts at a Location are read in its path with no session here, and only for its own repository (#4119)", async (t) => {
  const f = fixture(t);
  const location = { workspaceId: "api", workspacePath: f.root, repository: "Example/Project" };
  const observe = (pullRequests: Array<{ repository: string; number: number }>, at = location, gh?: GhRunner) =>
    f.manager().campaignForgeObserve({ type: "campaign_forge_observe", requestId: "forge", sessionId: "s_on_another_runner", pullRequests, location: at },
      gh ? { gh } : {});

  // The read names no session of this runner's, and every command runs in the Location's own path.
  const before = f.commands.length;
  await observe([{ repository: "example/project", number: 1 }]);
  const commands = f.commands.slice(before);
  assert.ok(commands.length > 0 && commands.every((command) => command.file === "gh" && command.cwd === realpathSync(f.root)), JSON.stringify(commands));

  // A pull request of any other repository is refused before the forge is asked.
  let asked = 0;
  const gh: GhRunner = async () => { asked++; throw new Error("A refused read must never reach the forge"); };
  const elsewhere = await observe([{ repository: "example/project", number: 1 }, { repository: "example/other", number: 2 }], location, gh);
  assert.deepEqual([elsewhere.ok, elsewhere.failure], [false, "forge_unsupported"]);
  // So is a Location frame that names no usable path, and a path this runner doesn't have is a failure, never a read.
  const blank = await observe([{ repository: "example/project", number: 1 }], { ...location, workspacePath: " " }, gh);
  assert.deepEqual([blank.ok, blank.failure], [false, "forge_unsupported"]);
  const missing = await observe([{ repository: "example/project", number: 1 }], { ...location, workspacePath: join(f.root, "missing") }, gh);
  assert.deepEqual([missing.ok, missing.failure], [false, "forge_error"]);
  assert.equal(asked, 0);
});

test("a publication at a Location creates its issue in that path with no session here, once, and only in that Location's repository (#4119)", async (t) => {
  const f = fixture(t);
  const location = { workspaceId: "api", workspacePath: f.root, repository: "Example/Project" };
  const action = { kind: "issue_publication" as const, repository: "example/project", title: "A Repair", body: "Exact body\n\n- Item", labels: ["bug"] };
  const answers: Array<(args: string[]) => Awaited<ReturnType<GhRunner>>> = [];
  const calls: string[][] = [];
  const payloads: unknown[] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    const input = args.indexOf("--input");
    if (input >= 0) payloads.push(JSON.parse(readFileSync(args[input + 1]!, "utf8")));
    return answers.shift()!(args);
  };
  const created = () => ({ stdout: JSON.stringify({ number: 77, html_url: "https://github.com/example/project/issues/77" }), stderr: "", code: null, timedOut: false });
  const perform = (occurrenceId: string, at: typeof location | null = location, sent: typeof action | { kind: "issue_publication_observe"; repository: string; title: string; body: string } = action) =>
    f.manager().forgeDecisionAction({ type: "forge_decision_action", requestId: "publish", sessionId: "s_on_another_runner", occurrenceId, action: sent, ...(at ? { location: at } : {}) }, { gh });

  // It names no session of this runner's. The exact payload goes in a file, never on the command line.
  answers.push(created);
  const first = await perform("first");
  assert.deepEqual([first.outcome, first.issue, first.refusal], ["published", 77, undefined]);
  assert.deepEqual(calls[0]!.slice(0, 6), ["api", "--hostname", "github.com", "-X", "POST", "repos/example/project/issues"]);
  assert.deepEqual(payloads, [{ title: action.title, body: action.body, labels: action.labels }]);
  assert.equal(calls[0]!.some((arg) => arg.includes(action.body)), false);
  assert.equal(existsSync(calls[0]!.at(-1)!), false, "the payload file is gone");

  // A replay, even after a restart, can't create it twice: the attempt is durable.
  const asked = calls.length;
  assert.equal((await perform("first")).outcome, "uncertain");
  assert.equal(calls.length, asked);

  // Another repository's Location, no Location, and a missing path are refused before the forge is asked.
  assert.equal((await perform("other", { ...location, repository: "example/other" })).refusal?.reason, "repository_mismatch");
  assert.equal((await perform("none", null)).refusal?.reason, "repository_mismatch");
  assert.equal((await perform("missing", { ...location, workspacePath: join(f.root, "missing") })).refusal?.reason, "repository_mismatch");
  // So is a checkout whose origin is no longer the approved repository.
  f.setOrigin("example/elsewhere");
  assert.equal((await perform("moved")).refusal?.reason, "repository_mismatch");
  f.setOrigin("example/project");
  assert.equal(calls.length, asked, "nothing reached the forge");

  // A refusal proving nothing was created gives the attempt back; an unclear failure doesn't.
  answers.push(() => ({ stdout: "", stderr: "HTTP 403: Must have write access", code: 1, timedOut: false }), created);
  assert.equal((await perform("retry")).refusal?.reason, "forge_refused");
  assert.equal((await perform("retry")).outcome, "published");
  answers.push(() => ({ stdout: "", stderr: "connection reset by peer", code: 1, timedOut: false }));
  assert.equal((await perform("lost")).outcome, "uncertain");
  const after = calls.length;
  assert.equal((await perform("lost")).outcome, "uncertain");
  assert.equal(calls.length, after, "the unclear one isn't repeated");
  // An answer naming another repository's issue isn't proof either.
  answers.push(() => ({ stdout: JSON.stringify({ number: 9, html_url: "https://github.com/example/other/issues/9" }), stderr: "", code: null, timedOut: false }));
  assert.equal((await perform("elsewhere")).outcome, "uncertain");

  // Looking never writes, finds only the exact issue, and otherwise stays uncertain.
  const look = { kind: "issue_publication_observe" as const, repository: "example/project", title: action.title, body: action.body };
  const row = (over: object) => ({ number: 5, title: action.title, body: action.body, html_url: "https://github.com/example/project/issues/5", ...over });
  answers.push(() => ({ stdout: JSON.stringify([row({ body: "Another" }), row({ pull_request: {} }), row({ title: "Another" })]), stderr: "", code: null, timedOut: false }));
  assert.equal((await perform("look", location, look)).outcome, "uncertain");
  answers.push(() => ({ stdout: JSON.stringify([row({ number: 6, html_url: "https://github.com/example/project/issues/6" })]), stderr: "", code: null, timedOut: false }));
  const found = await perform("look", location, look);
  assert.deepEqual([found.outcome, found.issue], ["already_published", 6]);
  assert.ok(calls.slice(after).filter((args) => args.includes("GET")).every((args) => !args.includes("POST") && !args.includes("--input")));
});

test("a Location's commit wait starts at its fence, so slow forge checks don't use it up (#4119)", async (t) => {
  const f = fixture(t);
  const location = { workspaceId: "api", workspacePath: f.root, repository: "example/project" };
  const inspected = await f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "inspect", requestId: "inspect", sessionId: "s_on_another_runner", issue, location });
  const { state: _state, ...evidence } = inspected.inspection!;
  const snapshot: GithubIssueClosureSnapshot = { ...evidence, category: "issue_closure", reason: "not_planned", explanation: "Retire obsolete work.",
    evidence: ["Superseded."], activeChildren: [] };
  f.delayNextInspection(60);
  const prepared = await f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "execute", requestId: "execute", sessionId: "s_on_another_runner",
    occurrenceId: "slow", snapshot, location }, { locationCommitWaitMs: 20 });
  assert.equal(prepared.prepared, true, prepared.error ?? "");
  const closed = await f.manager().githubIssueClosure({ type: "github_issue_closure", operation: "commit", requestId: "commit", sessionId: "s_on_another_runner", occurrenceId: "slow", location });
  assert.equal(closed.result?.outcome, "closed", closed.result?.refusal?.reason ?? closed.error ?? "");
  assert.equal(f.mutations().length, 1);
});

test("publication inspection through the runner handler binds payload across distinct request IDs", async (t) => {
  const f=fixture(t);
  const publication={sanitizedTitle:"Related repair",sanitizedBody:"## Problem\nFailure\n## Proposed Behavior\nRepair\n## Acceptance Criteria\n- Works\n## Security and Compatibility\nNone",labels:["feature"]};
  const inspect=(requestId:string) => f.manager().campaignIssueScope({type:"campaign_issue_scope",operation:"publication_inspect",sessionId,requestId,...publication});
  const proposal=await inspect("publication_inspect_first");
  const consumption=await inspect("publication_consume_second");
  assert.equal(proposal.ok,true,proposal.error ?? "proposal inspection"); assert.equal(consumption.ok,true,consumption.error ?? "consumption inspection");
  assert.equal(proposal.publicationDigest,consumption.publicationDigest,"transport request IDs cannot change payload evidence");
  assert.equal(proposal.publicationDigest,createHash("sha256").update(JSON.stringify(publication)).digest("hex"));
  const changed=await f.manager().campaignIssueScope({type:"campaign_issue_scope",operation:"publication_inspect",sessionId,requestId:"third",...publication,labels:["bug"]});
  assert.notEqual(changed.publicationDigest,proposal.publicationDigest,"actual payload changes invalidate the exact grant");
});

for (const moved of [false, true]) {
  test(`a bounded closure carried across an unrelated scope change executes at the synchronized revision${moved ? " and its fence refuses a later change" : ""} (#3915)`, async (t) => {
    const f = fixture(t);
    const original = await f.snapshot();
    const scope = { repository: "example/project", issueNumbers: [issue], revision: 1, authorizedByUserId: "owner", authorizedAt: 1000 };
    const control = (issueScopeRevision: number): import("@wollipog/protocol").CampaignControl => ({ mode: "full_control", boundary: {
      version: 1, revision: 2, issueScopeRevision, repository: scope.repository, objective: "Retire scoped work",
      authorizedByUserId: "owner", authorizedAt: 2000, operations: ["campaign_issue_scope", "issue_closure"], delegatablePolicyIds: [],
      issueAuthority: { epics: [], relatedFollowUps: false, maxIssues: 3, closureReasons: ["not_planned"] },
    } });
    assert.equal((await f.scope({ operation: "synchronize", scope, control: control(1) })).ok, true);
    const approved: GithubIssueClosureSnapshot = { ...original, scopeRevision: 1, issueAdmission: { boundaryRevision: 2, evidenceDigest: "a".repeat(64) } };
    // An Orchestrator-approved addition of another issue, synchronized before execution.
    const added = { ...scope, issueNumbers: [issue, 124], revision: 2 };
    assert.equal((await f.scope({ operation: "synchronize", scope: added, control: control(2) })).ok, true);
    const stale = await f.execute(approved, "stale-revision");
    assert.equal(stale.ok, false, "the runner still refuses a snapshot at an older revision");
    assert.equal(stale.failure, "campaign_authority_changed");
    assert.equal(f.mutations().length, 0);

    // The control plane proves the revisions in between left the issue alone and dispatches the
    // closure at the revision it synchronized.
    const dispatched: GithubIssueClosureSnapshot = { ...approved, scopeRevision: 2 };
    if (moved) {
      f.beforeNextInspection(() => {
        f.store().patchMeta(sessionId, { orchestrator: { ...f.diskMeta().orchestrator!,
          issueScope: { ...added, revision: 3 }, control: control(3) } });
      });
    }
    const result = await f.execute(dispatched);
    assert.equal(result.ok, true, result.error ?? "Expected an inspected result");
    assert.equal(result.result?.outcome, moved ? "refused" : "closed");
    assert.equal(result.result?.refusal?.reason, moved ? "mutation_fence_unavailable" : undefined);
    assert.equal(f.mutations().length, moved ? 0 : 1);
  });
}

test("bounded Full Control scope synchronization persists the advanced boundary for restart", async (t) => {
  const f=fixture(t);
  const scope={repository:"example/project",issueNumbers:[issue],revision:2,authorizedByUserId:"owner",authorizedAt:1000,
    disposition:{bySessionId:sessionId,at:2000,occurrenceId:"scope-once",boundaryRevision:3}};
  const control: import("@wollipog/protocol").CampaignControl={mode:"full_control",boundary:{version:1,revision:3,issueScopeRevision:2,repository:"example/project",objective:"Implement scoped work",
    authorizedByUserId:"owner",authorizedAt:2000,operations:["campaign_issue_scope","issue_closure"],delegatablePolicyIds:[],issueAuthority:{epics:[issue],relatedFollowUps:false,maxIssues:3,closureReasons:["completed"]}}};
  assert.equal((await f.scope({operation:"synchronize",scope,control})).ok,true);
  assert.deepEqual(f.diskMeta().orchestrator!.control,control);
  f.restart();
  assert.deepEqual(f.store().readMeta(sessionId)!.orchestrator!.control,control);
  const humanScope={...scope,revision:3,issueNumbers:[]};
  assert.equal((await f.scope({operation:"synchronize",scope:humanScope,control})).ok,true,"a human revision persists even when it invalidates Full Control");
  assert.deepEqual(f.diskMeta().orchestrator!.issueNumbers,[]);
  assert.deepEqual(f.diskMeta().orchestrator!.control,{mode:"custom"},"stale standing authorization is disabled on the runner");
  f.restart(); assert.equal(f.store().readMeta(sessionId)!.orchestrator!.issueScope!.revision,3);
});

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

function target(kind: ExecutionTargetRef["kind"], strategy: "in_place" | "worktree" = "in_place"): ExecutionTargetRef {
  return { id: `runner:test-runner:host:${strategy}`, runnerId: "test-runner", kind, workspaceStrategy: strategy,
    adapter: kind === "cloud" ? "cloud" : kind === "container" ? "container" : "host",
    boundaries: { filesystem: strategy === "worktree" ? "worktree" : "host", network: "inherit", secrets: "runner_local", billing: "agent_account" } };
}

const refusedSessions: Array<{ name: string; patch: Partial<SessionMeta>; error: string; reason?: HostExecutionTargetRefusalReason }> = [
  { name: "non-Orchestrator", patch: { orchestrator: undefined }, error: "runner-local Orchestrator" },
  { name: "missing repository", patch: { repoPath: "" }, error: "runner-local Orchestrator" },
  { name: "issue outside campaign scope", patch: { orchestrator: { strictProjectIsolation: true, issueNumbers: [456] } }, error: "outside the human-authorized campaign scope" },
  { name: "missing campaign scope", patch: { orchestrator: { strictProjectIsolation: true } }, error: "outside the human-authorized campaign scope" },
  ...(["container", "cloud"] as const).map((kind) => ({
    name: `${kind} execution target`, patch: { executionTarget: target(kind) }, error: "host execution target", reason: "unsupported_adapter" as const,
  })),
  { name: "foreign runner", patch: { executionTarget: { ...target("ssh"), runnerId: "other-runner" } }, error: "host execution target", reason: "runner_mismatch" },
  { name: "mismatched target identity", patch: { executionTarget: { ...target("ssh"), id: "runner:other:host:in_place" } }, error: "host execution target", reason: "runner_mismatch" },
  { name: "mismatched host adapter", patch: { executionTarget: { ...target("ssh"), adapter: "container" } }, error: "host execution target", reason: "unsupported_adapter" },
  { name: "mismatched filesystem boundary", patch: { executionTarget: { ...target("ssh"), boundaries: { ...target("ssh").boundaries, filesystem: "container" } } }, error: "host execution target", reason: "filesystem_mismatch" },
  { name: "mismatched workspace strategy", patch: { executionTarget: { ...target("ssh"), workspaceStrategy: "snapshot" } }, error: "host execution target", reason: "workspace_mismatch" },
  { name: "stale network boundary", patch: { executionTarget: { ...target("ssh"), boundaries: { ...target("ssh").boundaries, network: "deny" } } }, error: "host execution target", reason: "stale_network_policy" },
  { name: "unsupported secrets boundary", patch: { executionTarget: { ...target("ssh"), boundaries: { ...target("ssh").boundaries, secrets: "none" } } }, error: "host execution target", reason: "unsupported_host_boundaries" },
  { name: "unsupported billing boundary", patch: { executionTarget: { ...target("ssh"), boundaries: { ...target("ssh").boundaries, billing: "none" } } }, error: "host execution target", reason: "unsupported_host_boundaries" },
];

for (const { name, patch, error, reason } of refusedSessions) {
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
      // #4059: every refusal is classified for the decision's recorded reason.
      assert.equal(result.failure, error.includes("outside") ? "campaign_authority_changed" : "runner_failed");
      assert.equal(f.commands.length, 0, `${operation} must refuse before external inspection or mutation`);
      assert.equal(f.diskMeta().githubIssueClosureAttempts, undefined);
    }
    if (!patch.executionTarget) return;
    const scope = { repository: "example/project", issueNumbers: [issue], revision: 1,
      authorizedByUserId: "human", authorizedAt: 1000 };
    for (const message of [
      { operation: "inspect" as const },
      { operation: "synchronize" as const, scope },
      { operation: "publication_inspect" as const, sanitizedTitle: "Repair", sanitizedBody: "Sanitized body", labels: [] },
    ]) {
      const result = await f.manager().campaignIssueScope({ type: "campaign_issue_scope", sessionId, requestId: message.operation, ...message });
      assert.equal(result.ok, false);
      assert.equal(result.failure, "unsupported_execution_target");
      assert.equal(result.targetFailureReason, reason);
    }
    let forgeCalls = 0;
    const observed = await f.manager().campaignForgeObserve({ type: "campaign_forge_observe", requestId: "forge", sessionId,
      pullRequests: [{ repository: "example/project", number: 1 }] }, { gh: async () => {
        forgeCalls++;
        throw new Error("A refused target must never reach GitHub");
      } });
    assert.equal(observed.ok, false);
    assert.equal(forgeCalls, 0);
    assert.equal(f.commands.length, 0, "scope and forge refusals run no commands");
    const refusal = f.logs.map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((entry) => entry?.event === "campaign_issue_scope_refused");
    assert.deepEqual(refusal, { event: "campaign_issue_scope_refused", entryPoint: "inspect", requestId: "inspect",
      sessionId, failure: "unsupported_execution_target", targetFailureReason: reason });
  });
}

for (const kind of ["local", "ssh"] as const) {
  for (const strategy of ["in_place", "worktree"] as const) {
    test(`a ${kind} ${strategy} host target inspects scope, synchronizes it across recreation, observes forge status and closes an authorized issue`, async (t) => {
      const f = fixture(t);
      f.store().patchMeta(sessionId, { executionTarget: target(kind, strategy) });
      const inspected = await f.scope({ operation: "inspect", issues: [issue] });
      assert.equal(inspected.ok, true, inspected.error ?? "Expected scope inspection");
      assert.equal(inspected.repository, "example/project");
      assert.equal(inspected.candidates?.[0]?.issue.number, issue);
      const snapshot = { ...await f.snapshot(), scopeRevision: 1 };
      const scope = { repository: "example/project", issueNumbers: [issue], revision: 1,
        authorizedByUserId: "human", authorizedAt: 1000 };
      const synchronized = await f.manager().campaignIssueScope({ type: "campaign_issue_scope", operation: "synchronize",
        requestId: "sync", sessionId, scope });
      assert.equal(synchronized.ok, true, synchronized.error ?? "Expected scope synchronization");
      f.restart();
      assert.deepEqual(f.diskMeta().orchestrator!.issueScope, scope);
      assert.equal((await f.scope({ operation: "inspect" })).ok, true);
      let forgeCalls = 0;
      const observed = await f.manager().campaignForgeObserve({ type: "campaign_forge_observe", requestId: "forge", sessionId,
        pullRequests: [{ repository: "example/project", number: 1 }] }, { gh: async () => {
          forgeCalls++;
          return { stdout: JSON.stringify({ data: { r0: { pullRequest: { state: "OPEN", isDraft: false,
            headRefOid: "a".repeat(40), baseRefName: "main", reviewDecision: null, mergeStateStatus: "CLEAN",
            mergeCommit: null, mergeQueueEntry: null, commits: { nodes: [] } } } } }),
            stderr: "", code: null, timedOut: false };
        } });
      assert.equal(observed.ok, true);
      assert.equal(forgeCalls, 1);
      assert.equal(observed.results?.[0]?.ok, true);
      // A GitLab merge request goes through glab only when the control plane asks (#3600).
      const glabCalls: string[][] = [];
      const glab = async (args: string[]) => {
        glabCalls.push(args);
        const path = args[1] ?? "";
        const stdout = path.endsWith("/approvals")
          ? JSON.stringify({ approved: true, approvals_left: 0, approved_by: [] })
          : path.includes("merge_trains") ? ""
            : JSON.stringify({ iid: 4, state: "merged", draft: false, sha: "b".repeat(40), target_branch: "main",
              merge_commit_sha: "c".repeat(40), squash_commit_sha: null, head_pipeline: null });
        return { stdout, stderr: "", code: null, timedOut: false };
      };
      const gitlabRef = { repository: "gitlab.com/group/sub/project", number: 4 };
      const legacy = await f.manager().campaignForgeObserve({ type: "campaign_forge_observe", requestId: "forge-gl-0", sessionId,
        pullRequests: [gitlabRef] }, { glab });
      assert.deepEqual(legacy.results?.[0], { ref: gitlabRef, ok: false, failure: "forge_unsupported" });
      assert.equal(glabCalls.length, 0, "an older control plane is never sent a GitLab observation");
      const gitlab = await f.manager().campaignForgeObserve({ type: "campaign_forge_observe", requestId: "forge-gl", sessionId,
        pullRequests: [gitlabRef], gitlab: true }, { glab });
      const gitlabResult = gitlab.results?.[0];
      assert.ok(gitlabResult?.ok && gitlabResult.observation.forge === "gitlab", JSON.stringify(gitlab));
      assert.equal(gitlabResult.observation.mergeCommitSha, "c".repeat(40));
      assert.ok(glabCalls.every((call) => call.at(-1) === "gitlab.com"));
      const result = await f.execute(snapshot);
      assert.equal(result.ok, true, result.error ?? "Expected a successful runner response");
      assert.equal(result.result?.outcome, "closed");
      assert.equal(f.mutations().length, 1);
    });
  }
}


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

test("a scope removal during provider preparation reaches the driver launch policy", async (t) => {
  const f = fixture(t);
  const initial = { repository: "example/project", issueNumbers: [issue], revision: 1, authorizedByUserId: "owner", authorizedAt: 1000 };
  assert.equal((await f.scope({operation:"synchronize",scope:initial})).ok,true);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter=resolve; });
  const gate = new Promise<void>((resolve) => { release=resolve; });
  let launched: import("./drivers/driver.js").DriverOptions["orchestrator"];
  const manager = f.manager() as unknown as {
    providerHomeLeases: { acquireReference(): Promise<null>; stopAcquisitions(): void };
    createDriver: (kind: string, options: import("./drivers/driver.js").DriverOptions) => never;
    beginLaunchGeneration(id: string): number;
    launch(meta: SessionMeta, resume: undefined, generation: number): Promise<boolean>;
  };
  manager.providerHomeLeases = { acquireReference: async () => { enter(); await gate; return null; }, stopAcquisitions() {} };
  manager.createDriver = (_kind, options) => { launched=options.orchestrator; throw new Error("capture-only driver"); };
  const launching = manager.launch(f.store().readMeta(sessionId)!,undefined,manager.beginLaunchGeneration(sessionId));
  try {
    await entered;
    assert.equal((await f.scope({operation:"synchronize",scope:{...initial,issueNumbers:[],revision:2}})).ok,true);
  } finally { release(); }
  await launching;
  assert.deepEqual(launched?.issueNumbers,[],"the removed issue must not regain live permission authority");
  assert.equal(launched?.issueScope?.revision,2);
});

test("a revisioned scope cannot launch a provider against a different GitHub origin", async (t) => {
  const f=fixture(t);
  const scope={repository:"example/project",issueNumbers:[issue],revision:1,authorizedByUserId:"owner",authorizedAt:1000};
  assert.equal((await f.scope({operation:"synchronize",scope})).ok,true);
  f.setOrigin("other/project");
  let drivers=0;
  const manager=f.manager() as unknown as {
    createDriver: () => never;
    beginLaunchGeneration(id:string):number;
    launch(meta:SessionMeta,resume:undefined,generation:number):Promise<boolean>;
  };
  manager.createDriver=()=>{drivers++;throw new Error("must not construct provider");};
  assert.equal(await manager.launch(f.store().readMeta(sessionId)!,undefined,manager.beginLaunchGeneration(sessionId)),false);
  assert.equal(drivers,0);
});

test("same-revision synchronization with a changed origin withdraws live issue permission authority", async (t) => {
  const f=fixture(t);
  const scope={repository:"example/project",issueNumbers:[issue],revision:1,authorizedByUserId:"owner",authorizedAt:1000};
  assert.equal((await f.scope({operation:"synchronize",scope})).ok,true);
  const policy={strictProjectIsolation:true,issueNumbers:[issue],issueScope:scope};
  const active=(f.manager() as unknown as {active:Map<string,{orchestratorLaunchPolicy:typeof policy}>}).active;
  active.set(sessionId,{orchestratorLaunchPolicy:policy});
  try {
    f.setOrigin("other/project");
    assert.equal((await f.scope({operation:"synchronize",scope})).ok,false);
    assert.deepEqual(policy.issueNumbers,[],"origin mismatch must fail closed even without a higher revision");
    f.setOrigin("example/project");
    assert.equal((await f.scope({operation:"synchronize",scope})).ok,true);
    assert.deepEqual(policy.issueNumbers,[issue]);
  } finally {active.delete(sessionId);}
});

test("a participant in another boundary repository stores its own repository's part of the scope (#4118)", async (t) => {
  const f = fixture(t);
  // This runner's origin is example/project; the campaign launched in owner/app.
  const boundary = (repositories: Array<{ repository: string; locationIds: string[] }>): import("@wollipog/protocol").CampaignControl => ({ mode: "full_control", boundary: {
    version: 1, revision: 2, issueScopeRevision: 1, repository: "owner/app", objective: "Deliver across repositories",
    authorizedByUserId: "owner", authorizedAt: 2000, operations: ["campaign_issue_scope"], delegatablePolicyIds: [], repositories } });
  const scope = { repository: "example/project", issueNumbers: [5], revision: 1, authorizedByUserId: "owner", authorizedAt: 1000 };
  const outside = await f.scope({ operation: "synchronize", scope, control: boundary([{ repository: "owner/app", locationIds: ["loc_app"] }]) });
  assert.equal(outside.ok, false, "a boundary without this runner's repository is refused");
  assert.match(outside.error ?? "", /another repository/u);
  const synchronized = await f.scope({ operation: "synchronize", scope, control: boundary([
    { repository: "owner/app", locationIds: ["loc_app"] }, { repository: "Example/Project", locationIds: ["loc_project"] }]) });
  assert.equal(synchronized.ok, true, synchronized.error ?? "");
  const stored = f.diskMeta().orchestrator!;
  assert.deepEqual([stored.issueScope?.repository, stored.issueNumbers], ["example/project", [5]]);
});

/** #3363: control metadata has its own order, alongside issue-scope ordering. */
const orderedControl = (revision: number): import("@wollipog/protocol").CampaignControl => ({ mode: "full_control", boundary: {
  version: 1, revision, issueScopeRevision: 1, repository: "example/project", objective: "Retire scoped work",
  authorizedByUserId: "owner", authorizedAt: 2000, operations: ["issue_closure"], delegatablePolicyIds: [],
  issueAuthority: { epics: [], relatedFollowUps: false, maxIssues: 1, closureReasons: ["not_planned"] } } });

test("a delayed synchronization cannot roll back control within one scope revision, before or after recreation (#3363)", async (t) => {
  const f = fixture(t);
  const original = await f.snapshot();
  const scope = { repository: "example/project", issueNumbers: [issue], revision: 1, authorizedByUserId: "owner", authorizedAt: 1000 };
  assert.equal((await f.scope({ operation: "synchronize", scope, control: orderedControl(2), controlRevision: 2 })).ok, true);
  // A same-scope control change (a reauthorization) applies without any scope edit.
  assert.equal((await f.scope({ operation: "synchronize", scope, control: orderedControl(3), controlRevision: 3 })).ok, true);
  assert.deepEqual(f.diskMeta().orchestrator!.control, orderedControl(3));
  assert.equal(f.diskMeta().orchestrator!.controlRevision, 3);
  const policy: { issueNumbers?: number[]; issueScope?: typeof scope; control?: import("@wollipog/protocol").CampaignControl; controlRevision?: number } =
    { issueNumbers: [issue], issueScope: scope, control: orderedControl(3), controlRevision: 3 };
  const active = (f.manager() as unknown as { active: Map<string, { orchestratorLaunchPolicy: typeof policy }> }).active;
  active.set(sessionId, { orchestratorLaunchPolicy: policy });
  try {
    const delayed = await f.scope({ operation: "synchronize", scope, control: orderedControl(2), controlRevision: 2 });
    assert.equal(delayed.ok, true, "the scope itself is current");
    assert.deepEqual(f.diskMeta().orchestrator!.control, orderedControl(3), "the delayed control is ignored on disk");
    assert.deepEqual(policy.control, orderedControl(3), "and in the live launch policy");
    assert.deepEqual(policy.issueNumbers, [issue]);
    assert.ok(f.logs.some((line) => line.includes("campaign_control_update_ignored")));
  } finally { active.delete(sessionId); }

  // The order persists: a runner restart (reconnect) does not reopen the window.
  f.restart();
  assert.equal((await f.scope({ operation: "synchronize", scope, control: orderedControl(2), controlRevision: 2 })).ok, true);
  assert.deepEqual(f.store().readMeta(sessionId)!.orchestrator!.control, orderedControl(3));

  // A revoke at the next revision narrows it; nothing older revives the boundary.
  assert.equal((await f.scope({ operation: "synchronize", scope, control: { mode: "custom" }, controlRevision: 4 })).ok, true);
  assert.equal((await f.scope({ operation: "synchronize", scope, control: orderedControl(3), controlRevision: 3 })).ok, true);
  assert.equal((await f.scope({ operation: "synchronize", scope, control: orderedControl(3) })).ok, true, "an unordered peer");
  assert.deepEqual(f.diskMeta().orchestrator!.control, { mode: "custom" });
  assert.equal(f.diskMeta().orchestrator!.controlRevision, 4);
  const refused = await f.execute({ ...original, scopeRevision: 1, issueAdmission: { boundaryRevision: 3, evidenceDigest: "a".repeat(64) } });
  assert.equal(refused.ok, false, "a stale diagnostic never becomes a grant");
  assert.equal(refused.failure, "campaign_authority_changed");
  assert.equal(f.mutations().length, 0);
});

test("a control revision must be valid and accompany control (#3363)", async (t) => {
  const f = fixture(t);
  const scope = { repository: "example/project", issueNumbers: [issue], revision: 1, authorizedByUserId: "owner", authorizedAt: 1000 };
  assert.equal((await f.scope({ operation: "synchronize", scope, control: orderedControl(2), controlRevision: -1 })).ok, false);
  assert.equal((await f.scope({ operation: "synchronize", scope, control: orderedControl(2), controlRevision: 1.5 })).ok, false);
  assert.equal((await f.scope({ operation: "synchronize", scope, controlRevision: 2 })).ok, false);
  assert.equal(f.diskMeta().orchestrator!.issueScope, undefined, "a refused synchronization persists nothing");
  // An older control plane sends no revision: control replaces as before.
  assert.equal((await f.scope({ operation: "synchronize", scope, control: orderedControl(2) })).ok, true);
  assert.equal((await f.scope({ operation: "synchronize", scope, control: orderedControl(3) })).ok, true);
  assert.deepEqual(f.diskMeta().orchestrator!.control, orderedControl(3));
  assert.equal(f.diskMeta().orchestrator!.controlRevision, undefined);
});

// #4269: a Custom campaign's Orchestrator launches before the Decision Model's first-message reading
// settles, so it holds no issue numbers; the control plane then delivers the granted ones.
type GrantPolicy = NonNullable<SessionMeta["orchestrator"]>;
type ActiveSessions = Map<string, { orchestratorLaunchPolicy: GrantPolicy }>;

/** The fixture's Orchestrator as such a campaign: no issue numbers and no scope yet. */
function ungranted(f: ReturnType<typeof fixture>) {
  f.store().patchMeta(sessionId, { orchestrator: { strictProjectIsolation: true } });
  const active = (f.manager() as unknown as { active: ActiveSessions }).active;
  // The driver's launch policy: the exact object the Claude routine-write classifier reads on each ask.
  const policy: GrantPolicy = { strictProjectIsolation: true };
  return { policy, active, live: () => { active.set(sessionId, { orchestratorLaunchPolicy: policy }); } };
}
const grantIssues = (f: ReturnType<typeof fixture>, issueNumbers: number[] = [issue, 124], campaignSessionId = sessionId) =>
  f.scope({ operation: "grant_issue_numbers", campaignSessionId, issueNumbers });
const claim = (n: number) => ({ command: `gh issue edit ${n} --add-assignee @me` });

test("a granted issue reaches a live Orchestrator's routine-write classifier and closure checks without a relaunch (#4269)", async (t) => {
  const f = fixture(t);
  const g = ungranted(f);
  g.live();
  try {
    assert.notEqual(classifyRoutineClaudeOrchestratorPermission("Bash", claim(issue), g.policy.issueNumbers ?? [], f.root), "allow",
      "before the grant, a write on the issue takes the person's approval path");
    const refused = await f.inspect();
    assert.equal(refused.ok, false);
    assert.equal(refused.failure, "campaign_authority_changed", "before the grant, the closure check refuses the issue");
    const applied = await grantIssues(f, [124, issue]);
    assert.equal(applied.ok, true, applied.error ?? "applied");
    assert.equal(applied.issueNumbersGrant, "applied");
    assert.deepEqual(g.policy.issueNumbers, [issue, 124], "the live launch policy is updated in place");
    assert.equal(classifyRoutineClaudeOrchestratorPermission("Bash", claim(issue), g.policy.issueNumbers ?? [], f.root), "allow",
      "the running provider now treats the granted issue as a routine write");
    assert.notEqual(classifyRoutineClaudeOrchestratorPermission("Bash", claim(999), g.policy.issueNumbers ?? [], f.root), "allow",
      "an issue the grant does not name stays the person's");
    assert.deepEqual(f.diskMeta().orchestrator, { strictProjectIsolation: true, issueNumbers: [issue, 124] },
      "the stored launch metadata gains exactly the numbers: no scope, revision or control");
    const inspected = await f.inspect();
    assert.equal(inspected.ok, true, inspected.error ?? "the closure check now recognizes the granted issue");
    assert.equal(f.mutations().length, 0);
  } finally { g.active.delete(sessionId); }
  // The next launch carries the same numbers.
  f.restart();
  let launched: import("./drivers/driver.js").DriverOptions["orchestrator"];
  const manager = f.manager() as unknown as {
    createDriver: (kind: string, options: import("./drivers/driver.js").DriverOptions) => never;
    beginLaunchGeneration(id: string): number;
    launch(meta: SessionMeta, resume: undefined, generation: number): Promise<boolean>;
  };
  manager.createDriver = (_kind, options) => { launched = options.orchestrator; throw new Error("capture-only driver"); };
  await manager.launch(f.store().readMeta(sessionId)!, undefined, manager.beginLaunchGeneration(sessionId));
  assert.deepEqual(launched?.issueNumbers, [issue, 124]);
});

test("a duplicate grant delivery is a no-op (#4269)", async (t) => {
  const f = fixture(t);
  const g = ungranted(f);
  g.live();
  try {
    assert.equal((await grantIssues(f)).issueNumbersGrant, "applied");
    const stored = JSON.stringify(f.diskMeta());
    const writes = f.logs.length;
    for (const numbers of [[issue, 124], [124, issue]]) {
      const replay = await grantIssues(f, numbers);
      assert.equal(replay.ok, true, replay.error ?? "replayed");
      assert.equal(replay.issueNumbersGrant, "unchanged");
    }
    assert.equal(JSON.stringify(f.diskMeta()), stored, "nothing is written again");
    assert.deepEqual(g.policy.issueNumbers, [issue, 124]);
    assert.equal(f.logs.slice(writes).filter((line) => line.includes("campaign_issue_numbers_granted")).length, 0);
  } finally { g.active.delete(sessionId); }
});

test("a grant is refused for a session holding issue numbers or a scope, a stopped session, another campaign, and malformed numbers (#4269)", async (t) => {
  const f = fixture(t);
  const g = ungranted(f);
  const unchanged = async (name: string, refusal: import("@wollipog/protocol").CampaignIssueNumberGrantRefusal,
    send: () => ReturnType<typeof grantIssues>) => {
    const before = JSON.stringify(f.diskMeta().orchestrator);
    const livePolicy = JSON.stringify(g.policy);
    const result = await send();
    assert.equal(result.ok, false, name);
    assert.equal(result.grantRefusal, refusal, name);
    assert.equal(result.issueNumbersGrant, undefined, name);
    assert.equal(JSON.stringify(f.diskMeta().orchestrator), before, `${name}: stored launch metadata unchanged`);
    assert.equal(JSON.stringify(g.policy), livePolicy, `${name}: live launch policy unchanged`);
  };
  // No live or launching provider: a stopped session gets the numbers at its next launch instead.
  await unchanged("no live provider", "not_live", () => grantIssues(f));
  g.live();
  try {
    for (const status of ["stopped", "failed", "completed"] as const) {
      f.store().patchMeta(sessionId, { status });
      await unchanged(`a ${status} session`, "not_live", () => grantIssues(f));
    }
    f.store().patchMeta(sessionId, { status: "idle" });
    await unchanged("another campaign's grant", "other_campaign", () => grantIssues(f, [issue], "s_other_campaign"));
    await unchanged("no numbers", "invalid", () => grantIssues(f, []));
    await unchanged("a non-issue number", "invalid", () => grantIssues(f, [0]));
    await unchanged("a repeated number", "invalid", () => grantIssues(f, [issue, issue]));
    await unchanged("more than the bound", "invalid", () => grantIssues(f, Array.from({ length: 101 }, (_, i) => i + 1)));
    // A session already holding other numbers is never widened or changed.
    f.store().patchMeta(sessionId, { orchestrator: { strictProjectIsolation: true, issueNumbers: [issue] } });
    await unchanged("other numbers held", "issue_numbers_held", () => grantIssues(f, [issue, 124]));
    await unchanged("different numbers held", "issue_numbers_held", () => grantIssues(f, [124]));
    // Live authority the stored metadata lacks is never overwritten either.
    f.store().patchMeta(sessionId, { orchestrator: { strictProjectIsolation: true } });
    g.policy.issueNumbers = [issue];
    await unchanged("numbers held by the live session", "issue_numbers_held", () => grantIssues(f, [issue, 124]));
    delete g.policy.issueNumbers;
    // A session holding an authorized issue scope keeps the synchronize path, even an empty one.
    const scope = { repository: "example/project", issueNumbers: [], revision: 1, authorizedByUserId: "owner", authorizedAt: 1000 };
    assert.equal((await f.scope({ operation: "synchronize", scope })).ok, true);
    await unchanged("an authorized issue scope", "issue_scope_held", () => grantIssues(f, [issue]));
  } finally { g.active.delete(sessionId); }
  // A session that is not an Orchestrator holds no campaign authority at all.
  f.store().patchMeta(sessionId, { orchestrator: undefined });
  const plain = await grantIssues(f);
  assert.equal(plain.grantRefusal, "not_orchestrator");
  assert.equal(f.diskMeta().orchestrator, undefined);
});

test("a grant that arrives while the provider is still launching reaches the driver's launch policy (#4269)", async (t) => {
  const f = fixture(t);
  ungranted(f);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let launched: import("./drivers/driver.js").DriverOptions["orchestrator"];
  const manager = f.manager() as unknown as {
    providerHomeLeases: { acquireReference(): Promise<null>; stopAcquisitions(): void };
    createDriver: (kind: string, options: import("./drivers/driver.js").DriverOptions) => never;
    beginLaunchGeneration(id: string): number;
    launch(meta: SessionMeta, resume: undefined, generation: number): Promise<boolean>;
  };
  manager.providerHomeLeases = { acquireReference: async () => { enter(); await gate; return null; }, stopAcquisitions() {} };
  manager.createDriver = (_kind, options) => { launched = options.orchestrator; throw new Error("capture-only driver"); };
  const launching = manager.launch(f.store().readMeta(sessionId)!, undefined, manager.beginLaunchGeneration(sessionId));
  try {
    await entered;
    const applied = await grantIssues(f);
    assert.equal(applied.issueNumbersGrant, "applied", applied.error ?? "applied");
  } finally { release(); }
  await launching;
  assert.deepEqual(launched?.issueNumbers, [issue, 124], "the launching provider starts with the granted numbers");
  assert.equal(launched?.issueScope, undefined);
});

test("a grant applied while a restart prepares survives the restart's metadata rebuild from its older spec (#4269, review round 1)", async (t) => {
  const f = fixture(t);
  ungranted(f);
  f.store().patchMeta(sessionId, { status: "stopped" });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let launched: import("./drivers/driver.js").DriverOptions["orchestrator"];
  const manager = f.manager() as unknown as {
    runWorktreeOperation<T>(id: string, operation: () => Promise<T>): Promise<T>;
    createDriver: (kind: string, options: import("./drivers/driver.js").DriverOptions) => never;
    start(spec: import("@wollipog/protocol").SessionLaunchSpec): Promise<boolean>;
  };
  const runWorktreeOperation = manager.runWorktreeOperation.bind(manager);
  let held = false;
  manager.runWorktreeOperation = async (id, operation) => {
    // Hold the restart inside startGeneration, after its launch generation began and before it
    // rebuilds the session row from its spec.
    if (!held) { held = true; enter(); await gate; }
    return runWorktreeOperation(id, operation);
  };
  manager.createDriver = (_kind, options) => { launched = options.orchestrator; throw new Error("capture-only driver"); };
  // The restart's spec was built before the reading settled: no issue numbers.
  const starting = manager.start({ sessionId, agentId: "claude", workspaceId: "repo", workspacePath: f.root, driver: "claude-code",
    command: "claude", args: [], env: {}, context: { kind: "native" }, useWorktree: false, orchestrator: { strictProjectIsolation: true, integrationIsolation: false } });
  try {
    await entered;
    const applied = await grantIssues(f);
    assert.equal(applied.issueNumbersGrant, "applied", applied.error ?? "applied during the restart");
  } finally { release(); }
  await starting;
  assert.deepEqual(launched?.issueNumbers, [issue, 124], "the replacement provider starts with the applied grant");
  assert.deepEqual(f.diskMeta().orchestrator?.issueNumbers, [issue, 124], "the rebuilt row keeps the applied grant");
});

test("an applied grant never fills a later launch that holds issue numbers, a scope or Full Control (#4269, review round 1)", async (t) => {
  const f = fixture(t);
  const g = ungranted(f);
  g.live();
  const internals = f.manager() as unknown as {
    beginLaunchGeneration(id: string): number;
    withAppliedIssueGrant(id: string, generation: number, orchestrator: SessionMeta["orchestrator"]): SessionMeta["orchestrator"];
  };
  // A restart is under way when the grant arrives: only that launch generation may re-apply it.
  const generation = internals.beginLaunchGeneration(sessionId);
  try { assert.equal((await grantIssues(f)).issueNumbersGrant, "applied"); } finally { g.active.delete(sessionId); }
  const scope = { repository: "example/project", issueNumbers: [124], revision: 1, authorizedByUserId: "owner", authorizedAt: 1000 };
  assert.deepEqual(internals.withAppliedIssueGrant(sessionId, generation, { strictProjectIsolation: true, issueScope: scope, issueNumbers: [] }),
    { strictProjectIsolation: true, issueScope: scope, issueNumbers: [] }, "a scope, even one that removed every issue, is never refilled");
  assert.deepEqual(internals.withAppliedIssueGrant(sessionId, generation, { strictProjectIsolation: true, issueNumbers: [124] }),
    { strictProjectIsolation: true, issueNumbers: [124] }, "held numbers are never replaced or merged");
  const fullControl = { strictProjectIsolation: true, control: orderedControl(2) };
  assert.deepEqual(internals.withAppliedIssueGrant(sessionId, generation, fullControl), { strictProjectIsolation: true, control: orderedControl(2) },
    "a Full Control launch never adopts a Custom grant");
  assert.equal(internals.withAppliedIssueGrant(sessionId, generation, undefined), undefined, "a non-Orchestrator launch gains nothing");
  assert.deepEqual(internals.withAppliedIssueGrant("s_other_session", generation, { strictProjectIsolation: true }), { strictProjectIsolation: true },
    "another session's launch gains nothing");
  assert.deepEqual(internals.withAppliedIssueGrant(sessionId, generation + 1, { strictProjectIsolation: true }), { strictProjectIsolation: true },
    "another launch generation gains nothing");
  const empty = { strictProjectIsolation: true };
  assert.deepEqual(internals.withAppliedIssueGrant(sessionId, generation, empty), { strictProjectIsolation: true, issueNumbers: [issue, 124] },
    "the launch the grant raced with re-applies it");
  assert.deepEqual(empty, { strictProjectIsolation: true }, "the spec is never mutated");
});

// A grant is remembered only for the launch it raced with. Any later launch takes its issue numbers
// from its own spec, which is the control plane's current authority for the session.
type GrantRestartInternals = {
  runWorktreeOperation<T>(id: string, operation: () => Promise<T>): Promise<T>;
  createDriver: (kind: string, options: import("./drivers/driver.js").DriverOptions) => never;
  start(spec: import("@wollipog/protocol").SessionLaunchSpec): Promise<boolean>;
  stop(id: string): void;
  launchGenerations: Map<string, number>;
  grantedIssueNumbers: Map<string, unknown>;
  withAppliedIssueGrant(id: string, generation: number, orchestrator: SessionMeta["orchestrator"]): SessionMeta["orchestrator"];
};
const restartSpec = (f: ReturnType<typeof fixture>, orchestrator: NonNullable<import("@wollipog/protocol").SessionLaunchSpec["orchestrator"]> =
  { strictProjectIsolation: true, integrationIsolation: false }): import("@wollipog/protocol").SessionLaunchSpec => ({
  sessionId, agentId: "claude", workspaceId: "repo", workspacePath: f.root, driver: "claude-code",
  command: "claude", args: [], env: {}, context: { kind: "native" }, useWorktree: false, orchestrator });

/** Restarts that capture the launch policy each provider would receive. `holdNext` pauses the next
 * restart after its launch generation began and before it rebuilds the session row from its spec. */
function grantRestarts(f: ReturnType<typeof fixture>) {
  const manager = f.manager() as unknown as GrantRestartInternals;
  const runWorktreeOperation = manager.runWorktreeOperation.bind(manager);
  let hold: Promise<void> | undefined;
  let enter: (() => void) | undefined;
  type Launched = import("./drivers/driver.js").DriverOptions["orchestrator"];
  let launched: Launched;
  const captured = (): Launched => launched;
  manager.runWorktreeOperation = async (id, operation) => {
    const gate = hold;
    hold = undefined;
    if (gate) { enter?.(); await gate; }
    return runWorktreeOperation(id, operation);
  };
  manager.createDriver = (_kind, options) => { launched = options.orchestrator; throw new Error("capture-only driver"); };
  return {
    manager,
    launched: captured,
    restart: async (spec = restartSpec(f)) => { launched = undefined; await manager.start(spec); return captured(); },
    holdNext: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      return { entered, release };
    },
  };
}
const routine = (f: ReturnType<typeof fixture>, numbers: number[] | undefined, n = issue) =>
  classifyRoutineClaudeOrchestratorPermission("Bash", claim(n), numbers ?? [], f.root);

test("a grant to a running Orchestrator never overrides a newer launch spec without its numbers", async (t) => {
  const f = fixture(t);
  const g = ungranted(f);
  g.live();
  try { assert.equal((await grantIssues(f)).issueNumbersGrant, "applied"); } finally { g.active.delete(sessionId); }
  assert.deepEqual(f.diskMeta().orchestrator?.issueNumbers, [issue, 124]);
  f.store().patchMeta(sessionId, { status: "stopped" });
  const r = grantRestarts(f);
  // The control plane's newer spec carries no numbers: they were narrowed or revoked.
  const launched = await r.restart();
  assert.ok(launched, "the replacement provider was constructed");
  assert.equal(launched.issueNumbers, undefined, "the newer spec's empty grant stands");
  assert.notEqual(routine(f, launched.issueNumbers), "allow", "a write on the revoked issue takes the person's approval path");
  assert.equal(f.diskMeta().orchestrator?.issueNumbers, undefined, "the rebuilt row holds no revoked numbers");
  const refused = await f.inspect();
  assert.equal(refused.failure, "campaign_authority_changed", "the runner's closure check refuses the revoked issue");
});

for (const [name, next] of [
  ["a Custom spec without numbers", { strictProjectIsolation: true, integrationIsolation: false }],
  ["a Full Control spec", { strictProjectIsolation: true, integrationIsolation: false, control: orderedControl(2) }],
] as const) {
  test(`a grant that raced with one restart never fills the next: ${name}`, async (t) => {
    const f = fixture(t);
    ungranted(f);
    f.store().patchMeta(sessionId, { status: "stopped" });
    const r = grantRestarts(f);
    const held = r.holdNext();
    const first = r.restart();
    try {
      await held.entered;
      assert.equal((await grantIssues(f)).issueNumbersGrant, "applied");
    } finally { held.release(); }
    assert.deepEqual((await first)?.issueNumbers, [issue, 124], "the launch the grant raced with keeps it");
    assert.equal(r.manager.grantedIssueNumbers.has(sessionId), false, "the finished launch forgets it");
    const launched = await r.restart(restartSpec(f, next));
    assert.ok(launched, "the next provider was constructed");
    assert.equal(launched.issueNumbers, undefined, "the next spec's authority stands");
    assert.notEqual(routine(f, launched.issueNumbers), "allow");
    assert.equal(f.diskMeta().orchestrator?.issueNumbers, undefined);
  });
}

test("a scope synchronization forgets a grant that raced with a restart", async (t) => {
  const scope = { repository: "example/project", issueNumbers: [124], revision: 1, authorizedByUserId: "owner", authorizedAt: 1000 };
  for (const [name, message, expected] of [
    ["a refused synchronization", { operation: "synchronize", scope: { ...scope, revision: 0 } }, undefined],
    ["an applied synchronization", { operation: "synchronize", scope }, [124]],
  ] as const) {
    const f = fixture(t);
    ungranted(f);
    f.store().patchMeta(sessionId, { status: "stopped" });
    const r = grantRestarts(f);
    const held = r.holdNext();
    const starting = r.restart();
    try {
      await held.entered;
      assert.equal((await grantIssues(f)).issueNumbersGrant, "applied", name);
      const generation = r.manager.launchGenerations.get(sessionId)!;
      assert.deepEqual(r.manager.withAppliedIssueGrant(sessionId, generation, { strictProjectIsolation: true })?.issueNumbers, [issue, 124],
        `${name}: before synchronization the raced launch would re-apply the grant`);
      const synchronized = await f.scope(message as ScopeOperation);
      assert.equal(synchronized.ok, expected !== undefined, `${name}: ${synchronized.error ?? "ok"}`);
      assert.equal(r.manager.grantedIssueNumbers.has(sessionId), false, `${name}: the remembered grant is forgotten`);
      assert.equal(r.manager.withAppliedIssueGrant(sessionId, generation, { strictProjectIsolation: true })?.issueNumbers, undefined, name);
    } finally { held.release(); }
    const launched = await starting;
    assert.ok(launched, `${name}: the provider was constructed`);
    assert.deepEqual(launched.issueNumbers, expected, `${name}: the launch holds only what the synchronized authority carries`);
    if (expected) assert.equal(routine(f, launched.issueNumbers, 124), "allow", `${name}: the scope's issue is routine`);
    assert.notEqual(routine(f, launched.issueNumbers, issue), "allow", `${name}: the forgotten grant's issue is not routine`);
  }
});

test("stopping a session forgets a grant that raced with its restart", async (t) => {
  const f = fixture(t);
  ungranted(f);
  f.store().patchMeta(sessionId, { status: "stopped" });
  const r = grantRestarts(f);
  const held = r.holdNext();
  const starting = r.restart();
  try {
    await held.entered;
    assert.equal((await grantIssues(f)).issueNumbersGrant, "applied");
    assert.equal(r.manager.grantedIssueNumbers.has(sessionId), true);
    r.manager.stop(sessionId);
    assert.equal(r.manager.grantedIssueNumbers.has(sessionId), false);
  } finally { held.release(); }
  await starting;
  assert.equal(r.launched(), undefined, "the stopped launch constructs no provider");
});

test("a grant to a Full Control session is refused", async (t) => {
  for (const where of ["stored", "live"] as const) {
    const f = fixture(t);
    const g = ungranted(f);
    if (where === "stored") f.store().patchMeta(sessionId, { orchestrator: { strictProjectIsolation: true, control: orderedControl(2) } });
    else g.policy.control = orderedControl(2);
    g.live();
    try {
      const before = JSON.stringify(f.diskMeta().orchestrator);
      const result = await grantIssues(f);
      assert.equal(result.ok, false, where);
      assert.equal(result.grantRefusal, "issue_scope_held", where);
      assert.equal(JSON.stringify(f.diskMeta().orchestrator), before, `${where}: stored launch metadata unchanged`);
      assert.equal(g.policy.issueNumbers, undefined, `${where}: live launch policy unchanged`);
      assert.equal((f.manager() as unknown as GrantRestartInternals).grantedIssueNumbers.has(sessionId), false, where);
    } finally { g.active.delete(sessionId); }
  }
});
