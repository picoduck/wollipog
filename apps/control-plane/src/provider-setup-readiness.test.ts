import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";

test("provider setup reports are versioned and persisted without arbitrary peer fields", (t) => {
  const db = ControlPlaneDb.open(":memory:");
  t.after(() => db.close());
  const report = { checkedAt: 123, installation: "compatible" as const, authentication: "unknown" as const, reason: "in_use" as const };
  const metadata = { runnerId: "runner", hostname: "host", os: "linux" as const, version: "test", workspaces: [],
    agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server" as const,
      available: false, authStatus: "unknown" as const, providerReadiness: { ...report, credential: "must not cross" } }],
    providerAccounts: [{ id: "work", label: "Work", provider: "codex" as const, authStatus: "unknown" as const,
      providerReadiness: { ...report, credential: "must not cross" } }],
  };
  db.registerRunner(metadata, 1, 356);
  assert.equal(db.getRunner("runner")?.agents[0]?.providerReadiness, undefined);
  assert.equal(db.getRunner("runner")?.providerAccounts?.[0]?.providerReadiness, undefined);
  db.registerRunner(metadata, 2, PROTOCOL_VERSION);
  assert.deepEqual(db.getRunner("runner")?.agents[0]?.providerReadiness, report);
  assert.deepEqual(db.getRunner("runner")?.providerAccounts?.[0]?.providerReadiness, report);
  db.updateRunnerAgents("runner", [{ ...metadata.agents[0]!, providerReadiness: { ...report, reason: "sign_in_required" } }], 3);
  assert.equal(db.getRunner("runner")?.agents[0]?.providerReadiness, undefined, "unknown authentication cannot be mislabeled signed out");
});
