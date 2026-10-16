/** Host-owned remote dashboard setup. Secrets are deliberately absent from this view. */
export interface RemoteAccessView {
  canConfigure: boolean;
  phase: "not_configured" | "ready" | "needs_authorization" | "needs_repair" | "unavailable";
  provider: "tailscale" | "https" | null;
  origin: string | null;
  message: string;
  /** A replacement may need attention while the active address remains ready. */
  setupPhase?: "needs_authorization" | "needs_repair";
  setupMessage?: string;
  authorizationUrl?: string;
  canDisable: boolean;
  verifiedAt: number | null;
}

export type RemoteAccessSetup =
  | { provider: "tailscale" }
  | { provider: "https"; origin: string };
