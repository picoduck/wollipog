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
    ...hookConfig
  } = config;
  // Resolved BEFORE anything is written, so a caller that refuses the launch from here (a session
  // deleted while the TUI was preparing) leaves no runner-owned files behind for it.
  const protections = resolveProtections();
  provisionClaudeHooks(
    spec,
    {
      ...hookConfig,
      managedWorktreeProtections: protections,
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
  return { protections, args: prepared.args, guardActive: prepared.guardActive };
}

/**
 * The Codex form (#1377). A session that owns no runner-created worktree opens exactly as before:
 * nothing is written and no probe runs. One that owns any is guarded or, through the caller,
 * refused — never opened unguarded.
 */
async function provisionAgentTuiCodexManagedWorktreeGuard(
  spec: SessionMeta,
  config: AgentTuiGuardConfig,
  log: (message: string) => void,
  host: ClaudeHookHost,
  cwd: string,
): Promise<AgentTuiGuardProvisioning> {
  const protections = config.protections();
  if (protections.length === 0) return { protections, args: spec.args, guardActive: false };
  const guard = await provisionCodexGuard(
    spec,
    {
      protections,
      cwd,
      platform: config.platform,
      verifyGuardLaunch: config.verifyGuardLaunch,
      readHookInventory: config.readCodexHookInventory,
    },
    log,
    host,
  );
  return { protections, ...guard };
}
