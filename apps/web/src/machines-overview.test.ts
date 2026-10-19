import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION, type AgentDefinition, type BoxView, type RunnerView, type SessionView } from "@wollipog/protocol";
import {
  machineCapacityMeterLabel,
  machinesOverviewAttention,
  machinesOverviewCapacity,
  machinesOverviewSummary,
} from "./machines-overview.js";
import { activeSessionCounts, machineAttention } from "./rail-attention.js";
import { machineListEntries } from "./runners.js";

/** The All Machines overview (#2986): what needs the person and where there is room to run more. */

const NOW = 1_000_000_000;

function runner(runnerId: string, overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId,
    displayName: runnerId,
    hostname: `${runnerId}-host`,
    os: "linux",
    version: "1",
    status: "online",
    agents: [],
    workspaces: [],
    connectedAt: 1,
    lastSeen: NOW - 4 * 60_000,
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

function session(id: string, runnerId: string, status: SessionView["status"], archived = false): Pick<SessionView, "runnerId" | "status" | "archived"> & { id: string } {
  return { id, runnerId, status, archived };
}

const capacity = (configuredUnits: number, usedUnits?: number, queuedSessions?: number) =>
  ({ configuredUnits, usedUnits, queuedSessions, revision: 1, authority: "control_plane" }) as RunnerView["capacity"];

/**
 * Shared fixtures: every state a machine can be in, including the rail-only cases where its
 * status is settled (Bootstrapping, Deploying) and the rail's dot still counts it.
 */
const FIXTURE_RUNNERS: RunnerView[] = [
  runner("online"),
  runner("busy-offline", { status: "offline" }),
  runner("idle-offline", { status: "offline" }),
  runner("outdated", { protocolVersion: PROTOCOL_VERSION - 1 }),
  runner("outdated-offline", { status: "offline", protocolVersion: PROTOCOL_VERSION - 1 }),
  runner("bootstrapping-outdated", { protocolVersion: PROTOCOL_VERSION - 1 }),
  runner("deploying-busy", { status: "offline" }),
  runner("too-old-agent", { agents: [agent({ claudeCode: { status: "unsupported" } as AgentDefinition["claudeCode"] })] }),
  runner("approval", { agents: [agent({ name: "Gemini CLI", registry: { installStatus: "approval-required" } as AgentDefinition["registry"] })] }),
  runner("sign-in", { providerAccounts: [{ id: "work", label: "Work", provider: "claude", authStatus: "unauthenticated" }] }),
  runner("unknown-protocol", { protocolVersion: null }),
  runner("ssh-online"),
];
const FIXTURE_BOXES: BoxView[] = [
  box("bootstrapping-outdated", { status: "bootstrapping" }),
  box("deploying-busy", { status: "deploying" }),
  box("ssh-online"),
  box("ssh-unreachable", { status: "offline", lastError: "Connection timed out" }),
  box("ssh-failed", { status: "failed", lastError: "boom" }),
];
const FIXTURE_SESSIONS = [
  session("s1", "busy-offline", "running"),
  session("s2", "deploying-busy", "running"),
  session("s3", "idle-offline", "idle", true),
];

const runnerMap = (runners: RunnerView[]) => new Map(runners.map((value) => [value.runnerId, value]));
const fixtureEntries = () => machineListEntries(runnerMap(FIXTURE_RUNNERS), FIXTURE_BOXES);
const fixtureActive = () => activeSessionCounts(FIXTURE_SESSIONS);

test("every machine machineAttention() counts has a Needs Attention row", () => {
  const listed = new Set(machinesOverviewAttention(fixtureEntries(), fixtureActive(), true, NOW).map((item) => item.entry.runnerId));
  let counted = 0;
  for (const value of FIXTURE_RUNNERS) {
    const attention = machineAttention([value], FIXTURE_SESSIONS);
    if (attention.offlineWithActiveSessions + attention.updateRequired === 0) continue;
    counted += 1;
    assert.ok(listed.has(value.runnerId), `${value.runnerId} is counted by the rail's dot, so it has a row`);
  }
  const total = machineAttention(FIXTURE_RUNNERS, FIXTURE_SESSIONS);
  assert.equal(counted, total.offlineWithActiveSessions + total.updateRequired);
  // The rail-only cases are the reason the overview reads machineAttentionReason as well as the status.
  assert.ok(listed.has("bootstrapping-outdated"));
  assert.ok(listed.has("deploying-busy"));
});

test("Needs Attention is every machine not Online or Connecting, in list order, and nothing else", () => {
  const entries = fixtureEntries();
  const items = machinesOverviewAttention(entries, fixtureActive(), true, NOW);
  assert.deepEqual(items.map((item) => item.entry.runnerId), [
    // The list's order, which past eight machines is its groups': Needs Attention, then Online
    // (the settled machines the rail's dot still counts), then Offline.
    "approval", "outdated", "sign-in", "too-old-agent", "ssh-failed", "ssh-unreachable",
    "bootstrapping-outdated", "deploying-busy",
    "busy-offline", "idle-offline", "outdated-offline",
  ]);
  assert.equal(items.some((item) => ["online", "ssh-online", "unknown-protocol"].includes(item.entry.runnerId)), false);
});

test("each row's reason is one sentence about its top state", () => {
  const items = machinesOverviewAttention(fixtureEntries(), fixtureActive(), true, NOW);
  const reason = (runnerId: string) => items.find((item) => item.entry.runnerId === runnerId)?.reason;
  assert.equal(reason("idle-offline"), "Last seen 4m ago. Repair its connection to run agents there again.");
  assert.equal(reason("busy-offline"), "Last seen 4m ago with 1 active session. Repair its connection to run agents there again.");
  assert.equal(reason("outdated"), "Its runner is out of date.");
  assert.equal(reason("too-old-agent"), "Codex is out of date.");
  assert.equal(reason("approval"), "Gemini CLI from the ACP Registry is waiting for you to approve its launch.");
  assert.equal(reason("sign-in"), "1 account needs to sign in again.");
  assert.equal(reason("ssh-unreachable"), "Wollipog couldn't reach it over SSH. Reconnect to try again.");
  assert.equal(reason("ssh-failed"), "Its SSH connection failed. Reconnect to try again.");
  assert.equal(reason("bootstrapping-outdated"), "Its runner is out of date.");
  assert.equal(reason("deploying-busy"), "Its runner is offline with 1 active session.");
});

test("an owner or admin gets each row's own fix; everyone else gets Review", () => {
  const actions = (canManage: boolean) => Object.fromEntries(
    machinesOverviewAttention(fixtureEntries(), fixtureActive(), canManage, NOW).map((item) => [item.entry.runnerId, item.action]));
  const owner = actions(true);
  assert.equal(owner["idle-offline"], "repair");
  assert.equal(owner["busy-offline"], "repair");
  assert.equal(owner["ssh-unreachable"], "reconnect");
  assert.equal(owner["ssh-failed"], "reconnect");
  assert.equal(owner["outdated"], "review");
  assert.equal(owner["deploying-busy"], "review", "a connection already in progress is not reconnected from here");
  assert.ok(Object.values(actions(false)).every((action) => action === "review"));
  assert.equal(
    machinesOverviewAttention(fixtureEntries(), fixtureActive(), false, NOW).find((item) => item.entry.runnerId === "ssh-failed")?.reason,
    "Its SSH connection failed. Ask an organization owner or admin to reconnect it.",
  );
});

test("the summary counts machines and the online machines' units, and leaves the units out when none report them", () => {
  const entries = machineListEntries(runnerMap([
    runner("a", { capacity: capacity(40, 29) }),
    runner("b", { capacity: capacity(40, 15) }),
    runner("c"),
    runner("d", { status: "offline", capacity: capacity(40, 40) }),
  ]), []);
  assert.equal(machinesOverviewSummary(entries), "4 machines, 3 online. 44 of 80 units in use on the online machines.");
  assert.equal(machinesOverviewSummary(machineListEntries(runnerMap([runner("a"), runner("b", { status: "offline" })]), [])),
    "2 machines, 1 online.");
  assert.equal(machinesOverviewSummary(machineListEntries(runnerMap([runner("a", { capacity: capacity(1, 0) })]), [])),
    "1 machine, 1 online. 0 of 1 unit in use on the online machine.");
});

test("Capacity rows: a warning meter from 75%, Offline, Capacity Unknown, and the rest after eight summed", () => {
  const { rows, rest } = machinesOverviewCapacity(machineListEntries(runnerMap([
    runner("warn", { capacity: capacity(40, 30, 3) }),
    runner("calm", { capacity: capacity(40, 29) }),
    runner("down", { status: "offline", capacity: capacity(40, 10) }),
    runner("unknown"),
    runner("no-use", { capacity: capacity(40) }),
  ]), []));
  const byId = Object.fromEntries(rows.map((row) => [row.entry.runnerId, row]));
  assert.deepEqual(byId.warn, { entry: byId.warn!.entry, kind: "meter", used: 30, limit: 40, queued: 3, warning: true });
  assert.equal(byId.calm!.kind === "meter" && byId.calm!.warning, false);
  assert.equal(byId.down!.kind, "offline");
  assert.equal(byId.unknown!.kind, "unknown");
  assert.equal(byId["no-use"]!.kind, "unknown", "a limit without its use is no level to draw");
  assert.equal(rest, null);
  assert.equal(machineCapacityMeterLabel(30, 40), "30 of 40 units in use");

  const ten = machinesOverviewCapacity(machineListEntries(runnerMap(Array.from({ length: 10 }, (_, index) =>
    runner(`node-${index}`, index === 9 ? {} : { capacity: capacity(16, index) }))), []));
  assert.equal(ten.rows.length, 8);
  assert.deepEqual(ten.rest, { count: 2, units: { used: 8, limit: 16 } }, "the rest's units, from the machines reporting them");
});
