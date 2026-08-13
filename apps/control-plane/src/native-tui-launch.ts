import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type CreateSessionRequest,
  type SessionView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";

const TUI_DRIVERS = new Set(["claude-code", "codex", "codex-app-server"]);

export interface NativeTuiLaunchError {
  status: 400 | 404 | 409;
  error: string;
}

export interface RunnerAvailability {
  isRunnerOnline(runnerId: string): boolean;
}

export interface NativeTuiOpenResult {
  ok: boolean;
  status: number;
  error?: string;
  /** False when a timeout/disconnect leaves runner execution unknown. */
  definitive?: boolean;
  /** True when the ordinary session still exists and the client must recover it, not retry create. */
  retainedSession?: boolean;
}

export interface NativeTuiCompensationResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** Complete the one-shot creation intent, compensating the ordinary session on open failure. */
export async function openNativeTuiAtomically(
  sessionId: string,
  open: () => Promise<NativeTuiOpenResult>,
  removeSession: (sessionId: string) => NativeTuiCompensationResult | Promise<NativeTuiCompensationResult>,
): Promise<NativeTuiOpenResult> {
  let opened: NativeTuiOpenResult;
  try {
    opened = await open();
  } catch (error) {
    opened = {
      ok: false,
      status: 502,
      error: `Native TUI open failed: ${error instanceof Error ? error.message : String(error)}`,
      definitive: true,
    };
  }
  if (opened.ok || opened.definitive === false) return opened;
  let removed: NativeTuiCompensationResult;
  try {
    removed = await removeSession(sessionId);
  } catch (error) {
    removed = {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // Exact-id compensation is idempotent: a concurrent cleanup that already removed the session
  // reports 404, which is the desired postcondition rather than a cleanup failure.
  if (!removed.ok && removed.status !== 404) {
    return {
      ok: false,
      status: 500,
      error: `${opened.error ?? "Native TUI could not be opened"}; session cleanup failed: ${removed.error ?? "unknown cleanup error"}`,
      definitive: true,
      retainedSession: true,
    };
  }
  return opened;
}

function runnerError(
  db: ControlPlaneDb,
  online: RunnerAvailability,
  runnerId: string,
): NativeTuiLaunchError | null {
  const runner = db.getRunner(runnerId);
  if (!runner) return { status: 404, error: "runner not found" };
  if (!online.isRunnerOnline(runnerId)) return { status: 409, error: "runner is offline" };
  if (!runnerSupportsProtocol(runner.protocolVersion, "agentTuiMirror")) {
    return {
      status: 409,
      error: runnerCapabilityRequirement(
        runner.protocolVersion,
        "agentTuiMirror",
        "Native TUI launch",
      ),
    };
  }
  if (runner.os !== "windows" && runner.os !== "linux") {
    return { status: 409, error: "Native TUI requires a Windows or Linux runner" };
  }
  return null;
}

/** Reject unsupported Native TUI creation before an ordinary session row/process is materialized. */
export function nativeTuiCreationError(
  db: ControlPlaneDb,
  online: RunnerAvailability,
  request: CreateSessionRequest,
): NativeTuiLaunchError | null {
  if (request.launchSurface !== "native_tui") return null;
  const unavailable = runnerError(db, online, request.runnerId);
  if (unavailable) return unavailable;
  const runner = db.getRunner(request.runnerId);
  if (!runnerSupportsProtocol(runner?.protocolVersion, "sessionStartFencedShells")) {
    return {
      status: 409,
      error: runnerCapabilityRequirement(
        runner?.protocolVersion,
        "sessionStartFencedShells",
        "Initial Native TUI launch",
      ),
    };
  }
  if (request.agentId === "conductor") {
    return { status: 409, error: "Conductor does not expose a standalone Native TUI" };
  }
  const launch = db.getAgentLaunch(request.runnerId, request.agentId);
  if (!launch) return { status: 404, error: "agent not found on runner" };
  if (!TUI_DRIVERS.has(launch.driver ?? "acp")) {
    return { status: 409, error: "this agent does not expose a standalone Native TUI" };
  }
  if (request.executionTargetId) {
    const target = runner?.executionTargets?.find(
      (candidate) => candidate.id === request.executionTargetId,
    );
    if (target && target.adapter !== "host") {
      return { status: 409, error: "Native TUI currently requires a host execution target" };
    }
  }
  return null;
}

/** Re-check the materialized session before any Agent TUI shell row is created. */
export function nativeTuiSessionError(
  db: ControlPlaneDb,
  online: RunnerAvailability,
  session: SessionView,
  requireStartFence = false,
): NativeTuiLaunchError | null {
  const unavailable = runnerError(db, online, session.runnerId);
  if (unavailable) return unavailable;
  if (requireStartFence) {
    const protocolVersion = db.getRunner(session.runnerId)?.protocolVersion;
    if (!runnerSupportsProtocol(protocolVersion, "sessionStartFencedShells")) {
      return {
        status: 409,
        error: runnerCapabilityRequirement(
          protocolVersion,
          "sessionStartFencedShells",
          "Initial Native TUI launch",
        ),
      };
    }
  }
  if (session.agentId === "conductor") {
    return { status: 409, error: "Conductor does not expose a standalone Native TUI" };
  }
  if (!TUI_DRIVERS.has(session.driver)) {
    return { status: 409, error: "this session's agent does not expose a standalone Native TUI" };
  }
  if (session.executionTarget && session.executionTarget.adapter !== "host") {
    return { status: 409, error: "Native TUI currently requires a host execution target" };
  }
  return null;
}
