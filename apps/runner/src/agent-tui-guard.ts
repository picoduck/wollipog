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
 */

import {
  defaultClaudeHookHost,
  prepareClaudeHookArgs,
  provisionClaudeHooks,
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
  /** Whether the guard really is in `args`, read from the settings document it names. */
  guardActive: boolean;
}

export interface AgentTuiGuardConfig {
  controlPlaneUrl: string;
  controlPlaneProtocolVersion: number | null;
  enabled: boolean;
  allowInsecureTransport?: boolean;
  registerCredential?: (sessionId: string, tokenHash: string) => void;
  /** The live runner-owned worktree set, from the same source the driver's veto reads. */
  protections: readonly ManagedWorktreeProtection[];
  /** Seam for tests: prove the guard sidecar actually refuses before relying on it. */
  verifyGuardLaunch?: typeof verifyManagedWorktreeGuardLaunch;
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
): AgentTuiGuardProvisioning {
  const { protections, ...hookConfig } = config;
  provisionClaudeHooks(spec, { ...hookConfig, managedWorktreeProtections: protections }, log, host);
  // The same per-spawn heal, circuit check, and tripwire re-check the driver runs before every
  // Claude process it starts. A TUI is one more such spawn.
  const prepared = prepareClaudeHookArgs(spec.args);
  return { protections, args: prepared.args, guardActive: prepared.guardActive };
}
