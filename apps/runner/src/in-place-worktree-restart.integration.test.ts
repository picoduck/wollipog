import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToRunner,
  type RunnerMetadata,
  type RunnerToControlPlane,
  type SessionLaunchSpec,
  type SessionWorktreeResultMessage,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "../../control-plane/src/db.js";
import type { Hub } from "../../control-plane/src/hub.js";
import { SessionsService } from "../../control-plane/src/sessions.js";
import type { DriverOptions } from "./drivers/driver.js";
import { validateHostExecutionTarget } from "./execution-target.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

/**
 * An ordinary in-place session that later gains a runner-owned session worktree, restarted — the
 * exact sequence of issue #1304, with no Orchestrator anywhere in it.
 *
 * Both halves are real and consume each other's own output: the REAL control-plane `SessionsService`
 * builds the restart spec, and the REAL runner `SessionManager` receives that spec and decides
 * where the provider runs. Only the provider process itself is a stub, so the launch directory it
 * records is the runner's own decision.
 *
 * The regression it guards: the runner derives the expected execution target from `useWorktree`
 * (`apps/runner/src/execution-target.ts`), which the session snapshot flips to true the moment a
 * session worktree is selected. Pairing that with the creation-time in-place target made the runner
 * refuse the launch outright — first for the target identity, then for the filesystem boundary.
 */

const RUNNER_ID = "runner-restart";
const WORKSPACE_ID = "ws-restart";
const AGENT_ID = "claude";

/** No developer signing, hook, or template configuration may run in this fixture. */
const HERMETIC_GIT = ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.templateDir="];

function git(args: string[]): string {
  return execFileSync("git", [...HERMETIC_GIT, ...args], { encoding: "utf8" });
}

function runnerMeta(workspacePath: string): RunnerMetadata {
  return {
    runnerId: RUNNER_ID,
    hostname: "host",
    os: "linux",
    version: "1.0.0",
    workspaces: [{ id: WORKSPACE_ID, name: "Demo", path: workspacePath }],
    agents: [{
      id: AGENT_ID,
      name: "Claude",
      command: "claude",
      args: [],
      env: {},
      driver: "claude-code",
      available: true,
      context: { kind: "native" },
      version: "2.1.0",
    }],
  };
}

/**
 * Recording stand-in for the connection Hub. `requestFromRunner` dispatches the one runner request
 * this scenario uses into the real SessionManager, mirroring the `session_worktree` case of the
 * runner message switch in `apps/runner/src/index.ts`.
 */
class RecordingHub {
  sent: ControlPlaneToRunner[] = [];
  manager?: SessionManager;

  isRunnerOnline(): boolean { return true; }
  sendToRunner(_runnerId: string, msg: ControlPlaneToRunner): boolean {
    this.sent.push(msg);
    return true;
  }

  async requestFromRunner(
    _runnerId: string,
    _requestId: string,
    msg: ControlPlaneToRunner,
  ): Promise<SessionWorktreeResultMessage> {
    this.sent.push(msg);
    if (msg.type !== "session_worktree" || msg.operation !== "create") {
      throw new Error(`unexpected runner request ${msg.type}`);
    }
    const result = await this.manager!.requestWorktree(msg.sessionId, {
      branch: msg.branch,
      ...(msg.baseRef ? { baseRef: msg.baseRef } : {}),
    });
    return {
      type: "session_worktree_result",
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      operation: "create",
      ok: true,
      snapshot: result.snapshot,
      worktree: result.worktree,
    };
  }

  async waitForRunnerRequest(): Promise<never> { throw new Error("runner request is no longer in flight"); }
  resolveRunnerRequest(): boolean { return false; }
  activeTurnIdForSession(): string | undefined { return undefined; }
  queuedPromptForSession(): undefined { return undefined; }
  setSessionQueue(): void {}
  sessionChanged(): void {}
  sessionChangedById(): void {}
  sessionReminderChanged(): void {}
  sessionReminderRemoved(): void {}
  sessionEvent(): void {}
  sessionEventsReset(): void {}
  sessionRemoved(): void {}
  runChanged(): void {}
  podChanged(): void {}
  podContextEntry(): void {}
  projectChanged(): void {}
  projectChangedById(): void {}
  runnerChanged(): void {}

  sentOfType<T extends ControlPlaneToRunner["type"]>(type: T): Extract<ControlPlaneToRunner, { type: T }>[] {
    return this.sent.filter((msg): msg is Extract<ControlPlaneToRunner, { type: T }> => msg.type === type);
  }
}

test("an in-place session that gains a worktree restarts into it, and a worktree session is unaffected", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-inplace-worktree-restart-"));
  const repo = join(root, "repo");
  const runnerData = join(root, "runner-data");
  const db = ControlPlaneDb.open(":memory:");
  const priorGitConfig = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };
  // Also applies to the product git calls the runner makes below: ambient user/system config
  // (signing, hooks, templates) must not participate in this scenario.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  let manager: SessionManager | undefined;
  try {
    git(["init", "-q", "-b", "main", repo]);
    git(["-C", repo, "config", "user.email", "test@example.com"]);
    git(["-C", repo, "config", "user.name", "Test"]);
    git(["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"]);

    // ------------------------------------------------------------------ the runner side, for real
    const launches: { sessionId: string; cwd: string }[] = [];
    const store = new SessionStore(join(root, "sessions"));
    const driverFactory = (_kind: unknown, opts: DriverOptions) => {
      launches.push({ sessionId: opts.env.WOLLIPOG_SESSION_ID ?? "unknown", cwd: opts.cwd });
      return {
        pid: 1,
        initialize: async () => {},
        newSession: async () => "provider-conversation",
        prompt: async () => ({ stopReason: "end_turn" as const }),
        cancel: () => {},
        dispose: () => {},
        setConfig: () => {},
        resolvePermission: () => false,
        // A resumable conversation is what lets a live provider follow a newly selected worktree,
        // exactly as a real `claude` session does once its stream has opened.
        agentSessionId: () => "provider-conversation",
      };
    };
    const runnerSent: RunnerToControlPlane[] = [];
    let svc: SessionsService | undefined;
    // The runner's outbound messages travel back into the control plane exactly as the /runner
    // socket handler in apps/control-plane/src/index.ts routes them.
    const relay = (message: RunnerToControlPlane): void => {
      runnerSent.push(message);
      if (!svc) return;
      if (message.type === "session_status") {
        svc.onSessionStatus(message.sessionId, message.status, message.detail, message.worktreePath,
          RUNNER_ID, message.controlPlaneLaunchId, message.capacityWait);
      } else if (message.type === "session_event") {
        svc.onSessionEvent(message.sessionId, message.payload, message.seq, message.ts, RUNNER_ID);
      } else if (message.type === "session_runtime_updated") {
        svc.applySessionRuntimeUpdate(RUNNER_ID, message.snapshot);
      }
    };
    manager = new SessionManager(
      relay, () => {}, store, RUNNER_ID, undefined, driverFactory as never, runnerData, 4,
    );

    const hub = new RecordingHub();
    hub.manager = manager;
    db.registerRunner(runnerMeta(repo), Date.now(), PROTOCOL_VERSION);
    svc = new SessionsService(db, hub as unknown as Hub, { info() {}, warn() {}, error() {} });
    const service = svc;

    const hostTargetId = (strategy: "in_place" | "worktree"): string =>
      `runner:${encodeURIComponent(RUNNER_ID)}:host:${strategy}`;
    /** Deliver a control-plane launch the way the runner's `start_session` case does. */
    const deliver = async (sessionId: string): Promise<SessionLaunchSpec> => {
      const message = hub.sentOfType("start_session").filter((msg) => msg.spec.sessionId === sessionId).at(-1);
      assert.ok(message, `the control plane sent a launch for ${sessionId}`);
      const spec: SessionLaunchSpec = structuredClone(message.spec);
      assert.equal(await manager!.start(spec), true,
        `the runner accepted the launch for ${sessionId}: ${
          store.readEvents(sessionId).filter((entry) => entry.payload.kind === "error")
            .map((entry) => entry.payload.kind === "error" ? entry.payload.message : "").join("; ")}`);
      return spec;
    };
    /** The two hops the worktree route performs below Fastify: ask the runner, apply its snapshot. */
    const createWorktree = async (sessionId: string, branch: string): Promise<string> => {
      const result = await hub.requestFromRunner(RUNNER_ID, `req-${sessionId}`, {
        type: "session_worktree", operation: "create", requestId: `req-${sessionId}`,
        sessionId, branch, baseRef: "main",
      });
      assert.equal(result.ok, true, result.error ?? "worktree creation failed");
      db.updateSessionFromSnapshot(sessionId, result.snapshot!, Date.now());
      return result.worktree!.path;
    };

    // --------------------------------------------- 1. an ordinary session, Worktree mode off
    const created = service.createSession(
      { runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID, useWorktree: false },
      undefined, undefined, false, false, false, { defaultOwnerUserId: "human" },
    );
    assert.ok(created.ok && created.data, created.error ?? "session creation failed");
    const session = created.data;
    assert.equal(session.useWorktree, false);
    assert.equal(session.executionTarget?.id, hostTargetId("in_place"),
      "creation records the in-place placement it was launched with");

    const firstSpec = await deliver(session.id);
    assert.equal(firstSpec.executionTarget?.workspaceStrategy, "in_place");
    assert.equal(launches.at(-1)?.cwd, repo, "the first launch runs in the workspace itself");

    // ----------------------------------- 2. the session gains a runner-owned session worktree
    const worktreePath = await createWorktree(session.id, `agent/${session.id}-work`);
    const adopted = db.getSession(session.id)!;
    assert.equal(adopted.worktreePath, worktreePath, "the control plane sees the selected worktree");
    assert.equal(adopted.useWorktree, true,
      "the runner snapshot reports the session as using a worktree once one is selected");
    assert.equal(adopted.executionTarget?.id, hostTargetId("in_place"),
      "the stored target still names the creation-time placement — the divergence this fix reconciles");
    // The runner's own validator, on the exact pair a restart used to send. Both refusals the issue
    // reports come from here, so this is what reconciliation has to clear.
    const ISOLATION = { mode: "provider", network: "inherit" } as const;
    assert.match(validateHostExecutionTarget(adopted.executionTarget, RUNNER_ID, true, ISOLATION) ?? "",
      /execution target does not belong to this runner/,
      "the creation-time target paired with the session's current strategy is what the runner rejects");
    assert.match(validateHostExecutionTarget(
      { ...adopted.executionTarget!, id: hostTargetId("worktree"), workspaceStrategy: "worktree" },
      RUNNER_ID, true, ISOLATION) ?? "",
    /filesystem boundary conflicts with the launch/,
    "correcting only the identity and strategy leaves the second refusal the issue reports");

    // ------------------------------------------------ 3. restart, the step that used to fail
    const restarted = service.restart(session.id);
    assert.ok(restarted.ok, restarted.error ?? "restart was refused");
    const restartSpec = hub.sentOfType("start_session").filter((msg) => msg.spec.sessionId === session.id).at(-1)!.spec;
    assert.equal(restartSpec.useWorktree, true);
    assert.equal(restartSpec.executionTarget?.id, hostTargetId("worktree"),
      "the launch carries the placement that matches the session's current workspace strategy");
    assert.equal(restartSpec.executionTarget?.workspaceStrategy, "worktree");
    assert.equal(restartSpec.executionTarget?.boundaries.filesystem, "worktree",
      "the filesystem boundary the runner checks matches the launch too");
    assert.equal(validateHostExecutionTarget(
      restartSpec.executionTarget, RUNNER_ID, restartSpec.useWorktree, ISOLATION), null,
    "the reconciled pair clears the runner validator that produced both refusals");
    assert.equal(db.getSession(session.id)?.executionTarget?.id, hostTargetId("worktree"),
      "the session view stops advertising the placement this launch replaced");

    const launchesBeforeRestart = launches.length;
    await deliver(session.id);
    assert.equal(launches.length, launchesBeforeRestart + 1, "the restart reached a provider launch");
    assert.equal(launches.at(-1)?.cwd, worktreePath, "the restarted session runs in its selected worktree");
    assert.equal(
      runnerSent.some((message) => message.type === "session_status" &&
        message.sessionId === session.id && message.status === "failed"),
      false,
      "the runner never refused a launch for this session",
    );
    assert.equal(store.readMeta(session.id)?.worktreePath, worktreePath,
      "the restart reattached the existing worktree rather than materializing another");

    // ------------------------------- 4. a session created with Worktree mode on is unaffected
    const isolated = service.createSession(
      { runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID, useWorktree: true },
      undefined, undefined, false, false, false, { defaultOwnerUserId: "human" },
    );
    assert.ok(isolated.ok && isolated.data, isolated.error ?? "session creation failed");
    const isolatedSession = isolated.data;
    assert.equal(isolatedSession.executionTarget?.id, hostTargetId("worktree"));
    const isolatedSpec = await deliver(isolatedSession.id);
    assert.equal(isolatedSpec.executionTarget?.id, hostTargetId("worktree"));
    const automaticWorktree = launches.at(-1)!.cwd;
    assert.notEqual(automaticWorktree, repo, "Worktree mode on launches outside the shared checkout");

    const isolatedRestart = service.restart(isolatedSession.id);
    assert.ok(isolatedRestart.ok, isolatedRestart.error ?? "restart was refused");
    const isolatedRestartSpec = hub.sentOfType("start_session")
      .filter((msg) => msg.spec.sessionId === isolatedSession.id).at(-1)!.spec;
    assert.deepEqual(isolatedRestartSpec.executionTarget, isolatedSpec.executionTarget,
      "an unchanged workspace strategy restarts on the exact placement it was created with");
    await deliver(isolatedSession.id);
    assert.equal(launches.at(-1)?.cwd, automaticWorktree,
      "the isolated session restarts into the same worktree");

    await manager.delete(session.id);
    await manager.delete(isolatedSession.id);
  } finally {
    manager?.shutdownAll();
    db.close();
    if (priorGitConfig.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = priorGitConfig.global;
    if (priorGitConfig.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = priorGitConfig.system;
    rmSync(root, { recursive: true, force: true });
  }
});
