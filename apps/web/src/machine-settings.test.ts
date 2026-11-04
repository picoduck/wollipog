import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION, type AgentDefinition, type RunnerView } from "@wollipog/protocol";
import {
  accountStatusLabel,
  capacityError,
  CAPACITY_ERROR,
  fieldChanged,
  fieldLabel,
  fieldOrder,
  installationGroups,
  machineSettingsSnapshot,
  MISSING_INSTALLATION,
  nameError,
  nativeInstallationSentence,
  unsavedSentence,
  withField,
} from "./machine-settings.js";

function runner(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "studio",
    hostname: "studio.local",
    displayName: "Studio Mac",
    os: "macos",
    version: "1",
    status: "online",
    agents: [],
    workspaces: [],
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion: PROTOCOL_VERSION,
    canManage: true,
    ...overrides,
  };
}

function codex(id: string, installationId: string, path: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id, name: "Codex", command: path, args: [], env: {}, driver: "codex-app-server", context: { kind: "native" },
    available: true, authStatus: "authenticated", version: "0.155.1",
    installation: { id: installationId, path, via: "path" }, ...extra,
  };
}

test("Capacity Limit takes a whole number from 1 to 256", () => {
  for (const ok of ["1", "16", "256", " 24 "]) assert.equal(capacityError(ok), null, ok);
  for (const bad of ["", "0", "300", "1.5", "-2", "abc", "1e2"]) assert.equal(capacityError(bad), CAPACITY_ERROR, bad);
  assert.equal(CAPACITY_ERROR, "Enter a whole number from 1 to 256.");
});

test("Machine Name is required and at most 120 characters", () => {
  assert.equal(nameError("Studio Mac"), null);
  assert.equal(nameError("   "), "Enter a name for this machine.");
  assert.equal(nameError("x".repeat(121)), "Use 120 characters or fewer.");
});

test("account options read in the shared provider account words", () => {
  assert.equal(accountStatusLabel("authenticated"), "Signed In");
  assert.equal(accountStatusLabel("unauthenticated"), "Sign-In Required");
  assert.equal(accountStatusLabel("unknown"), "Status Unknown");
});

test("installation rows say one status sentence built from the facts", () => {
  assert.equal(nativeInstallationSentence(codex("a", "a", "/a")), "Available. Signed in.");
  assert.equal(nativeInstallationSentence(codex("a", "a", "/a", { available: false, authStatus: "unauthenticated" })),
    "Unavailable. Sign in to this installation, then rediscover.");
  assert.equal(nativeInstallationSentence(codex("a", "a", "/a", { available: false, authStatus: undefined,
    unavailableReason: "Codex 0.140.0 is older than the supported version 0.147.0." })),
  "Unavailable. Codex 0.140.0 is older than the supported version 0.147.0.");
  assert.equal(nativeInstallationSentence(codex("a", "a", "/a", { available: undefined, authStatus: undefined })), "Not verified.");
});

test("two installations of one harness are one group; a lone one is no choice; a missing saved choice is a disabled row", () => {
  const two = runner({
    agents: [
      codex("codex", "system", "/usr/bin/codex"),
      codex("codex-local", "local", "/home/me/.local/bin/codex", { version: "0.210.0" }),
      // The retired exec row is never a choice.
      codex("codex-exec", "system", "/usr/bin/codex", { driver: "codex" }),
      { ...codex("claude", "claude", "/usr/bin/claude"), driver: "claude-code", name: "Claude Code" },
    ],
    harnessSelections: [{ family: "codex", context: { kind: "native" }, installationId: "system", path: "/usr/bin/codex", via: "path", agentId: "codex" }],
  });
  const groups = installationGroups(two);
  assert.equal(groups.length, 1, "Claude Code has one installation, so nothing to choose");
  assert.equal(groups[0]!.label, "Codex");
  assert.equal(groups[0]!.saved, "system");
  assert.deepEqual(groups[0]!.rows.map((row) => [row.path, row.version, row.disabled]),
    [["/usr/bin/codex", "0.155.1", false], ["/home/me/.local/bin/codex", "0.210.0", false]]);

  const missing = runner({
    agents: [{ ...codex("claude", "claude", "/usr/bin/claude"), driver: "claude-code" }],
    harnessSelections: [{ family: "claude", context: { kind: "wsl", distro: "Ubuntu" }, installationId: "gone",
      path: "/opt/claude", version: "2.0.0", via: "path", agentId: null }],
  });
  const [wsl] = installationGroups(missing);
  assert.equal(wsl!.label, "Claude Code in WSL (Ubuntu)");
  assert.deepEqual(wsl!.rows, [{ value: "gone", path: "/opt/claude", version: "2.0.0", sentence: MISSING_INSTALLATION, disabled: true, agentId: null }]);
});

test("a target offering candidates is a group per agent, its unavailable rows disabled", () => {
  const target = {
    id: "t1", runnerId: "studio", name: "Alpha Image", kind: "container", adapter: "container", workspaceStrategy: "worktree",
    boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" },
    compatibleAgentIds: ["codex"], available: true,
    harnessInstallations: [
      { agentId: "codex", id: "a1", path: "/usr/bin/codex", version: "1.2.3", provenance: "container-image", authentication: "authenticated", capability: "verified", available: true },
      { agentId: "codex", id: "a2", path: "/opt/codex", provenance: "container-image", authentication: "unknown", capability: "unknown", available: false },
    ],
  } as unknown as NonNullable<RunnerView["executionTargets"]>[number];
  const groups = installationGroups(runner({
    agents: [codex("codex", "system", "/usr/bin/codex")],
    executionTargets: [target],
    targetHarnessSelections: [{ targetId: "t1", targetName: "Alpha Image", agentId: "codex", installationId: "a1", path: "/usr/bin/codex", available: true }],
  }));
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.label, "Codex in Alpha Image");
  assert.equal(groups[0]!.saved, "a1");
  assert.deepEqual(groups[0]!.rows.map((row) => [row.value, row.sentence, row.disabled]),
    [["a1", "Available. Signed in.", false], ["a2", "Unavailable.", true]]);
});

function containerTarget(id: string, name: string, installations: Array<{ agentId: string; id: string; path: string }>) {
  return {
    id, runnerId: "studio", name, kind: "container", adapter: "container", workspaceStrategy: "worktree",
    boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" },
    compatibleAgentIds: [...new Set(installations.map((installation) => installation.agentId))], available: true,
    harnessInstallations: installations.map((installation) => ({ ...installation, provenance: "container-image",
      authentication: "unknown", capability: "unknown", available: true })),
  } as unknown as NonNullable<RunnerView["executionTargets"]>[number];
}

test("a saved target choice for an agent the target no longer lists keeps its missing row (CR-1.3)", () => {
  const groups = installationGroups(runner({
    agents: [codex("codex", "system", "/usr/bin/codex"), { ...codex("claude", "c", "/usr/bin/claude"), driver: "claude-code" }],
    executionTargets: [containerTarget("t1", "Alpha Image", [{ agentId: "codex", id: "a1", path: "/usr/bin/codex" }])],
    targetHarnessSelections: [{ targetId: "t1", targetName: "Alpha Image", agentId: "claude", installationId: "gone",
      path: "/opt/claude", available: false }],
  }));
  assert.deepEqual(groups.map((group) => group.label), ["Codex in Alpha Image", "Claude Code in Alpha Image"]);
  assert.deepEqual(groups[1]!.rows.map((row) => [row.value, row.sentence, row.disabled]), [["gone", MISSING_INSTALLATION, true]]);
});

test("agents outside the three harness families keep their own names (CR-1.4)", () => {
  const acp = (id: string, name: string): AgentDefinition => ({ id, name, command: id, args: [], env: {}, driver: "acp", available: true });
  const groups = installationGroups(runner({
    agents: [acp("gemini", "Gemini CLI"), acp("goose", "Goose")],
    executionTargets: [containerTarget("t1", "Alpha Image", [
      { agentId: "gemini", id: "g1", path: "/usr/bin/gemini" },
      { agentId: "goose", id: "o1", path: "/usr/bin/goose" },
    ])],
    targetHarnessSelections: [{ targetId: "t-old", targetName: "Old Image", agentId: "gemini", installationId: "g0",
      path: "/opt/gemini", available: false }],
  }));
  assert.deepEqual(groups.map((group) => group.label), ["Gemini CLI in Alpha Image", "Goose in Alpha Image", "Gemini CLI in Old Image"]);

  const native = installationGroups(runner({
    agents: [
      { ...acp("gemini", "Gemini CLI"), installation: { id: "a", path: "/a/gemini", via: "path" } },
      { ...acp("gemini-2", "Gemini CLI"), installation: { id: "b", path: "/b/gemini", via: "path" } },
      codex("codex", "system", "/usr/bin/codex"),
    ],
  }));
  assert.deepEqual(native.map((group) => [group.label, group.rows.length]), [["Gemini CLI", 2]],
    "never filed under Codex; one Codex installation is no choice");
});

test("a valid capacity is compared as the number it saves (CR-1.2)", () => {
  const saved = { name: "Studio Mac", capacity: "24", switching: false, defaultAccounts: {}, installations: {} };
  assert.equal(fieldChanged({ kind: "capacity" }, { ...saved, capacity: "024" }, saved), false);
  assert.equal(fieldChanged({ kind: "capacity" }, { ...saved, capacity: "25" }, saved), true);
  assert.equal(fieldChanged({ kind: "capacity" }, { ...saved, capacity: "abc" }, saved), true);
});

test("changed fields come from the form against the last saved snapshot, in save order", () => {
  const machine = runner({
    capacity: { configuredUnits: 16, revision: 2, authority: "control_plane" },
    automaticAccountSwitching: { enabled: false, revision: 4 },
    providerAccounts: [{ id: "work", label: "Work", provider: "claude", authStatus: "authenticated" }],
    providerAccountDefaults: [{ provider: "claude", accountId: null, revision: 3 }],
  });
  const saved = machineSettingsSnapshot(machine, undefined);
  assert.deepEqual(saved.values, { name: "Studio Mac", capacity: "16", switching: false, defaultAccounts: { claude: "" }, installations: {} });
  assert.deepEqual(saved.revisions, { capacity: 2, switching: 4, defaultAccounts: { claude: 3 } });
  const order = fieldOrder({ name: true, capacity: true, switching: true, defaultAccounts: ["codex", "claude"], installations: ["g"] });
  assert.deepEqual(order.map((field) => fieldLabel(field, [])),
    ["Machine Name", "Capacity Limit", "Switch Accounts Automatically", "Default Claude Account", "Default Codex Account", "Agent Installation"]);

  const draft = { ...saved.values, name: " Studio Mac ", capacity: "24" };
  assert.deepEqual(order.filter((field) => fieldChanged(field, draft, saved.values)).map((field) => field.kind), ["capacity"],
    "surrounding spaces are not a change");
  // A field that saved becomes the baseline: only what failed is still changed.
  const named = { ...draft, name: "Primary" };
  const baseline = withField(saved.values, named, { kind: "name" });
  assert.deepEqual(order.filter((field) => fieldChanged(field, named, baseline)).map((field) => field.kind), ["capacity"]);
});

test("the failure notice names what wasn't saved", () => {
  assert.equal(unsavedSentence(["Capacity Limit"]), "Capacity Limit wasn't saved.");
  assert.equal(unsavedSentence(["Machine Name", "Capacity Limit"]), "Machine Name and Capacity Limit weren't saved.");
  assert.equal(unsavedSentence(["A", "B", "C"]), "A, B and C weren't saved.");
});
