/** Pure helpers for the Runners view (no DOM, unit-tested): version-skew badging,
 * adopt-action labeling, install guidance when discovery finds no agent CLIs, and
 * user-owned Machine naming with stable identity fallbacks. */

import {
  PROTOCOL_VERSION,
  type BoxView,
  type ExternalSessionDescriptor,
  type OS,
  type RunnerView,
  type RunnerRuntimeInfo,
} from "@wollipog/protocol";
import { driverKindLabel } from "./agent-presentation.js";

export function machineSettingsMutationError(cause: unknown): string {
  if (cause instanceof Error &&
      "status" in cause &&
      (cause as Error & { status?: unknown }).status === 404 &&
      cause.message.trim().toLocaleLowerCase() === "not found") {
    return "This control plane does not support updating this Machine setting. Update or restart it so it matches this dashboard, then try again.";
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

/** End-user tooltip for a connection that needs a newer runner. Technical recovery guidance lives
 * in docs/runner-updates.md rather than the primary Connections UI. */
export function outdatedRunnerTitle(): string {
  return "An update is available for this connection. Update it to enable all current features.";
}

export function unknownRunnerTitle(): string {
  return "Version information is unavailable. Some features may remain disabled until this connection is updated.";
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

export function outdatedBoxHint(): string {
  return "Update this connection to enable the latest features.";
}

/** Button label + tooltip for adopting an external session. `resumable === false` means the runner
 * found no agent for the descriptor's driver+context, so the adopt lands as read-only history;
 * absent (pre-v15 runner) keeps the optimistic default. */
export function adoptAction(d: Pick<ExternalSessionDescriptor, "driver" | "context" | "resumable">): {
  label: string;
  title?: string;
} {
  if (d.resumable !== false) return { label: "Adopt & Continue" };
  const ctx = d.context.kind === "wsl" ? `WSL: ${d.context.distro}` : "native";
  return {
    label: "Adopt as Read-Only",
    title:
      `No ${driverKindLabel(d.driver)} agent exists on this box for its context (${ctx}), so the session ` +
      `can't be continued — adopting imports the transcript as read-only history.`,
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
  command: string;
}

/** Copy-pasteable install one-liners for the agent CLIs, matching the host OS. Claude Code uses the
 * official native installer (npm is only a listed alternative — see docs/product-gaps.md #15);
 * Codex has no native installer, so npm it is. */
export function agentInstallHints(os: OS): InstallHint[] {
  return [
    {
      name: "Claude Code",
      command:
        os === "windows"
          ? "irm https://claude.ai/install.ps1 | iex"
          : "curl -fsSL https://claude.ai/install.sh | bash",
    },
    { name: "Codex", command: "npm install -g @openai/codex" },
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
