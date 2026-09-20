/**
 * Managed-worktree guard provisioning for a native TUI launch (#1337).
 *
 * A TUI replays the session's persisted arguments and, before this, never re-ran launch
 * provisioning: a runner-owned worktree opened in the TUI carried neither the control-channel veto
 * (a TUI has no runner control channel at all) nor the guard hook, so a removal command against
 * the worktree ran under the provider's own permission rules. This runs exactly the provisioning a
 * runner-driven launch runs — a fresh settings document and a fresh protection list — and then the
 * driver's own pre-spawn preparation, so `guardActive` is read from the argv the TUI will launch
 * with rather than inferred from the protections existing.
 *
 * A Codex TUI (#1377) carries the same sidecar as a Codex `PreToolUse` hook installed through `-c`,
 * over the same per-session protections file; see `codex-managed-worktree-guard.ts` for what was
 * measured and why the launch's hook inventory is enumerated first.
 */

import { isOrchestratorLaunch } from "@wollipog/protocol";
import { CODEX_GUARD_DRIVERS } from "./codex-managed-worktree-guard.js";
import {
  defaultClaudeHookHost,
  prepareClaudeHookArgs,
  provisionClaudeHooks,
  provisionCodexGuard,
  type ClaudeHookHost,
} from "./hook-settings.js";
import type { verifyManagedWorktreeGuardLaunch } from "./managed-worktree-guard.js";
import type { ManagedWorktreeProtection } from "./managed-worktree-protection.js";
import type { SessionMeta } from "./session-store.js";

export interface AgentTuiGuardProvisioning {
  /** The session's live runner-owned worktrees; an empty list is a valid guarded state (#1303). */
  protections: readonly ManagedWorktreeProtection[];
  /** The argv this TUI spawn must use, with the runner-owned `--settings` injected or healed. */
  args: string[];
  /** Whether the guard really is in `args`, read from the settings document or argv it names. */
  guardActive: boolean;
  /** Why the guard is not active, when provisioning knows (the refusal carries it). */
  reason?: string;
}

export interface AgentTuiGuardConfig {
  controlPlaneUrl: string;
  controlPlaneProtocolVersion: number | null;
  enabled: boolean;
  allowInsecureTransport?: boolean;
  registerCredential?: (sessionId: string, tokenHash: string) => void;
  /**
   * The live runner-owned worktree set, from the same source the driver's veto reads. It is a
   * callback because it must be resolved HERE, after the launch's awaited preparation: the launch
   * snapshot predates the worktree proof and the Orchestrator's scratch and credential work, and
   * writing a stale inventory would overwrite the live refresh and leave a worktree created in
   * that window unprotected for the running provider as well.
   */
  protections: () => readonly ManagedWorktreeProtection[];
  /** Seam for tests: prove the guard sidecar actually refuses before relying on it. */
  verifyGuardLaunch?: typeof verifyManagedWorktreeGuardLaunch;
  /** Seam for tests: enumerate a Codex launch's effective hooks (#1377). */
  readCodexHookInventory?: Parameters<typeof provisionCodexGuard>[1]["readHookInventory"];
  platform?: NodeJS.Platform;
  /**
   * The runner's abstract verdict socket for this session, already proven (#1336 slice 3), or
   * `undefined` where there is none and the guard reads its file as before.
   */
  guardSocket?: (sessionId: string) => Promise<string | undefined>;
}

/**
 * Provision the guard for one TUI spawn. `spec.args` is rewritten in place exactly as a
 * runner-driven launch rewrites it, so callers must pass a copy of the durable metadata.
 */
export function provisionAgentTuiManagedWorktreeGuard(
  spec: SessionMeta,
  config: AgentTuiGuardConfig,
  log: (message: string) => void,
  host: ClaudeHookHost = defaultClaudeHookHost(),
  cwd: string = spec.worktreePath ?? spec.repoPath,
): AgentTuiGuardProvisioning | Promise<AgentTuiGuardProvisioning> {
  if (CODEX_GUARD_DRIVERS.has(spec.driver)) {
    return provisionAgentTuiCodexManagedWorktreeGuard(spec, config, log, host, cwd);
  }
  const {
    protections: resolveProtections,
    readCodexHookInventory: _readCodexHookInventory,
    platform: _platform,
    guardSocket,
    ...hookConfig
  } = config;
  if (guardSocket) {
    // A session deleted while the TUI was preparing is refused before a socket is opened for it;
    // the list itself is resolved again after the wait, so it is never older than the launch.
    resolveProtections();
    return guardSocket(spec.sessionId).then((socket) =>
      provisionClaudeTuiGuard(spec, hookConfig, resolveProtections, socket, log, host));
  }
  return provisionClaudeTuiGuard(spec, hookConfig, resolveProtections, undefined, log, host);
}

function provisionClaudeTuiGuard(
  spec: SessionMeta,
  hookConfig: Omit<AgentTuiGuardConfig, "protections" | "readCodexHookInventory" | "platform" | "guardSocket">,
  resolveProtections: AgentTuiGuardConfig["protections"],
  guardSocket: string | undefined,
  log: (message: string) => void,
  host: ClaudeHookHost,
): AgentTuiGuardProvisioning {
  // Resolved BEFORE anything is written, so a caller that refuses the launch from here (a session
  // deleted while the TUI was preparing) leaves no runner-owned files behind for it.
  const protections = resolveProtections();
  provisionClaudeHooks(
    spec,
    {
      ...hookConfig,
      managedWorktreeProtections: protections,
      ...(guardSocket ? { managedWorktreeGuardSocket: guardSocket } : {}),
      // A TUI does not replace the session's structured provider; both run against the same
      // per-session documents. So this provisioning may refresh the guard but never retire it.
      concurrentLaunch: true,
    },
    log,
    host,
  );
  // The same per-spawn heal, circuit check, and tripwire re-check the driver runs before every
  // Claude process it starts. A TUI is one more such spawn.
  const prepared = prepareClaudeHookArgs(spec.args);
  // A relayed manager hook (#1472) authenticates with a key from the spawn environment, never argv.
  if (prepared.env) spec.env = { ...spec.env, ...prepared.env };
  return {
    protections,
    args: prepared.args,
    guardActive: prepared.guardActive,
    ...(prepared.guardReason ? { reason: prepared.guardReason } : {}),
  };
}

/**
 * The Codex form (#1377). A session that owns a runner-created worktree is guarded or, through the
 * caller, refused — never opened unguarded.
 *
 * Since #1438 one that owns none is provisioned too, over an EMPTY list, exactly as a Claude TUI
 * has been since #1303: a TUI cannot be given a hook after it starts, so a worktree the session
 * acquires later is protected only if the hook was there from the beginning, reading the list the
 * live refresh keeps in step. The hook-trust rule is unchanged — the bypass is passed only when the
 * runner's hook is the sole untrusted one — but for a session with nothing to protect a failed
 * provisioning is NOT a refusal: the caller opens that TUI unguarded, as it always has, and the
 * runner says so if a worktree appears while it is still open.
 *
 * An Orchestrator preset launch (#1473) arrives with `--disable hooks`, which would keep the guard
 * out as well. For that launch alone the guard provisioning may drop the flag — provided it first
 * disables every foreign hook by key and proves the runner's hook is the only enabled one, so the
 * preset's "no user hooks" promise is kept exactly. A launch that cannot prove it keeps the flag.
 */
async function provisionAgentTuiCodexManagedWorktreeGuard(
  spec: SessionMeta,
  config: AgentTuiGuardConfig,
  log: (message: string) => void,
  host: ClaudeHookHost,
  cwd: string,
): Promise<AgentTuiGuardProvisioning> {
  // Refuses a deleted session before a socket is opened for it, exactly as the Claude form does.
  config.protections();
  const guardSocket = await config.guardSocket?.(spec.sessionId);
  // Resolved AFTER the wait: a worktree the session acquired meanwhile was put into the live list
  // by the refresh, and provisioning must not overwrite that with the older snapshot (review CR-1.1).
  const protections = config.protections();
  const guard = await provisionCodexGuard(
    spec,
    {
      protections,
      cwd,
      ...(guardSocket ? { guardSocket } : {}),
      platform: config.platform,
      verifyGuardLaunch: config.verifyGuardLaunch,
      readHookInventory: config.readCodexHookInventory,
      isolateForeignHooks: isOrchestratorLaunch(spec),
    },
    log,
    host,
  );
  return { protections, ...guard };
}
