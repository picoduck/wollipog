import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PROTOCOL_VERSION, providerCommandHomeWriteSeparationReport,
  type AgentDefinition, type RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";

test("disclosure survives registration, discovery updates and reopen; older reconnect clears it to unknown", () => {
  const root = mkdtempSync(join(tmpdir(), "command-home-db-"));
  const location = join(root, "state.db");
  let db = ControlPlaneDb.open(location);
  const agent: AgentDefinition = { id: "fixture", name: "Fixture", command: "inert", args: [], env: {}, driver: "acp",
    providerAccountReadiness: { defaultAuthStatus: "unknown", readyAccountIds: [] },
    providerReadiness: { checkedAt: 123, installation: "compatible", installationAdmission: "permitted", authentication: "unknown", reason: "in_use" },
    providerCommandHomeWriteSeparation: { version: 1, status: "unprotected", reason: "incomplete_adapter_coverage" } };
  const metadata: RunnerMetadata = { runnerId: "runner", hostname: "Fixture", os: "linux", version: "fixture",
    agents: [agent], workspaces: [] };
  try {
    db.registerRunner(metadata, 1, PROTOCOL_VERSION);
    assert.deepEqual(db.getRunner("runner")?.agents[0]?.providerCommandHomeWriteSeparation, agent.providerCommandHomeWriteSeparation);
    assert.deepEqual(db.getRunner("runner")?.agents[0]?.providerReadiness, agent.providerReadiness,
      "both independently validated discovery reports survive the same SQL insert");
    const updated = { ...agent, providerCommandHomeWriteSeparation: {
      version: 1 as const, status: "unavailable" as const, reason: "unsupported_host" as const } };
    db.updateRunnerAgents("runner", [updated], 2);
    db.close(); db = ControlPlaneDb.open(location);
    assert.deepEqual(db.listRunners()[0]?.agents[0]?.providerCommandHomeWriteSeparation, updated.providerCommandHomeWriteSeparation);
    assert.deepEqual(db.getRunner("runner")?.agents[0]?.providerAccountReadiness, agent.providerAccountReadiness);
    assert.deepEqual(db.getRunner("runner")?.agents[0]?.providerReadiness, agent.providerReadiness);
    const { providerCommandHomeWriteSeparation: _report, ...older } = agent;
    db.registerRunner({ ...metadata, agents: [older] }, 3, 356);
    assert.deepEqual(providerCommandHomeWriteSeparationReport(db.getRunner("runner")?.agents[0]?.providerCommandHomeWriteSeparation),
      { status: "unknown", reason: "report_unavailable" });
    const malformed = { ...agent, providerCommandHomeWriteSeparation: {
      version: 1, status: "protected", reason: "SECRET-invalid", diagnostic: "SECRET-extra" } } as unknown as AgentDefinition;
    db.updateRunnerAgents("runner", [malformed], 4);
    assert.equal(db.getRunner("runner")?.agents[0]?.providerCommandHomeWriteSeparation, undefined);
    assert.doesNotMatch(JSON.stringify(db.getRunner("runner")), /SECRET/);
    db.registerRunner(metadata, 5, PROTOCOL_VERSION);
    db.close();
    const olderSchema = new DatabaseSync(location);
    olderSchema.exec("ALTER TABLE runner_agents DROP COLUMN provider_command_home_write_separation");
    olderSchema.close();
    db = ControlPlaneDb.open(location);
    assert.equal(db.getRunner("runner")?.agents[0]?.providerCommandHomeWriteSeparation, undefined,
      "additive migration of an older database does not invent a report");
    assert.deepEqual(db.getRunner("runner")?.agents[0]?.providerReadiness, agent.providerReadiness,
      "migrating the independent disclosure column preserves the readiness report");
    db.updateRunnerAgents("runner", [agent], 6);
    assert.deepEqual(db.getRunner("runner")?.agents[0]?.providerCommandHomeWriteSeparation, agent.providerCommandHomeWriteSeparation);
    assert.deepEqual(db.getRunner("runner")?.agents[0]?.providerReadiness, agent.providerReadiness);
  } finally {
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
