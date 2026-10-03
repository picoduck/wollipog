import React, { useEffect, useState } from "react";
import { CONTROL_PLANE_HTTP, DEVELOPMENT_BUILD } from "../config.js";
import { Notice } from "./Notice.js";

export interface OfflineBannerProps {
  /** A connection attempt is open right now, whether the store's own retry or Retry Now. */
  connecting: boolean;
  /** Starts an attempt now; returns false when there was no pending retry to bring forward. */
  onRetryNow: () => boolean;
  /** Shows the control-plane address and the `pnpm dev` hint. Only a Vite dev-server build does. */
  developmentBuild?: boolean;
  controlPlaneOrigin?: string;
}

/**
 * The offline page banner (docs/design-system.md §12.5, §13.3): one user sentence and Retry Now.
 * Developer hints sit behind Show Details in a development build only.
 */
export function OfflineBanner({
  connecting,
  onRetryNow,
  developmentBuild = DEVELOPMENT_BUILD,
  controlPlaneOrigin = CONTROL_PLANE_HTTP,
}: OfflineBannerProps) {
  // The banner is a live region, so only an attempt the person started changes the label; the
  // store's own retries every 1.5s would otherwise announce "Retrying…" over and over.
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!connecting) setRequested(false);
  }, [connecting]);
  const busy = requested && connecting;
  const retryNow = () => {
    if (connecting) return;
    if (onRetryNow()) setRequested(true);
  };
  return (
    <Notice pageBanner className="offline-banner" tone="warning" role="status" actions={(
      // aria-disabled rather than disabled keeps keyboard focus on the button through the attempt.
      <button
        type="button"
        className="btn secondary sm"
        aria-busy={busy || undefined}
        aria-disabled={connecting || undefined}
        onClick={retryNow}
      >
        {busy ? "Retrying…" : "Retry Now"}
      </button>
    )}>
      Can't reach Wollipog on this machine. Reconnecting…
      {developmentBuild && (
        <details className="notice-details">
          <summary>Show Details</summary>
          Nothing answers at <code>{controlPlaneOrigin}</code>. Start it (for the local stack, run{" "}
          <code>pnpm dev</code>) and the page reconnects on its own.
        </details>
      )}
    </Notice>
  );
}
