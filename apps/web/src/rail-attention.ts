import type { RunnerView, SessionView } from "@wollipog/protocol";
import type { GlobalViewName } from "./navigation.js";
import { WORK_IN_FLIGHT } from "./desktop-close-guard.js";
import { runnerOutdated } from "./runners.js";

/**
 * Why machines need the user (§11.2's machine vocabulary). Each machine is counted once, under its
 * more urgent reason. A machine that is merely online, idle or offline with nothing assigned to it
 * is normal and counts for neither.
 */
export interface MachineAttention {
  /** Offline while a session assigned to it has work in flight: that work is not progressing. */
  offlineWithActiveSessions: number;
  /** Connected with an older protocol than this dashboard's (Update Required). */
  updateRequired: number;
}

export const NO_MACHINE_ATTENTION: MachineAttention = { offlineWithActiveSessions: 0, updateRequired: 0 };

export function machineAttention(
  runners: Iterable<Pick<RunnerView, "runnerId" | "status" | "protocolVersion">>,
  sessions: Iterable<Pick<SessionView, "runnerId" | "status" | "archived">>,
): MachineAttention {
  const busy = new Set<string>();
  for (const session of sessions) {
    if (!session.archived && WORK_IN_FLIGHT[session.status]) busy.add(session.runnerId);
  }
  let offlineWithActiveSessions = 0;
  let updateRequired = 0;
  for (const runner of runners) {
    if (runner.status !== "online" && busy.has(runner.runnerId)) offlineWithActiveSessions += 1;
    else if (runnerOutdated(runner.protocolVersion)) updateRequired += 1;
  }
  return { offlineWithActiveSessions, updateRequired };
}

export interface RailAttentionState {
  /** Sessions waiting on the user (the Sessions list's Blocked). */
  blocked: number;
  /** Sessions whose runner stopped reporting progress (the Sessions list's Stalled). */
  stalled: number;
  machines: MachineAttention;
}

/**
 * The one attention mark a destination carries wherever it appears: the desktop rail, the phone tab
 * bar and a More sheet row (docs/design-system.md §11.4). `note` is its sentence-case breakdown, the
 * tooltip's second line and the item's accessible description; the accessible name stays the
 * destination's name.
 */
export type RailAttention =
  | { kind: "count"; count: number; tone: "warning" | "danger"; note: string }
  | { kind: "dot"; tone: "warning"; note: string };

export function railAttention(view: GlobalViewName, state: RailAttentionState): RailAttention | null {
  if (view === "inbox") {
    const blocked = Math.max(0, state.blocked);
    const stalled = Math.max(0, state.stalled);
    if (blocked + stalled === 0) return null;
    return {
      kind: "count",
      count: blocked + stalled,
      // Stalled is failing rather than waiting, so one stalled session turns the total red.
      tone: stalled > 0 ? "danger" : "warning",
      note: [blocked > 0 ? `${blocked} waiting on you` : "", stalled > 0 ? `${stalled} stalled` : ""]
        .filter(Boolean).join(", "),
    };
  }
  if (view === "runners") {
    const offline = Math.max(0, state.machines.offlineWithActiveSessions);
    const outdated = Math.max(0, state.machines.updateRequired);
    if (offline + outdated === 0) return null;
    return {
      kind: "dot",
      tone: "warning",
      note: [
        offline > 0 ? `${machines(offline)} offline with active sessions` : "",
        outdated > 0 ? `${outdated === 1 ? "1 machine needs" : `${outdated} machines need`} an update` : "",
      ].filter(Boolean).join(", "),
    };
  }
  return null;
}

function machines(count: number): string {
  return count === 1 ? "1 machine is" : `${count} machines are`;
}
