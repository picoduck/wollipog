import type {
  NativeTuiAccountingBoundary,
  NativeTuiAccountingRequirement,
} from "@wollipog/protocol";

const CLAUDE_MISSING: NativeTuiAccountingRequirement[] = [
  "authoritative_usage_events",
  "stable_event_identity",
  "replay_watermark",
  "gap_detection",
];

const CODEX_MISSING: NativeTuiAccountingRequirement[] = [
  "pre_first_turn_binding",
  "stable_event_identity",
  "replay_watermark",
  "gap_detection",
];

/**
 * Publish only the contract boundary Wollipog can prove from live CLI discovery.
 *
 * Claude's stream-json transport is print mode, not its interactive TUI. Codex's token-usage
 * notification belongs to a separate app-server connection and has no replay cursor, watermark,
 * or gap marker. Neither may be projected as Native TUI usage, even when the installed CLI has
 * another session-id or token-usage surface.
 */
export function unavailableNativeTuiAccounting(
  provider: NativeTuiAccountingBoundary["provider"],
  installedVersion: string | undefined,
  structuredSurfaceAvailable: boolean,
): NativeTuiAccountingBoundary {
  const safeVersion = installedVersion && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,32})?$/.test(installedVersion)
    ? installedVersion
    : undefined;
  return {
    status: "unavailable",
    provider,
    ...(safeVersion ? { installedVersion: safeVersion } : {}),
    verification: installedVersion ? "live-cli-contract" : "provider-not-installed",
    nearestStructuredSurface: structuredSurfaceAvailable
      ? provider === "claude-code" ? "print-mode-only" : "separate-app-server"
      : "none",
    // Claude can accept a session id before its first turn, while Codex app-server emits a
    // thread-scoped token-usage notification. Record those narrow facts without treating either
    // provider's incomplete surface as an accounting contract.
    missingRequirements: [...(provider === "claude-code" ? CLAUDE_MISSING : CODEX_MISSING)],
  };
}
