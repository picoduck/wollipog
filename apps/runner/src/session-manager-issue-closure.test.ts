import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { CampaignIssueScopeMessage, ExecutionTargetRef, HostExecutionTargetRefusalReason, GithubIssueClosureSnapshot } from "@wollipog/protocol";
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
    manager: () => manager, store: () => store, mutations: () => commands.filter((command) => command.file === "gh" && command.args[0] === "issue") };
}

const digest = (snapshot: GithubIssueClosureSnapshot) => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

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
