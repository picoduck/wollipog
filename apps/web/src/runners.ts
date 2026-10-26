/** Pure helpers for the Runners view (no DOM, unit-tested): version-skew badging,
 * adopt-action labeling, install guidance when discovery finds no agent CLIs, and
 * user-owned Machine naming with stable identity fallbacks. */

import {
  isRetiredCodexExec,
  PROTOCOL_VERSION,
  type BoxView,
  type AgentDefinition,
  type ExternalSessionDescriptor,
  type OS,
  type RunnerView,
  type RunnerRuntimeInfo,
} from "@wollipog/protocol";
import { formatHarnessLaunchCommand } from "./harness-command.js";
import { agentStatus, type AgentStatus } from "./agent-presentation.js";

export function machineSettingsMutationError(cause: unknown): string {
  if (cause instanceof Error &&
      "status" in cause &&
      (cause as Error & { status?: unknown }).status === 404 &&
      cause.message.trim().toLocaleLowerCase() === "not found") {
    return "This version of Wollipog does not support updating this Machine setting. Update or restart Wollipog so it matches this dashboard, then try again.";
  }
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "The Machine setting could not be updated.";
}

export function formatAdmissionPolicy(runtime: RunnerRuntimeInfo): string | null {
  const policy = runtime.admission;
  if (!policy) return null;
  const ids = [...new Set([...Object.keys(policy.agentLimits), ...Object.keys(policy.agentWeights)])].sort();
  if (ids.length === 0) return null;
  return ids.map((agentId) => {
    const limit = policy.agentLimits[agentId];
    const weight = policy.agentWeights[agentId] ?? 1;
    return `${agentId}: ${limit ? `limit ${limit}, ` : ""}weight ${weight}`;
  }).join(" · ");
}

export function formatExecutionIsolation(runtime: RunnerRuntimeInfo): string {
  const policy = runtime.executionIsolation;
  if (!policy || policy.mode === "provider") return "Provider sandbox";
  const network = policy.network === "deny" ? "offline/local models only" : "network inherited";
  const retention = policy.providerStateRetentionDays !== undefined && policy.providerStateMaxBytes !== undefined
    ? ` · owned orphan state ${policy.providerStateRetentionDays}d / ${Math.ceil(policy.providerStateMaxBytes / 1024 ** 3)}GiB max`
    : "";
  if (policy.mode === "bwrap") {
    return `Bubblewrap required (Linux/WSL; other native fail closed) · workspace write · Claude/Codex transcript paths isolated per session where applicable · credentials read-only · ${network}${retention}`;
  }
  if (policy.mode === "seatbelt") {
    return `Seatbelt required (native macOS; other contexts fail closed) · writes limited to workspace, runner data, temp, and shared provider transcript leaf · same-provider sessions serialized · reads inherited · ${network}`;
  }
  return "Windows Job Object required (native Windows; other contexts fail closed) · kill-on-close process tree only · filesystem and network inherited";
}

/** Host portion of an SSH target: strips a leading `user@` and a trailing `:port`, keeping IPv6
 * literals intact. `git@[2001:db8::1]:22` → `[2001:db8::1]`, `me@host:2200` → `host`, and an
 * UNBRACKETED IPv6 like `user@2001:db8::1` stays whole — multiple colons mean an address, not a
 * port (bracket syntax is required to carry a port with IPv6). */
export function sshTargetHost(sshTarget: string): string {
  const at = sshTarget.lastIndexOf("@");
  let host = at >= 0 ? sshTarget.slice(at + 1) : sshTarget;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const first = host.indexOf(":");
  if (first >= 0 && first === host.lastIndexOf(":")) host = host.slice(0, first);
  return host;
}

export interface RunnerDisplay {
  /** User-owned Machine name, or the most stable available identity fallback. */
  name: string;
  /** Whether this runner is a locally-started one or an SSH-reached box. */
  kind: "local" | "ssh";
}

/**
 * Friendly Machine label. User-owned metadata wins. SSH boxes then use their configured SSH host;
 * native runners use their runner id so two runners on one host do not collapse into identical
 * labels. Hostname remains diagnostic metadata rather than Machine identity.
 */
export function runnerDisplay(
  runner: Pick<RunnerView, "runnerId" | "hostname" | "displayName"> | undefined,
  box: Pick<BoxView, "sshTarget" | "displayName"> | undefined,
  fallbackId = "",
): RunnerDisplay {
  const id = runner?.runnerId ?? fallbackId;
  const displayName = runner?.displayName?.trim() || box?.displayName?.trim();
  const hostname = runner?.hostname?.trim();
  if (box) return { name: displayName || sshTargetHost(box.sshTarget) || id || hostname || "", kind: "ssh" };
  return { name: displayName || id || hostname || "", kind: "local" };
}

/** True when the runner registered with a protocol version older than this dashboard's.
 * null/undefined = unknown (a pre-v15 runner never reports one) — show nothing rather than guess. */
export function runnerOutdated(
  protocolVersion: number | null | undefined,
  current: number = PROTOCOL_VERSION,
): boolean {
  return protocolVersion != null && protocolVersion < current;
}

export function sshRunnerLifecycleHint(): string {
  return "Wollipog reconnects automatically if this SSH connection drops. Running work does not continue through the interruption.";
}

/** Guidance for a native runner the dashboard did not spawn and therefore cannot safely restart. */
export function nativeRunnerUpdateHint(
  protocolVersion: number | null | undefined,
  current: number = PROTOCOL_VERSION,
): string | null {
  if (protocolVersion != null && protocolVersion >= current) return null;
  return "This connection was started outside Wollipog and cannot be updated here. Install the latest runner using the same setup method, then restart the connection.";
}

/**
 * A machine's one status (docs/design-system.md §11.1, §11.2), a `statusMeta("machine", …)` key.
 * The Machines list's row reads it, and so do the detail header and the overview.
 */
export type MachineStatus =
  | "unreachable"
  | "failed"
  | "offline"
  | "connecting"
  | "bootstrapping"
  | "deploying"
  | "update_required"
  | "approval_required"
  | "sign_in_required"
  | "online";

type MachineStatusRunner = Pick<RunnerView, "status" | "protocolVersion" | "agents" | "providerAccounts">;
type MachineStatusBox = Pick<BoxView, "status" | "lastError">;

/** The agents a machine's status counts, by their one status. The retired Codex exec row duplicates
 * the App Server row's state, so it is never counted twice. */
export function machineAgentsWithStatus(
  agents: readonly AgentDefinition[],
  status: AgentStatus,
): AgentDefinition[] {
  return agents.filter((agent) => !isRetiredCodexExec(agent) && agentStatus(agent) === status);
}

/**
 * The most urgent of a machine's states: Unreachable or Failed, then Offline, then the connection in
 * progress (Connecting, Bootstrapping, Deploying), then what the person has to do on an online
 * machine (Update Required, Approval Required, Sign-In Required, rolled up from its agents'
 * `agentStatus()`), then Online. An SSH machine's connection is its box's: an offline box with an
 * error could not be reached, and an online box whose runner has not registered yet is still
 * connecting.
 */
export function machineStatus(runner: MachineStatusRunner | undefined, box: MachineStatusBox | undefined): MachineStatus {
  if (box) {
    if (box.status === "failed") return "failed";
    if (box.status === "offline") return box.lastError ? "unreachable" : "offline";
    if (box.status === "bootstrapping" || box.status === "deploying") return box.status;
    if (!runner) return "connecting";
  }
  if (!runner || runner.status !== "online") return "offline";
  const has = (status: AgentStatus) => machineAgentsWithStatus(runner.agents, status).length > 0;
  if (runnerOutdated(runner.protocolVersion) || has("update_required")) return "update_required";
  if (has("approval_required")) return "approval_required";
  if (has("sign_in_required") || runner.providerAccounts?.some((account) => account.authStatus === "unauthenticated")) {
    return "sign_in_required";
  }
  return "online";
}

/** Online, or on its way there: everything else needs the person. */
const SETTLED_MACHINE_STATUSES: ReadonlySet<MachineStatus> = new Set(["online", "connecting", "bootstrapping", "deploying"]);

/** Whether the machine's status asks something of the person: anything but Online or Connecting. */
export function machineNeedsAttention(status: MachineStatus): boolean {
  return !SETTLED_MACHINE_STATUSES.has(status);
}

/** One machine as the Machines list shows it: an SSH box with its runner, or a native runner. */
export interface MachineListEntry {
  /** The selection key (`/connections/machines/~<runnerId>`); every SSH machine has one. */
  runnerId: string;
  name: string;
  kind: "native" | "ssh";
  status: MachineStatus;
  /** Its runner is connected. */
  online: boolean;
  /** Runner Capacity as the runner reports it; null when it reports none. */
  capacity: { usedUnits?: number; configuredUnits: number } | null;
  runner?: RunnerView;
  box?: BoxView;
}

/**
 * The Machines list's order (#2985): what needs the person first, then online machines, then by
 * name. `[attentionRank, online ? 0 : 1, displayName]`.
 */
export function machineSortKey(entry: Pick<MachineListEntry, "status" | "online" | "name">): [number, number, string] {
  return [machineNeedsAttention(entry.status) ? 0 : 1, entry.online ? 0 : 1, entry.name];
}

const MACHINE_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareMachines(
  a: Pick<MachineListEntry, "status" | "online" | "name" | "runnerId">,
  b: Pick<MachineListEntry, "status" | "online" | "name" | "runnerId">,
): number {
  const [aRank, aOnline, aName] = machineSortKey(a);
  const [bRank, bOnline, bName] = machineSortKey(b);
  // The runner id breaks a tie between two machines of one name, so the order never flickers.
  return aRank - bRank || aOnline - bOnline || MACHINE_NAME_COLLATOR.compare(aName, bName) ||
    a.runnerId.localeCompare(b.runnerId);
}

/** Every machine, sorted: each SSH box with the runner it bootstraps, then the native runners. */
export function machineListEntries(runners: ReadonlyMap<string, RunnerView>, boxes: Iterable<BoxView>): MachineListEntry[] {
  const entries: MachineListEntry[] = [];
  const boxRunnerIds = new Set<string>();
  for (const box of boxes) {
    boxRunnerIds.add(box.runnerId);
    entries.push(machineEntry(runners.get(box.runnerId), box, box.runnerId));
  }
  for (const runner of runners.values()) {
    if (!boxRunnerIds.has(runner.runnerId)) entries.push(machineEntry(runner, undefined, runner.runnerId));
  }
  return entries.sort(compareMachines);
}

function machineEntry(runner: RunnerView | undefined, box: BoxView | undefined, runnerId: string): MachineListEntry {
  const capacity = runner?.capacity;
  return {
    runnerId,
    name: runnerDisplay(runner, box, runnerId).name,
    kind: box ? "ssh" : "native",
    status: machineStatus(runner, box),
    online: runner?.status === "online",
    capacity: capacity
      ? { configuredUnits: capacity.configuredUnits, ...(capacity.usedUnits === undefined ? {} : { usedUnits: capacity.usedUnits }) }
      : null,
    ...(runner ? { runner } : {}),
    ...(box ? { box } : {}),
  };
}

/** "29 of 40 Units", or "40 Units" while the runner reports no use. */
export function machineCapacityLabel(capacity: NonNullable<MachineListEntry["capacity"]>): string {
  return capacity.usedUnits === undefined
    ? `${capacity.configuredUnits} Units`
    : `${capacity.usedUnits} of ${capacity.configuredUnits} Units`;
}

/** Above this many machines the list offers a filter and groups its rows (#2985). */
export const MACHINE_LIST_GROUPING_THRESHOLD = 8;

export type MachineGroupKey = "needs_attention" | "online" | "offline";

export interface MachineListGroup {
  key: MachineGroupKey;
  label: string;
  entries: MachineListEntry[];
}

const MACHINE_GROUPS: ReadonlyArray<{ key: MachineGroupKey; label: string }> = [
  { key: "needs_attention", label: "Needs Attention" },
  { key: "online", label: "Online" },
  { key: "offline", label: "Offline" },
];

/** Offline machines have a group of their own; Connecting sits with Online, where it is going. */
export function machineGroup(status: MachineStatus): MachineGroupKey {
  if (status === "offline") return "offline";
  return machineNeedsAttention(status) ? "needs_attention" : "online";
}

/** The sorted entries under their group labels, in group order, leaving out empty groups. */
export function groupMachineList(entries: readonly MachineListEntry[]): MachineListGroup[] {
  return MACHINE_GROUPS
    .map(({ key, label }) => ({ key, label, entries: entries.filter((entry) => machineGroup(entry.status) === key) }))
    .filter((group) => group.entries.length > 0);
}

/** The rows in the order the list shows them: by group once it groups, otherwise as sorted. */
export function machineListOrder(entries: readonly MachineListEntry[]): MachineListEntry[] {
  return entries.length > MACHINE_LIST_GROUPING_THRESHOLD
    ? groupMachineList(entries).flatMap((group) => group.entries)
    : [...entries];
}

/** The entries whose name holds the query, ignoring case; an empty query keeps every one. */
export function filterMachineList(entries: readonly MachineListEntry[], query: string): MachineListEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle)) : [...entries];
}

/** The family a found session belongs to, as the read-only reason names it ("No Codex agent…"). */
function sessionAgentFamily(driver: ExternalSessionDescriptor["driver"]): string {
  if (driver === "claude-code") return "Claude Code";
  if (driver === "codex" || driver === "codex-app-server") return "Codex";
  if (driver === "pi") return "Pi";
  return "ACP";
}

/** A found session's one action. `resumable === false` means the runner found no agent for the
 * descriptor's driver and context, so it lands as read-only history, and `reason` says so as the
 * row's visible line; absent (a pre-v15 runner) keeps the optimistic default. */
export function adoptAction(d: Pick<ExternalSessionDescriptor, "driver" | "context" | "resumable">): {
  label: string;
  reason?: string;
} {
  if (d.resumable !== false) return { label: "Continue Here" };
  const where = d.context.kind === "wsl" ? `in WSL (${d.context.distro}) on this machine` : "on this machine";
  return {
    label: "Import as Read-Only",
    reason: `No ${sessionAgentFamily(d.driver)} agent ${where} can continue it, so it opens as read-only history.`,
  };
}

/** UI identity follows runner ownership: native transcript ids are global, while ACP ids are opaque
 * to one exact adapter and may legitimately collide across configured providers. */
export function externalSessionKey(
  descriptor: Pick<ExternalSessionDescriptor, "agentId" | "agentSessionId">,
): string {
  return JSON.stringify([descriptor.agentId ?? null, descriptor.agentSessionId]);
}

export interface InstallHint {
  name: string;
  guidance: string;
  command?: string;
}

/** An older runner can still send a PowerShell command for a launch that this client knows is
 * unsafe to copy. Protocol v179 cannot attest the guard: both sides of the runner fix use v179. */
export function harnessUpdateGuidance(
  agent: Pick<AgentDefinition, "command" | "args" | "context" | "update">,
  os: OS,
): string | undefined {
  const guidance = agent.update?.guidance;
  if (!guidance) return guidance;
  if (formatHarnessLaunchCommand(agent.command, agent.args, agent.context, os).referenceOnly &&
      /\brun\s+`[^`]+`\s+in\s+PowerShell\b/i.test(guidance)) {
    return "This Windows launch may resolve to a batch wrapper or use legacy PowerShell argument passing. No copyable update command is available for this launch; use the package or version manager that installed this exact copy after stopping sessions using it. Restart and Rediscover before treating the new version as ready.";
  }
  return guidance;
}

/** Shared neutral fallback for Codex remediation when discovery has no manager guidance. */
export function codexUpgradeGuidance(
  agent: Pick<AgentDefinition, "command" | "args" | "context" | "installation" | "update">,
  os: OS,
): string {
  const guidance = harnessUpdateGuidance(agent, os);
  if (guidance) return guidance;
  return agent.installation
    ? "Inspect this installation in Machine settings and use the manager that installed this exact copy, then Rediscover."
    : "Install Codex using a supported method for this Machine, then Rediscover.";
}

/** Installation hints are neutral where no selected installation proves manager ownership. */
export function agentInstallHints(os: OS): InstallHint[] {
  return [
    {
      name: "Claude Code",
      guidance: "Install Claude Code with its official installer, then Rediscover.",
      command:
        os === "windows"
          ? "irm https://claude.ai/install.ps1 | iex"
          : "curl -fsSL https://claude.ai/install.sh | bash",
    },
    { name: "Codex", guidance: "Install Codex using a supported method for this Machine, then Rediscover. Existing installations should be updated through their own manager." },
  ];
}

/**
 * Option labels for a set of Machines, guaranteed unique, disambiguated only where needed.
 *
 * Machine names are user-owned and NOT unique — the control plane does not constrain them. A
 * selector rendering only the name turns two Machines both called "Build Machine" into two
 * identical options, and picking the wrong one launches work against the wrong host and filesystem.
 * Showing a connection id on every option would fix that by making every option ugly.
 *
 * Escalates per collision group rather than per Machine, and re-checks the WHOLE label set after
 * each pass. Checking only within same-name groups is not enough: a user may legitimately name a
 * Machine "Build Machine · build-a", which collides with a label this function generates for a
 * different one, and two native runner ids can share an 8-character prefix. The loop terminates
 * because the final tier is the full runner id, which is unique by construction.
 */
export function machineOptionLabels(
  runners: ReadonlyArray<Pick<RunnerView, "runnerId" | "hostname" | "displayName">>,
  boxFor: (runnerId: string) => Pick<BoxView, "sshTarget" | "displayName"> | undefined = () => undefined,
): Map<string, string> {
  const base = new Map<string, string>();
  for (const runner of runners) {
    base.set(runner.runnerId, runnerDisplay(runner, boxFor(runner.runnerId), runner.runnerId).name);
  }

  // Tier 0 is the bare name; each later tier appends a stronger discriminator.
  const tier = new Map<string, number>(runners.map((runner) => [runner.runnerId, 0]));
  const labelFor = (runner: Pick<RunnerView, "runnerId" | "hostname">): string => {
    const name = base.get(runner.runnerId)!;
    switch (tier.get(runner.runnerId)) {
      case 0: return name;
      case 1: return runner.hostname ? `${name} · ${runner.hostname}` : `${name} · ${runner.runnerId}`;
      default: return `${name} · ${runner.runnerId}`;
    }
  };

  // At most three passes: bare, hostname, full id — the last is unique by construction.
  for (let pass = 0; pass < 3; pass += 1) {
    const byLabel = new Map<string, string[]>();
    for (const runner of runners) {
      const label = labelFor(runner);
      const group = byLabel.get(label);
      if (group) group.push(runner.runnerId);
      else byLabel.set(label, [runner.runnerId]);
    }
    const colliding = [...byLabel.values()].filter((ids) => ids.length > 1).flat();
    if (colliding.length === 0) break;
    for (const runnerId of colliding) tier.set(runnerId, (tier.get(runnerId) ?? 0) + 1);
  }

  return new Map(runners.map((runner) => [runner.runnerId, labelFor(runner)]));
}
