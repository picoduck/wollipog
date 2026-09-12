/** Provider TUI launch policy. A TUI shares cwd and runner-local provider credentials with the
 * manager session, but never the structured driver's process, stdio, or provider session id. */

import type { SessionMeta } from "./session-store.js";
import type { ShellProcessLaunch } from "./shell-manager.js";
import { windowsCommandLine } from "./windows-conpty.js";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import {
  codexOrchestratorMcpArgs,
  supportsNativeOrchestratorBoundary,
  type OrchestratorIsolationMode,
} from "./orchestrator-preset.js";
import { windowsCmdInvocationSpec } from "./windows-cmd.js";

const TUI_DRIVERS = new Set(["claude-code", "codex", "codex-app-server"]);

/** Durable metadata intentionally omits credentials. Rebuild runner-owned launch state for
 * each TUI and probe at its exact cwd, including manual attachment after a runner restart. */
export async function prepareAgentTuiLaunch(
  meta: SessionMeta,
  dependencies: {
    controlPlaneProtocolVersion: number | null;
    provision(meta: SessionMeta): Promise<void> | void;
    prepareScratch(meta: SessionMeta): Promise<string>;
    probe?: typeof codexOrchestratorMcpArgs;
    platform?: NodeJS.Platform;
    executionIsolationMode?: OrchestratorIsolationMode;
  },
): Promise<ShellProcessLaunch | null> {
  if (meta.config?.permissionMode !== "orchestrator") return agentTuiLaunch(meta);
  if (!runnerSupportsProtocol(dependencies.controlPlaneProtocolVersion, "orchestratorNativeTui") ||
      meta.context.kind !== "native" || (meta.executionTarget && meta.executionTarget.adapter !== "host") ||
      !TUI_DRIVERS.has(meta.driver)) {
    throw new Error("Orchestrator Native TUI requires a current native host harness and control plane.");
  }
  if (!supportsNativeOrchestratorBoundary(
    meta.driver, dependencies.platform ?? process.platform, dependencies.executionIsolationMode,
  )) {
    throw new Error("Orchestrator Native TUI requires an attested native filesystem boundary for this harness.");
  }
  if (!["idle", "starting", "running", "input_required"].includes(meta.status)) {
    throw new Error("Orchestrator Native TUI requires an active session; resume the session first.");
  }
  const cwd = await dependencies.prepareScratch(meta);
  const prepared = { ...meta, args: [...meta.args], env: { ...meta.env } };
  await dependencies.provision(prepared);
  prepared.env = {
    ...prepared.env,
    ...((dependencies.platform ?? process.platform) === "win32" ? { TEMP: cwd, TMP: cwd } : { TMPDIR: cwd }),
  };
  if (prepared.driver !== "claude-code") {
    prepared.args.push(...await (dependencies.probe ?? codexOrchestratorMcpArgs)(
      prepared, cwd,
    ));
  }
  const launch = agentTuiLaunch(prepared);
  return launch ? { ...launch, cwd } : null;
}

function scrubInheritedEnv(driver: SessionMeta["driver"]): string[] {
  return driver === "claude-code"
    ? [
        "ANTHROPIC_API_KEY",
        "WOLLIPOG_CLAUDE_PERSISTENT",
        "WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS",
        "WOLLIPOG_CLAUDE_PENDING_MAX_MS",
        "MAM_CLAUDE_PERSISTENT",
        "MAM_CLAUDE_PERSISTENT_IDLE_MS",
        "MAM_CLAUDE_PENDING_MAX_MS",
      ]
    : ["OPENAI_API_KEY"];
}

export function agentTuiLaunch(
  meta: SessionMeta,
  host: { platform: NodeJS.Platform; comspec?: string } = {
    platform: process.platform,
    comspec: process.env.ComSpec,
  },
): ShellProcessLaunch | null {
  if (!meta.command || !TUI_DRIVERS.has(meta.driver)) return null;
  const scrub = scrubInheritedEnv(meta.driver);
  if (host.platform === "win32" && meta.context.kind === "native") {
    // Configured CLIs may be .cmd shims. ConPTY calls CreateProcess directly, so route the exact
    // non-prompt argv through cmd.exe with a single, cmd-specific quoting pass.
    const spec = windowsCmdInvocationSpec(meta.command, meta.args, host);
    const tail = spec.args.at(-1)!;
    return {
      command: spec.file,
      args: spec.args,
      env: meta.env,
      scrubInheritedEnv: scrub,
      // cmd.exe parses its /c tail itself. Wrapping the complete tail in one quote pair is the
      // canonical /s form; applying CommandLineToArgvW escaping to it again corrupts inner quotes.
      verbatimCommandLine: `${windowsCommandLine(spec.file, spec.args.slice(0, -1))} ${tail}`,
    };
  }
  return { command: meta.command, args: [...meta.args], env: meta.env, scrubInheritedEnv: scrub };
}
