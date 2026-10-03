import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, type AgentDriverKind, type PrepareSessionRoleMessage, type RunnerToControlPlane } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore, metaToSnapshot } from "./session-store.js";
import { provisionAgentControl, removeAgentControlFiles } from "./agent-control.js";
import { provisionClaudeHooks, removeClaudeHookFiles } from "./hook-settings.js";
import { ORCHESTRATOR_ENV_KEY } from "./orchestrator-preset.js";
import { PI_AGENT_CONTROL_PROTOCOL } from "./pi-agent-control-extension.js";

function fixture(driver: AgentDriverKind = "codex-app-server", close?: () => Promise<void>, provisioned = false) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-role-"));
  const store = new SessionStore(join(root, "sessions"));
  const messages: RunnerToControlPlane[] = [];
  const launches: Array<{ resumeId?: string; orchestrator?: unknown; config?: unknown; args?: string[]; env?: Record<string, string>; artifactGuidance?: string }> = [];
  const registrations: { control: string[]; hooks: string[] } = { control: [], hooks: [] };
  const controlDir = join(root, "control");
  const hookDir = join(root, "hooks");
  const localLaunch = { command: "agent", args: ["user-arg"], env: {} };
  let disposed = 0;
  const manager = new SessionManager((message) => messages.push(message), () => {}, store, "r", () => localLaunch,
    ((_driver: unknown, opts: { resumeId?: string; orchestrator?: unknown; config?: unknown; args: string[]; env: Record<string, string>; artifactGuidance?: string }) => {
      launches.push({ resumeId: opts.resumeId, orchestrator: opts.orchestrator, config: opts.config, args: [...opts.args], env: { ...opts.env }, artifactGuidance: opts.artifactGuidance });
      return {
        pid: 1000 + launches.length, initialize: async () => {}, newSession: async () => {},
        prompt: async () => "end_turn", cancel() {}, dispose() { disposed++; }, setConfig: async () => {},
        resolvePermission: () => false, agentSessionId: () => "same-provider-conversation",
        ...(close ? { close } : {}),
      };
    }) as never, root, 1,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [],
    provisioned ? async (meta) => {
      provisionClaudeHooks(meta, { controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION,
        enabled: true, executionIsolationMode: "provider", registerCredential: (_id, hash) => registrations.hooks.push(hash),
      }, () => {}, { isSea: true, execPath: "/opt/test-runner", execArgv: [], configDir: hookDir });
      await provisionAgentControl(meta, { controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION,
        executionIsolationMode: "provider", providerRelayEndpoint: "tcp://127.0.0.1:4318",
        registerCredential: (_id, hash) => registrations.control.push(hash),
        orchestratorAgent: { id: "a", name: "Test", command: "agent", args: ["user-arg"], env: {}, driver,
          context: { kind: "native" }, piAgentControl: { protocolVersion: PI_AGENT_CONTROL_PROTOCOL } },
      }, () => {}, { isSea: true, execPath: "/opt/test-runner", execArgv: [], platform: "linux", configDir: controlDir });
    } : undefined);
  (manager as unknown as { controlPlaneProtocolVersion: () => number }).controlPlaneProtocolVersion = () => PROTOCOL_VERSION;
  const spec = { sessionId: "s", workspaceId: "w", workspacePath: root, agentId: "a",
    command: "agent", args: ["user-arg"], env: {}, useWorktree: false, driver,
    capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["auto"], elicitation: { auto: ["hook" as const] }, orchestratorAdditive: true },
    context: { kind: "native" as const }, config: { permissionMode: "auto", model: "model", effort: "high" } };
  const command = (conversionId = "promotion"): PrepareSessionRoleMessage => ({
    type: "prepare_session_role", requestId: `${conversionId}-prepare`, sessionId: "s", conversionId,
    expectedRole: "normal", targetRole: "orchestrator", permissionMode: "auto", command: "agent", args: ["user-arg"],
    ...(driver === "claude-code" ? { claudeMutableSystemPromptFlag: "--system-prompt-recording" as const } : {}),
    orchestrator: { strictProjectIsolation: false, integrationIsolation: false },
  });
  const revoke = () => { removeAgentControlFiles("s", controlDir); removeClaudeHookFiles("s", hookDir); };
  const cleanup = async () => { manager.shutdownAll(); revoke(); rmSync(root, { recursive: true, force: true }); };
  return { manager, store, spec, command, messages, launches, root, registrations, revoke, localLaunch, disposed: () => disposed, cleanup };
}

for (const driver of ["claude-code", "codex", "codex-app-server", "pi"] as const) {
  test(`${driver} real launch provisioning rotates credentials and removes the old role overlay`, async () => {
    const h = fixture(driver, undefined, true);
    try {
      assert.equal(await h.manager.start(h.spec), true);
      h.store.patchMeta("s", { agentSessionId: "same-provider-conversation" });
      const original = h.launches[0]!;
      assert.equal(original.env?.[ORCHESTRATOR_ENV_KEY], undefined);
      assert.equal((await h.manager.prepareSessionRole(h.command(), h.revoke)).ok, true);
      assert.equal(h.manager.commitSessionRole({ type: "commit_session_role", requestId: "commit", sessionId: "s", conversionId: "promotion" }).ok, true);
      assert.equal(h.manager.prompt("s", "Resume as Orchestrator"), true);
      await settle(() => h.launches.length === 2 && h.store.readMeta("s")?.status === "idle");
      assert.equal(h.launches[1]!.env?.[ORCHESTRATOR_ENV_KEY], "orchestrator");
      const demote = { ...h.command("demotion"), expectedRole: "orchestrator" as const, targetRole: "normal" as const, orchestrator: undefined };
      assert.equal((await h.manager.prepareSessionRole(demote, h.revoke)).ok, true);
      assert.equal(h.manager.commitSessionRole({ type: "commit_session_role", requestId: "demote", sessionId: "s", conversionId: "demotion" }).ok, true);
      assert.equal(h.manager.prompt("s", "Resume as Standard"), true);
      await settle(() => h.launches.length === 3 && h.store.readMeta("s")?.status === "idle");
      assert.equal(h.launches[2]!.env?.[ORCHESTRATOR_ENV_KEY], undefined);
      const finalArgs = [...h.launches[2]!.args!];
      if (driver === "claude-code") {
        const recording = finalArgs.indexOf("--system-prompt-recording");
        assert.notEqual(recording, -1);
        assert.equal(finalArgs[recording + 1], "off");
        finalArgs.splice(recording, 2);
      }
      assert.deepEqual(finalArgs, original.args, "the orchestration arguments must not survive demotion");
      assert.equal(h.registrations.control.length, 3);
      assert.equal(new Set(h.registrations.control).size, 3);
      if (driver === "claude-code") {
        assert.equal(h.registrations.hooks.length, 3);
        assert.equal(new Set(h.registrations.hooks).size, 3, "policy hooks must also rotate on both transitions");
      }
    } finally { await h.cleanup(); }
  });
}

for (const driver of ["claude-code", "codex", "codex-app-server", "pi"] as const) {
  test(driver + " refuses protocol201 prepare and commit without retirement or credential mutation", async () => {
    const h = fixture(driver);
    try {
      assert.equal(await h.manager.start(h.spec), true);
      h.store.patchMeta("s", { agentSessionId: "same-provider-conversation" });
      const setPeer = (version: number) => {
        (h.manager as unknown as { controlPlaneProtocolVersion: () => number }).controlPlaneProtocolVersion = () => version;
      };
      setPeer(201);
      let revoked = 0;
      for (const role of ["normal", "orchestrator"] as const) {
        h.store.patchMeta("s", { orchestrator: role === "orchestrator" ? { strictProjectIsolation: false, integrationIsolation: false } : undefined });
        const before = structuredClone(h.store.readMeta("s")!);
        const command = role === "normal" ? h.command() : {
          ...h.command("demotion"), expectedRole: role, targetRole: "normal" as const, orchestrator: undefined,
        };
        assert.equal((await h.manager.prepareSessionRole(command, () => revoked++)).ok, false);
        assert.equal(h.manager.commitSessionRole({ type: "commit_session_role", requestId: "old-commit", sessionId: "s", conversionId: command.conversionId }).ok, false);
        assert.deepEqual(h.store.readMeta("s"), before);
        assert.equal(h.disposed(), 0);
        assert.equal(revoked, 0);
        assert.equal(h.launches.length, 1);
      }
      h.store.patchMeta("s", { orchestrator: undefined });
      setPeer(202);
      assert.equal((await h.manager.prepareSessionRole(h.command(), () => revoked++)).ok, true);
      const prepared = structuredClone(h.store.readMeta("s")!);
      setPeer(201);
      const commit = { type: "commit_session_role" as const, requestId: "commit", sessionId: "s", conversionId: "promotion" };
      assert.equal(h.manager.commitSessionRole(commit).ok, false);
      assert.deepEqual(h.store.readMeta("s"), prepared);
      assert.equal(revoked, 1);
      setPeer(202);
      assert.equal(h.manager.commitSessionRole(commit).ok, true);
    } finally { await h.cleanup(); }
  });
}

async function settle(predicate: () => boolean, diagnostics?: () => string) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), diagnostics?.() ?? "provider turn did not settle");
}

test("an adopted Pi conversation keeps its managed session directory through both role conversions and prompt resumes", async () => {
  const h = fixture("pi");
  try {
    await h.manager.start(h.spec);
    const sessionDir = join(h.root, "managed-pi-copy");
    h.store.patchMeta("s", { agentSessionId: "same-provider-conversation",
      args: [...h.spec.args, "--session-dir", sessionDir],
      adoptedProviderState: { driver: "pi", sessionDir } });
    for (const target of ["orchestrator", "normal"] as const) {
      const command = target === "orchestrator" ? h.command() : {
        ...h.command("demotion"), expectedRole: "orchestrator" as const, targetRole: target, orchestrator: undefined,
      };
      assert.equal((await h.manager.prepareSessionRole(command, h.revoke)).ok, true);
      assert.equal(h.manager.commitSessionRole({ type: "commit_session_role", requestId: "commit", sessionId: "s", conversionId: command.conversionId }).ok, true);
      assert.equal(h.manager.prompt("s", "Continue the adopted conversation"), true);
      const count = target === "orchestrator" ? 2 : 3;
      await settle(() => h.launches.length === count && h.store.readMeta("s")?.status === "idle");
      assert.equal(h.launches[count - 1]!.resumeId, "same-provider-conversation");
      assert.deepEqual(h.launches[count - 1]!.args, ["user-arg", "--session-dir", sessionDir]);
      assert.deepEqual(h.store.readMeta("s")!.adoptedProviderState, { driver: "pi", sessionDir });
    }
  } finally { await h.cleanup(); }
});

test("a reused runner PID cannot attest retirement owned by a previous runner instance", async () => {
  const h = fixture();
  try {
    await h.manager.start(h.spec);
    h.store.patchMeta("s", { agentSessionId: "same-provider-conversation", roleConversion: {
      command: h.command(), state: "retiring", runnerPid: process.pid, runnerOwner: "previous-instance", providerPid: process.pid,
    } });
    const reply = await h.manager.prepareSessionRole(h.command(), () => assert.fail("unconfirmed provider must retain credentials"));
    assert.equal(reply.ok, false);
    assert.equal(reply.pending, true);
    assert.match(reply.error!, /may still be alive/);
    assert.equal(h.disposed(), 0);
  } finally { await h.cleanup(); }
});

test("a live Native TUI blocks retirement and a prepared conversion blocks new TUI opens", async () => {
  const h = fixture();
  try {
    assert.equal(await h.manager.start(h.spec), true);
    h.store.patchMeta("s", { agentSessionId: "same-provider-conversation" });
    let revoked = 0;
    const refused = await h.manager.prepareSessionRole(h.command(), () => revoked++, () => true);
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /Close the Native TUI/);
    assert.equal(h.disposed(), 0);
    assert.equal(revoked, 0);
    assert.equal(h.manager.sessionCanOpen("s"), true);
    assert.equal((await h.manager.prepareSessionRole(h.command(), () => revoked++)).ok, true);
    assert.equal(h.manager.sessionCanOpen("s"), false);
    assert.equal(h.manager.commitSessionRole({ type: "commit_session_role", requestId: "commit", sessionId: "s", conversionId: "promotion" }).ok, true);
    assert.equal(h.manager.sessionCanOpen("s"), true);
  } finally { await h.cleanup(); }
});

test("conversion refuses argv that differs from the runner-local baseline without retiring or weakening permissions", async () => {
  for (const change of ["untrusted", "rediscovery"]) {
    const h = fixture();
    try {
      assert.equal(await h.manager.start(h.spec), true);
      h.store.patchMeta("s", { agentSessionId: "same-provider-conversation" });
      const command = h.command();
      if (change === "untrusted") command.args.push("-c", 'sandbox_mode="danger-full-access"');
      else h.localLaunch.args = ["changed-local-baseline"];
      const before = structuredClone(h.store.readMeta("s"));
      const reply = await h.manager.prepareSessionRole(command, () => assert.fail("credentials revoked on argv refusal"));
      assert.equal(reply.ok, false);
      assert.match(reply.error!, /runner-local configuration/);
      assert.deepEqual(h.store.readMeta("s"), before);
      assert.equal(h.disposed(), 0);
    } finally { await h.cleanup(); }
  }
});

test("a lock-refused retry retains its durable retirement and can finish after the other owner releases it", async () => {
  const h = fixture();
  try {
    assert.equal(await h.manager.start(h.spec), true);
    h.store.patchMeta("s", { agentSessionId: "same-provider-conversation", roleConversion: {
      command: h.command(), state: "retiring", runnerPid: process.pid, providerPid: null,
    } });
    h.store.releaseLock("s", (h.manager as unknown as { lockOwner: string }).lockOwner);
    assert.equal(h.store.acquireLock("s", "other-runner"), true);
    const reply = await h.manager.prepareSessionRole(h.command(), () => assert.fail("credentials revoked without lock ownership"));
    assert.equal(reply.ok, false);
    assert.equal(reply.pending, true);
    assert.equal(h.store.readMeta("s")!.roleConversion!.state, "retiring");
    h.store.releaseLock("s", "other-runner");
    assert.equal((await h.manager.prepareSessionRole(h.command(), h.revoke)).ok, true);
  } finally { await h.cleanup(); }
});

for (const driver of ["claude-code", "codex", "codex-app-server", "pi"] as const) {
  test(`${driver} converts both directions and resumes the exact conversation with unchanged account and worktree`, async () => {
    const h = fixture(driver);
    try {
      assert.equal(await h.manager.start(h.spec), true, JSON.stringify(h.messages));
      const worktree = join(h.root, "linked-worktree");
      execFileSync("git", ["init", "--quiet", h.root]);
      execFileSync("git", ["-C", h.root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "--allow-empty", "-m", "Fixture"]);
      execFileSync("git", ["-C", h.root, "worktree", "add", "--quiet", "-b", "agent/s", worktree]);
      h.store.patchMeta("s", { agentSessionId: "same-provider-conversation", worktreePath: worktree,
        providerAccountId: "account", providerAccountLabel: "Account", providerCredentialHome: h.root,
        providerConversationHome: h.root, roleConversion: undefined, artifactUploads: "wollipog_automatic" });
      h.store.appendEvent("s", { kind: "user_message", text: "History remains" });
      const before = structuredClone(h.store.readMeta("s")!);
      let revoked = 0;
      const prepared = await h.manager.prepareSessionRole(h.command(), () => revoked++);
      assert.equal(prepared.ok, true, prepared.error ?? "preparation failed");
      assert.equal(h.disposed(), 1);
      assert.equal(revoked, 1);
      assert.equal(h.manager.prompt("s", "blocked while prepared"), false);
      assert.equal(await h.manager.start(h.spec), false);
      assert.equal(h.manager.commitSessionRole({ type: "commit_session_role", requestId: "wrong", sessionId: "s", conversionId: "stale" }).ok, false);
      assert.equal(h.manager.commitSessionRole({ type: "commit_session_role", requestId: "commit", sessionId: "s", conversionId: "promotion" }).ok, true);
      const after = h.store.readMeta("s")!;
      for (const key of ["agentSessionId", "providerAccountId", "providerCredentialHome", "providerConversationHome", "worktreePath", "repoPath", "workspaceId", "createdAt", "artifactUploads"] as const) assert.equal(after[key], before[key], key);
      assert.deepEqual(after.config, before.config);
      assert.deepEqual(after.orchestrator, { strictProjectIsolation: false, integrationIsolation: false });
      assert.equal(h.manager.prompt("s", "Continue the same conversation"), true);
      await settle(() => h.launches.length === 2 && h.store.readMeta("s")?.status === "idle", () => JSON.stringify(h.messages));
      assert.equal(h.launches[1]!.resumeId, "same-provider-conversation");
      assert.ok(h.launches[1]!.orchestrator);
      assert.match(h.launches[1]!.artifactGuidance!, /Artifact Uploads: Use Wollipog Automatically/);
      const demote = { ...h.command("demotion"), expectedRole: "orchestrator" as const, targetRole: "normal" as const, orchestrator: undefined };
      const demotion = await h.manager.prepareSessionRole(demote, () => revoked++);
      assert.equal(demotion.ok, true, demotion.error ?? "demotion failed");
      assert.equal(h.manager.commitSessionRole({ type: "commit_session_role", requestId: "demote", sessionId: "s", conversionId: "demotion" }).ok, true);
      assert.equal(h.store.readMeta("s")!.orchestrator, undefined);
      assert.equal(h.manager.prompt("s", "Continue as Standard"), true);
      await settle(() => h.launches.length === 3 && h.store.readMeta("s")?.status === "idle");
      assert.equal(h.launches[2]!.resumeId, "same-provider-conversation");
      assert.equal(h.launches[2]!.orchestrator, undefined);
      assert.equal(h.store.readMeta("s")!.artifactUploads, "wollipog_automatic");
      assert.match(h.launches[2]!.artifactGuidance!, /Artifact Uploads: Use Wollipog Automatically/);
      assert.equal(revoked, 2);
      assert.ok(h.store.readEvents("s").some((event) => event.payload.kind === "user_message" && event.payload.text === "History remains"));
    } finally { await h.cleanup(); }
  });
}

test("retirement must confirm before credential revocation or prepared receipt; submission stays fenced", async () => {
  let release!: () => void;
  const close = new Promise<void>((resolve) => { release = resolve; });
  const h = fixture("codex-app-server", () => close);
  try {
    await h.manager.start(h.spec);
    h.store.patchMeta("s", { agentSessionId: "same-provider-conversation" });
    // A resident driver may have no PID. Only an absent provider is the explicit null proof.
    (h.manager as unknown as { active: Map<string, { client: { pid?: number } }> }).active.get("s")!.client.pid = undefined;
    let revoked = 0;
    const pending = h.manager.prepareSessionRole(h.command(), () => revoked++);
    await settle(() => h.store.readMeta("s")?.roleConversion?.state === "retiring");
    assert.equal(h.store.readMeta("s")!.roleConversion!.providerPid, undefined);
    assert.equal(revoked, 0);
    assert.equal(metaToSnapshot(h.store.readMeta("s")!).roleConversionReceipt, undefined);
    assert.equal(h.manager.prompt("s", "must not run"), false);
    const duplicate = h.manager.prepareSessionRole({ ...h.command(), requestId: "duplicate" }, () => revoked++);
    assert.equal(await h.manager.start(h.spec), false);
    await assert.rejects(h.manager.selectWorktree("s", h.root), /role change/);
    release();
    assert.equal((await pending).ok, true);
    assert.equal((await duplicate).requestId, "duplicate");
    assert.equal(revoked, 1);
    assert.deepEqual(metaToSnapshot(h.store.readMeta("s")!).roleConversionReceipt, { conversionId: "promotion", state: "prepared" });
    assert.equal(metaToSnapshot(h.store.readMeta("s")!, 197).roleConversionReceipt, undefined);
  } finally { release(); await h.cleanup(); }
});

test("a concurrent Stop safely abandons an unprepared conversion after retirement", async () => {
  let release!: () => void;
  const close = new Promise<void>((resolve) => { release = resolve; });
  const h = fixture("codex-app-server", () => close);
  try {
    await h.manager.start(h.spec);
    h.store.patchMeta("s", { agentSessionId: "same-provider-conversation" });
    const pending = h.manager.prepareSessionRole(h.command(), () => assert.fail("an abandoned role change must not rotate credentials"));
    await settle(() => h.store.readMeta("s")?.roleConversion?.state === "retiring");
    h.store.patchMeta("s", { status: "stopped" });
    release();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.pending, undefined);
    assert.equal(h.store.readMeta("s")!.roleConversion, undefined);
    assert.equal(h.store.readMeta("s")!.orchestrator, undefined);
  } finally { release(); await h.cleanup(); }
});

test("a restarted runner cannot attest retirement while the old provider may still be alive", async () => {
  for (const providerPid of [process.pid, undefined]) {
    const h = fixture();
    try {
      await h.manager.start(h.spec);
      h.store.patchMeta("s", { agentSessionId: "same-provider-conversation", roleConversion: {
        command: h.command(), state: "retiring", runnerPid: -1, providerPid,
      } });
      const result = await h.manager.prepareSessionRole(h.command(), () => assert.fail("unconfirmed retirement revoked credentials"));
      assert.equal(result.pending, true);
      assert.match(result.error!, /may still be alive/);
      assert.equal(h.disposed(), 0);
      assert.equal(h.store.readMeta("s")!.roleConversion!.state, "retiring");
      const before = h.store.readMeta("s")!.orchestrator;
      h.manager.stop("s");
      const cancelled = await h.manager.prepareSessionRole(h.command(), () => assert.fail("cancellation must preserve the original credentials"));
      assert.equal(cancelled.ok, false);
      assert.equal(cancelled.pending, undefined);
      assert.equal(h.store.readMeta("s")!.roleConversion, undefined);
      assert.equal(h.store.readMeta("s")!.orchestrator, before);
    } finally { await h.cleanup(); }
  }
});

test("a provider already closing refuses fresh conversion without recording an absent provider", async () => {
  let release!: () => void;
  const close = new Promise<void>((resolve) => { release = resolve; });
  const h = fixture("codex-app-server", () => close);
  try {
    assert.equal(await h.manager.start(h.spec), true);
    h.store.patchMeta("s", { agentSessionId: "same-provider-conversation" });
    h.manager.stop("s");
    // Parking can leave an idle row while the managed provider's close is still outstanding.
    h.store.patchMeta("s", { status: "idle" });
    const reply = await h.manager.prepareSessionRole(h.command(), () => assert.fail("a closing provider must not rotate credentials"));
    assert.equal(reply.ok, false);
    assert.equal(reply.pending, undefined);
    assert.match(reply.error!, /finish closing/);
    assert.equal(h.store.readMeta("s")!.roleConversion, undefined);
  } finally { release(); await h.cleanup(); }
});

test("prepared conversion survives runner reload and duplicate prepare/commit is idempotent", async () => {
  const h = fixture();
  try {
    await h.manager.start(h.spec);
    h.store.patchMeta("s", { agentSessionId: "same-provider-conversation" });
    let revoked = 0;
    assert.equal((await h.manager.prepareSessionRole(h.command(), () => revoked++)).ok, true);
    assert.equal((await h.manager.prepareSessionRole(h.command(), () => revoked++)).ok, true);
    const loaded = new SessionStore(join(h.root, "sessions"));
    assert.equal(loaded.readMeta("s")!.roleConversion!.state, "prepared");
    assert.equal(loaded.readMeta("s")!.agentSessionId, "same-provider-conversation");
    const commit = { type: "commit_session_role" as const, requestId: "commit", sessionId: "s", conversionId: "promotion" };
    assert.equal(h.manager.commitSessionRole(commit).ok, true);
    assert.equal(h.manager.commitSessionRole(commit).ok, true);
    assert.equal(revoked, 1);
  } finally { await h.cleanup(); }
});

test("busy, pending, incompatible, and nonresumable sessions refuse before retirement", async () => {
  for (const patch of [
    { status: "running" as const },
    { agentSessionId: null },
    { config: { permissionMode: "orchestrator" } },
    { context: { kind: "wsl" as const, distro: "Linux" } },
    { pendingProviderAccountId: "another-account" },
    { adoptedProviderState: { driver: "pi", sessionDir: "/managed-copy", cleanupContext: { kind: "native" } } },
    { backgroundJobs: [{ id: "job", launchType: "shell", source: "provider", status: "running", startedAt: 1 }] },
  ]) {
    const h = fixture();
    try {
      await h.manager.start(h.spec);
      h.store.patchMeta("s", { agentSessionId: "same-provider-conversation", ...patch } as never);
      const result = await h.manager.prepareSessionRole(h.command(), () => assert.fail("credentials revoked on refusal"));
      assert.equal(result.ok, false, JSON.stringify(patch));
      assert.equal(h.store.readMeta("s")!.roleConversion, undefined);
      assert.equal(h.disposed(), 0);
    } finally { await h.cleanup(); }
  }
});
