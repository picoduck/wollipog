import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION, type AgentDefinition, type BoxView, type RunnerView } from "@wollipog/protocol";
import {
  filterMachineList,
  groupMachineList,
  machineCapacityLabel,
  machineListEntries,
  machineSortKey,
  machineStatus,
} from "./runners.js";
import { statusMeta } from "./status-meta.js";

/** The Machines list (#2985): one status per machine, sorted by what needs the person. */

function runner(runnerId: string, overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId,
    hostname: `${runnerId}-host`,
    os: "linux",
    version: "1",
    status: "online",
    agents: [],
    workspaces: [],
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: "codex", name: "Codex", command: "codex", args: [], env: {}, available: true, ...overrides } as AgentDefinition;
}

function box(runnerId: string, overrides: Partial<BoxView> = {}): BoxView {
  return { boxId: `box-${runnerId}`, runnerId, sshTarget: `me@${runnerId}`, status: "online", lastError: null, createdAt: 1, ...overrides };
}

test("machineStatus returns Update Required for an outdated runner or a too-old agent", () => {
  assert.equal(machineStatus(runner("a", { protocolVersion: PROTOCOL_VERSION - 1 }), undefined), "update_required");
  assert.equal(machineStatus(runner("a", { agents: [agent({ claudeCode: { status: "unsupported" } as AgentDefinition["claudeCode"] })] }), undefined),
    "update_required");
  assert.equal(machineStatus(runner("a", {
    agents: [agent({ driver: "codex-app-server", codexAppServer: { status: "unsupported" } as AgentDefinition["codexAppServer"] })],
  }), undefined), "update_required");
  // An unknown protocol is not proof of an old runner (`runnerOutdated`).
  assert.equal(machineStatus(runner("a", { protocolVersion: null }), undefined), "online");
});

test("machineStatus returns Approval Required for a Registry agent awaiting approval", () => {
  const registry = { installStatus: "approval-required" } as AgentDefinition["registry"];
  assert.equal(machineStatus(runner("a", { agents: [agent({ registry })] }), undefined), "approval_required");
  assert.equal(statusMeta("machine", "approval_required").label, "Approval Required");
  assert.equal(statusMeta("machine", "approval_required").tone, "warning");
});

test("machineStatus returns Sign-In Required for an agent or an account that needs to sign in", () => {
  assert.equal(machineStatus(runner("a", { agents: [agent({ authStatus: "unauthenticated" })] }), undefined), "sign_in_required");
  assert.equal(machineStatus(runner("a", {
    providerAccounts: [{ id: "work", label: "Work", provider: "claude", authStatus: "unauthenticated" }],
  }), undefined), "sign_in_required");
});

test("machineStatus returns Offline, neutral and hollow, for an offline runner, whatever else it reported", () => {
  const offline = runner("a", { status: "offline", protocolVersion: PROTOCOL_VERSION - 1, agents: [agent({ authStatus: "unauthenticated" })] });
  assert.equal(machineStatus(offline, undefined), "offline");
  const meta = statusMeta("machine", "offline");
  assert.equal(meta.tone, "neutral");
  assert.equal(meta.hollow, true);
});

test("machineStatus ranks the most urgent state first", () => {
  const outdated = runner("a", {
    protocolVersion: PROTOCOL_VERSION - 1,
    agents: [agent({ authStatus: "unauthenticated", registry: { installStatus: "approval-required" } as AgentDefinition["registry"] })],
  });
  assert.equal(machineStatus(outdated, undefined), "update_required");
  assert.equal(machineStatus(outdated, box("a", { status: "failed", lastError: "boom" })), "failed");
  assert.equal(machineStatus(undefined, box("a", { status: "offline", lastError: "Connection timed out" })), "unreachable");
  assert.equal(machineStatus(undefined, box("a", { status: "offline" })), "offline");
  assert.equal(machineStatus(undefined, box("a", { status: "bootstrapping" })), "bootstrapping");
  assert.equal(machineStatus(undefined, box("a", { status: "deploying" })), "deploying");
  assert.equal(machineStatus(undefined, box("a")), "connecting");
  assert.equal(machineStatus(runner("a"), box("a")), "online");
  assert.equal(machineStatus(runner("a", { status: "offline" }), box("a")), "offline");
  // The retired Codex exec row duplicates the App Server's sign-in state; it is never the reason.
  assert.equal(machineStatus(runner("a", { agents: [agent({ driver: "codex", authStatus: "unauthenticated" })] }), undefined), "online");
});

test("machineSortKey puts an offline Zeta before online Alpha and Beta", () => {
  const entries = machineListEntries(new Map([
    ["beta", runner("beta", { displayName: "Beta" })],
    ["zeta", runner("zeta", { displayName: "Zeta", status: "offline" })],
    ["alpha", runner("alpha", { displayName: "Alpha" })],
  ]), []);
  assert.deepEqual(entries.map((entry) => entry.name), ["Zeta", "Alpha", "Beta"]);
  assert.deepEqual(machineSortKey(entries[0]!), [0, 1, "Zeta"]);
  assert.deepEqual(machineSortKey(entries[1]!), [1, 0, "Alpha"]);
});

test("machineSortKey keeps online machines that need the person before offline ones, and Connecting after Online", () => {
  const entries = machineListEntries(new Map([
    ["old", runner("old", { displayName: "Old", protocolVersion: PROTOCOL_VERSION - 1 })],
    ["down", runner("down", { displayName: "Down", status: "offline" })],
    ["fine", runner("fine", { displayName: "Fine" })],
  ]), [box("new", { displayName: "Arriving", status: "bootstrapping" })]);
  assert.deepEqual(entries.map((entry) => entry.name), ["Old", "Down", "Fine", "Arriving"]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["native", "native", "native", "ssh"]);
});

test("every SSH box is one entry, keyed by its runner id, and its runner is not listed again", () => {
  const entries = machineListEntries(new Map([["ssh-1", runner("ssh-1")]]), [box("ssh-1", { displayName: "Build Box" })]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.runnerId, "ssh-1");
  assert.equal(entries[0]!.name, "Build Box");
  assert.equal(entries[0]!.kind, "ssh");
});

test("groups follow Needs Attention, Online and Offline, leaving out empty ones; the filter matches names", () => {
  const entries = machineListEntries(new Map([
    ["old", runner("old", { displayName: "Old", protocolVersion: PROTOCOL_VERSION - 1 })],
    ["down", runner("down", { displayName: "Down", status: "offline" })],
    ["fine", runner("fine", { displayName: "Fine" })],
  ]), [box("new", { displayName: "Arriving", status: "bootstrapping" })]);
  assert.deepEqual(groupMachineList(entries).map((group) => [group.label, group.entries.map((entry) => entry.name)]), [
    ["Needs Attention", ["Old"]],
    ["Online", ["Fine", "Arriving"]],
    ["Offline", ["Down"]],
  ]);
  assert.deepEqual(filterMachineList(entries, "  iN ").map((entry) => entry.name), ["Fine", "Arriving"]);
  assert.deepEqual(groupMachineList(filterMachineList(entries, "down")).map((group) => group.label), ["Offline"]);
});

test("capacity reads as units used of configured, or configured alone", () => {
  assert.equal(machineCapacityLabel({ usedUnits: 29, configuredUnits: 40 }), "29 of 40 Units");
  assert.equal(machineCapacityLabel({ configuredUnits: 40 }), "40 Units");
  const [entry] = machineListEntries(new Map([["a", runner("a")]]), []);
  assert.equal(entry!.capacity, null);
});
