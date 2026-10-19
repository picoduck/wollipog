import { isRetiredCodexExec } from "@wollipog/protocol";
import { formatRecordedRelativeTime } from "./format.js";
import { machineAttentionReason, type MachineAttentionReason } from "./rail-attention.js";
import {
  agentNeedsSignIn,
  agentTooOld,
  machineListOrder,
  machineNeedsAttention,
  runnerOutdated,
  type MachineListEntry,
} from "./runners.js";

/**
 * The All Machines overview (docs/design-system.md §6.1, #2986): the Machines tab's default detail on
 * desktop and compact widths. Everything here derives from the live machines and sessions.
 */

/** Past this many machines the Capacity section sums the rest into one line. */
export const MACHINES_OVERVIEW_CAPACITY_ROWS = 8;

/** A level at or above this share of the limit draws the warning meter (§11.6). */
export const MACHINE_CAPACITY_WARNING_SHARE = 0.75;

/** The one sentence under Capacity, worded from the runner's admission model (docs/admission-policy.md). */
export const MACHINE_CAPACITY_UNIT_NOTE =
  "A unit is one running agent process. An agent can be set to take more than one.";

export const MACHINES_OVERVIEW_ALL_READY = "Every machine is online and ready.";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Units in use and the limit, for machines that report both. */
export interface UnitTotals { used: number; limit: number }

function sumUnits(entries: readonly MachineListEntry[]): UnitTotals | null {
  let reported = false;
  let used = 0;
  let limit = 0;
  for (const entry of entries) {
    if (entry.capacity?.usedUnits === undefined) continue;
    reported = true;
    used += entry.capacity.usedUnits;
    limit += entry.capacity.configuredUnits;
  }
  return reported ? { used, limit } : null;
}

/**
 * The title row's one line of counts: "4 machines, 3 online. 44 of 80 units in use on the online
 * machines." The units sentence is left out while no online machine reports its use.
 */
export function machinesOverviewSummary(entries: readonly MachineListEntry[]): string {
  const online = entries.filter((entry) => entry.online);
  const counts = `${plural(entries.length, "machine", "machines")}, ${online.length} online.`;
  const units = sumUnits(online);
  if (!units) return counts;
  return `${counts} ${units.used} of ${plural(units.limit, "unit", "units")} in use on the online ${online.length === 1 ? "machine" : "machines"}.`;
}

/** What resolves a Needs Attention row: its own fix for an owner or admin, otherwise Review. */
export type MachineAttentionAction = "repair" | "reconnect" | "review";

export interface MachinesOverviewAttentionItem {
  entry: MachineListEntry;
  /** The top reason, in sentence case. */
  reason: string;
  action: MachineAttentionAction;
}

/**
 * Needs Attention, in list order: every machine whose status asks something of the person, and every
 * machine the rail's Connections dot counts (`machineAttentionReason`), so the two always agree.
 */
export function machinesOverviewAttention(
  entries: readonly MachineListEntry[],
  activeSessions: ReadonlyMap<string, number>,
  canManage: boolean,
  now: number,
): MachinesOverviewAttentionItem[] {
  return machineListOrder(entries).flatMap((entry) => {
    const counted = entry.runner ? machineAttentionReason(entry.runner, activeSessions) : null;
    if (!machineNeedsAttention(entry.status) && counted === null) return [];
    const action = machineAttentionAction(entry, canManage);
    return [{ entry, action, reason: machineAttentionSentence(entry, counted, activeSessions, action, now) }];
  });
}

function machineAttentionAction(entry: MachineListEntry, canManage: boolean): MachineAttentionAction {
  if (!canManage) return "review";
  if (entry.kind === "native" && entry.status === "offline") return "repair";
  if (entry.kind === "ssh" && (entry.status === "offline" || entry.status === "unreachable" || entry.status === "failed")) {
    return "reconnect";
  }
  return "review";
}

/** What the person can do about a lost connection, or whom to ask. */
function reconnectHint(action: MachineAttentionAction, kind: MachineListEntry["kind"], retry: boolean): string {
  if (action === "repair") return "Repair its connection to run agents there again.";
  if (action === "reconnect") return retry ? "Reconnect to try again." : "Reconnect to run agents there again.";
  return `Ask an organization owner or admin to ${kind === "ssh" ? "reconnect it" : "repair its connection"}.`;
}

function machineAttentionSentence(
  entry: MachineListEntry,
  counted: MachineAttentionReason | null,
  activeSessions: ReadonlyMap<string, number>,
  action: MachineAttentionAction,
  now: number,
): string {
  const active = activeSessions.get(entry.runnerId) ?? 0;
  const runner = entry.runner;
  const agents = runner?.agents.filter((agent) => !isRetiredCodexExec(agent)) ?? [];
  switch (entry.status) {
    case "unreachable":
      return `Wollipog couldn't reach it over SSH. ${reconnectHint(action, entry.kind, true)}`;
    case "failed":
      return `Its SSH connection failed. ${reconnectHint(action, entry.kind, true)}`;
    case "offline": {
      const seen = runner?.lastSeen ? `Last seen ${formatRecordedRelativeTime(runner.lastSeen, now)}` : "Offline";
      const withSessions = active > 0 ? ` with ${plural(active, "active session", "active sessions")}` : "";
      return `${seen}${withSessions}. ${reconnectHint(action, entry.kind, false)}`;
    }
    case "update_required": {
      if (runner && runnerOutdated(runner.protocolVersion)) return "Its runner is out of date.";
      const old = agents.filter(agentTooOld);
      return old.length === 1 ? `${old[0]!.name} is out of date.` : `${plural(old.length, "agent is", "agents are")} out of date.`;
    }
    case "approval_required": {
      const waiting = agents.filter((agent) => agent.registry?.installStatus === "approval-required");
      return waiting.length === 1
        ? `${waiting[0]!.name} from the ACP Registry is waiting for you to approve its launch.`
        : `${waiting.length} agents from the ACP Registry are waiting for you to approve their launch.`;
    }
    case "sign_in_required": {
      const accounts = runner?.providerAccounts?.filter((account) => account.authStatus === "unauthenticated").length ?? 0;
      if (accounts > 0) return `${plural(accounts, "account needs", "accounts need")} to sign in again.`;
      const signedOut = agents.filter(agentNeedsSignIn);
      return signedOut.length === 1 ? `${signedOut[0]!.name} needs you to sign in.` : `${signedOut.length} agents need you to sign in.`;
    }
    default:
      // Connecting, Bootstrapping or Deploying, yet counted by the rail's dot.
      return counted === "offline_with_active_sessions"
        ? `Its runner is offline with ${plural(active, "active session", "active sessions")}.`
        : "Its runner is out of date.";
  }
}

/** One Capacity row: a meter while the machine is online and reports its use. */
export type MachineCapacityRow =
  | { entry: MachineListEntry; kind: "meter"; used: number; limit: number; queued: number; warning: boolean }
  | { entry: MachineListEntry; kind: "offline" }
  | { entry: MachineListEntry; kind: "unknown" };

export interface MachinesOverviewCapacity {
  rows: MachineCapacityRow[];
  /** The machines past the first eight, with the units their online machines report. */
  rest: { count: number; units: UnitTotals | null } | null;
}

/** Capacity, in list order: one row per machine for the first eight, and the rest summed up. */
export function machinesOverviewCapacity(entries: readonly MachineListEntry[]): MachinesOverviewCapacity {
  const ordered = machineListOrder(entries);
  const shown = ordered.slice(0, MACHINES_OVERVIEW_CAPACITY_ROWS);
  const rest = ordered.slice(MACHINES_OVERVIEW_CAPACITY_ROWS);
  return {
    rows: shown.map(machineCapacityRow),
    rest: rest.length > 0 ? { count: rest.length, units: sumUnits(rest.filter((entry) => entry.online)) } : null,
  };
}

function machineCapacityRow(entry: MachineListEntry): MachineCapacityRow {
  if (!entry.online) return { entry, kind: "offline" };
  const used = entry.capacity?.usedUnits;
  if (!entry.capacity || used === undefined) return { entry, kind: "unknown" };
  const limit = entry.capacity.configuredUnits;
  return {
    entry,
    kind: "meter",
    used,
    limit,
    queued: entry.runner?.capacity?.queuedSessions ?? 0,
    warning: limit > 0 && used / limit >= MACHINE_CAPACITY_WARNING_SHARE,
  };
}

/** The meter's accessible name: "29 of 40 units in use". */
export function machineCapacityMeterLabel(used: number, limit: number): string {
  return `${used} of ${plural(limit, "unit", "units")} in use`;
}
