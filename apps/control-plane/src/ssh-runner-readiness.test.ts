import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { PROTOCOL_VERSION, type AgentDefinition } from "@wollipog/protocol";
import { BoxOrchestrator, stopAndWaitForManagedChild } from "./box-orchestrator.js";
import { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";

const agent: AgentDefinition = { id: "codex", name: "Codex", command: "codex", args: [], env: {}, available: true };

test("SSH replacement requires fresh discovery, reports regressions, and recovers without replacing the tunnel", t => {
  const db = ControlPlaneDb.open(":memory:");
  const metadata = { runnerId: "runner", hostname: "host", os: "linux" as const, version: "test", agents: [agent], workspaces: [] };
  db.createBox({ boxId: "box-0123abcd", runnerId: "runner", sshTarget: "user@host", sshPort: 22,
    workspaces: [], autoReconnect: false, runnerDataDir: ".agent-manager/runner-data/box-0123abcd", now: 3 });
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  db.updateRunnerAgents("runner", [agent], 2);
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false,
    kill() { this.killed = true; return true; } }) as unknown as ChildProcess;
  const logs: string[] = [];
  const orchestrator = new BoxOrchestrator({ db, hub: { boxChanged() {} } as unknown as Hub, cpPort: 4317,
    issueCredential: () => { throw new Error("unexpected bootstrap"); },
    resolveBinary: async () => { throw new Error("unexpected bootstrap"); }, spawnTunnel: () => child,
    log: line => logs.push(line),
  });
  t.after(() => { orchestrator.shutdown(); db.close(); });
  const internal = orchestrator as unknown as {
    runtimeFor(id: string): { activeCredentialId: string };
    launch(cfg: unknown, runtime: unknown, epoch: number, token: string, adoption: null, path: string): void;
  };
  const rt = internal.runtimeFor("box-0123abcd");
  rt.activeCredentialId = "current";
  internal.launch(db.getBoxConfig("box-0123abcd"), rt, 0, "credential-file", null, "runner");
  db.registerRunner(metadata, 4, PROTOCOL_VERSION);
  orchestrator.onRunnerRegistered("runner", "stale");
  assert.notEqual(db.getBox("box-0123abcd")?.status, "online");
  orchestrator.onRunnerRegistered("runner", "current");
  assert.notEqual(db.getBox("box-0123abcd")?.status, "online", "registration is not discovery");
  db.updateRunnerAgents("runner", [{ ...agent, available: false, unavailableReason: "Provider HOME ownership blocked discovery." }], 5);
  orchestrator.onRunnerAgentsUpdated("runner");
  assert.equal(db.getBox("box-0123abcd")?.status, "failed");
  assert.match(db.getBox("box-0123abcd")?.lastError ?? "", /Provider HOME ownership/);
  assert.equal(child.killed, false);
  db.updateRunnerAgents("runner", [], 6);
  orchestrator.onRunnerAgentsUpdated("runner");
  assert.match(db.getBox("box-0123abcd")?.lastError ?? "", /previously available harness/);
  db.updateRunnerAgents("runner", [agent], 7);
  orchestrator.onRunnerAgentsUpdated("runner");
  assert.equal(db.getBox("box-0123abcd")?.status, "online");
  assert.equal(db.getBox("box-0123abcd")?.lastError, null);
  assert.ok(logs.some(line => line.includes('"event":"ssh_runner_readiness"')));
  const account = { id: "work", label: "Work", provider: "codex" as const, authStatus: "authenticated" as const };
  db.updateRunnerAgents("runner", [agent], 8, undefined, [account]);
  internal.launch(db.getBoxConfig("box-0123abcd"), rt, 0, "credential-file", null, "runner");
  db.registerRunner(metadata, 9, PROTOCOL_VERSION);
  orchestrator.onRunnerRegistered("runner", "current");
  db.updateRunnerAgents("runner", [agent], 10, undefined, [{ ...account, authStatus: "unknown" }]);
  orchestrator.onRunnerAgentsUpdated("runner");
  assert.match(db.getBox("box-0123abcd")?.lastError ?? "", /previously signed-in provider account/);
  db.updateRunnerAgents("runner", [agent], 11, undefined, [account]);
  orchestrator.onRunnerAgentsUpdated("runner");
  assert.equal(db.getBox("box-0123abcd")?.status, "online");
  // A later launch with no inventory must time out, but disconnect supersedes that timeout.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  internal.launch(db.getBoxConfig("box-0123abcd"), rt, 0, "credential-file", null, "runner");
  db.registerRunner(metadata, 12, PROTOCOL_VERSION);
  orchestrator.onRunnerRegistered("runner", "current");
  t.mock.timers.tick(90_000);
  assert.match(db.getBox("box-0123abcd")?.lastError ?? "", /90 seconds/);
  orchestrator.onRunnerDisconnected("runner");
  db.updateRunnerAgents("runner", [agent], 13);
  orchestrator.onRunnerAgentsUpdated("runner");
  assert.notEqual(db.getBox("box-0123abcd")?.status, "online", "an offline inventory cannot clear a readiness failure");
});

test("SSH stop closes stdin and waits for remote drain acknowledgement", async t => {
  const child = spawn(process.execPath, ["-e", `
    process.stdin.resume();
    process.stdin.on('end', () => setTimeout(() => process.exit(0), 40));
  `], { stdio: ["pipe", "ignore", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await stopAndWaitForManagedChild(child, 5_000);
  assert.equal(child.exitCode, 0);
  assert.equal(child.killed, false, "do not kill the transport before remote cleanup acknowledges EOF");
});

test("SSH stop refuses failed or missing remote drain acknowledgement", async t => {
  for (const code of [1, null]) {
    const child = spawn(process.execPath, ["-e", code === null ? "setInterval(() => {}, 1000)" : `
      process.stdin.resume(); process.stdin.on('end', () => process.exit(1));
    `], { stdio: ["pipe", "ignore", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    await assert.rejects(stopAndWaitForManagedChild(child, code === null ? 50 : 5_000), /acknowledged|acknowledge/);
  }
});
