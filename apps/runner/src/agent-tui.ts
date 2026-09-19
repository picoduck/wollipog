/** Provider TUI launch policy. A TUI shares cwd and runner-local provider credentials with the
 * manager session, but never the structured driver's process, stdio, or provider session id. */

import { existsSync } from "node:fs";
import type { AgentTuiGuardProvisioning } from "./agent-tui-guard.js";
import type { SessionMeta } from "./session-store.js";
import type { ShellProcessLaunch } from "./shell-manager.js";
import { windowsCommandLine } from "./windows-conpty.js";
import { isOrchestratorLaunch, runnerSupportsProtocol, usesOrchestratorPresetPermissions } from "@wollipog/protocol";
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
    /**
     * Refuse a session deleted while this launch was awaiting its preparation, BEFORE `provision`
     * writes a runner-owned credential file or registers a credential (#1379).
     *
     * `delete_session` removes this session's agent-control files synchronously, and the
     * availability check that refuses the open (`sessionCanOpen`, in the shell-open handler) runs
     * only AFTER the launch has been built. Provisioning in that window therefore recreates
     * live-looking credential material for a session that no longer exists, and nothing removes it
     * until the next runner startup sweep. This is the agent-control counterpart of the refusal
     * #1337 gave the guard's protection source: refuse before the write, never clean up after it.
     */
    assertSessionNotDeleted(sessionId: string): void;
    /**
     * Runner-owned managed-worktree guard provisioning for this spawn (#1337, #1377). `cwd` is the
     * directory the TUI will run in, where a Codex launch's project-scoped hooks are resolved.
     */
    provisionManagedWorktreeGuard(
      spec: SessionMeta,
      cwd?: string,
    ): AgentTuiGuardProvisioning | Promise<AgentTuiGuardProvisioning>;
    prepareScratch(meta: SessionMeta): Promise<string>;
    probe?: typeof codexOrchestratorMcpArgs;
    platform?: NodeJS.Platform;
    executionIsolationMode?: OrchestratorIsolationMode;
  },
): Promise<ShellProcessLaunch | null> {
  if (!isOrchestratorLaunch(meta)) {
    return agentTuiLaunch(await withManagedWorktreeGuard(meta, dependencies));
  }
  if (!usesOrchestratorPresetPermissions(meta.config)) {
    // No runner control channel exists inside a TUI, so the additive role's routine-operation
    // contract cannot be honoured there; the coupled preset's static rules are the only TUI shape.
    throw new Error("Native TUI is unavailable for an Orchestrator with independent provider permissions.");
  }
  const platform = dependencies.platform ?? process.platform;
  if (!runnerSupportsProtocol(dependencies.controlPlaneProtocolVersion, "orchestratorNativeTui") ||
      meta.context.kind !== "native" || (meta.executionTarget && meta.executionTarget.adapter !== "host") ||
      !TUI_DRIVERS.has(meta.driver)) {
    throw new Error("Orchestrator Native TUI requires a current native host harness and control plane.");
  }
  const strictProjectIsolation = meta.orchestrator?.strictProjectIsolation !== false;
  if (strictProjectIsolation && !supportsNativeOrchestratorBoundary(
    meta.driver, platform, dependencies.executionIsolationMode,
  )) {
    throw new Error("Orchestrator Native TUI requires an attested native filesystem boundary for this harness.");
  }
  if (!["idle", "starting", "running", "input_required"].includes(meta.status)) {
    throw new Error("Orchestrator Native TUI requires an active session; resume the session first.");
  }
  const cwd = await dependencies.prepareScratch(meta);
  // Scratch preparation is awaited, so `meta` is a snapshot that predates it. A session deleted
  // inside that window is refused here, while provisioning still has written nothing (#1379).
  dependencies.assertSessionNotDeleted(meta.sessionId);
  const prepared = { ...meta, args: [...meta.args], env: { ...meta.env } };
  await dependencies.provision(prepared);
  if (strictProjectIsolation) {
    prepared.env = {
      ...prepared.env,
      ...(platform === "win32" ? { TEMP: cwd, TMP: cwd } : { TMPDIR: cwd }),
    };
  }
  if (prepared.driver !== "claude-code") {
    prepared.args.push(...await (dependencies.probe ?? codexOrchestratorMcpArgs)(
      prepared, cwd,
    ));
  }
  const launch = agentTuiLaunch(
    await withManagedWorktreeGuard(prepared, dependencies, cwd),
    { platform, comspec: process.env.ComSpec },
  );
  return launch ? { ...launch, cwd } : null;
}

const GUARDED_TUI_DRIVERS: ReadonlySet<string> = new Set(["claude-code", "codex", "codex-app-server"]);

/**
 * Carry the managed-worktree guard into a TUI launch, or refuse the launch (#1337, #1377).
 *
 * Before this, a TUI replayed the session's persisted arguments and never re-ran launch
 * provisioning, so a runner-owned worktree opened in the TUI had neither the control-channel veto
 * nor the guard hook. The guard is the ONLY interception point a TUI has: the mediation fallback
 * (`protectedClaudePermissionMode`) is driver-side, and a TUI runs no driver. So a session that
 * owns a runner-created worktree launches only when the guard really is in the argv this spawn
 * will use — the refusal the bug report allows, rather than an unprotected launch. A session that
 * owns none launches as it always did, guarded whenever the guard is provisionable.
 *
 * Codex's structured protection is driver-side as well, but Codex offers the same kind of
 * `PreToolUse` hook, so a Codex launch carries the same sidecar through `-c` (#1377). Its
 * provisioning can refuse for a reason the person opening the TUI can act on (untrusted hooks of
 * their own), so that reason is part of the error. Other providers have no guard mechanism and
 * are unchanged.
 */
async function withManagedWorktreeGuard(
  meta: SessionMeta,
  dependencies: Pick<
    Parameters<typeof prepareAgentTuiLaunch>[1], "provisionManagedWorktreeGuard"
  >,
  cwd?: string,
): Promise<SessionMeta> {
  if (!GUARDED_TUI_DRIVERS.has(meta.driver) || !meta.command) return meta;
  // Provisioning rewrites the launch arguments; durable metadata must not move under it.
  const prepared = { ...meta, args: [...meta.args] };
  const guard = await dependencies.provisionManagedWorktreeGuard(prepared, cwd);
  if (guard.protections.length > 0 && !guard.guardActive) {
    throw new Error(
      "Native TUI is unavailable for this session: its managed worktree guard could not be " +
      "provisioned, and a TUI carries no other refusal for a runner-owned worktree." +
      (guard.reason ? ` Reason: ${guard.reason}.` : ""),
    );
  }
  return { ...prepared, args: guard.args };
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

/**
 * `claude` refuses to start when `--settings` names a file that does not exist ("Settings file not
 * found"). A TUI launch replays the session's PERSISTED args, so a settings file that the startup
 * sweep removed would break the launch outright. Since #1337 the runner-owned document is
 * re-provisioned (and healed) before every Claude TUI launch, so what remains for this to drop is
 * what provisioning does not write: an agent-supplied `--settings` whose file is gone, and any
 * launch with no guard to provision. An inline JSON object (the Claude Orchestrator preset's
 * `{"disableAllHooks":true}`) names no file at all and is kept (#1378).
 */
function withoutMissingSettingsFiles(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index + 1];
    if (args[index] === "--settings" && value !== undefined && !isInlineSettingsDocument(value) && !existsSync(value)) {
      index += 1;
      continue;
    }
    result.push(args[index]!);
  }
  return result;
}

function isInlineSettingsDocument(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
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
  meta = { ...meta, args: withoutMissingSettingsFiles(meta.args) };
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
