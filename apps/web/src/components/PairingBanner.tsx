import React, { useState } from "react";
import { adoptManagedDesktopPairing, desktopLocalPairingFailure } from "../desktop-local-pairing.js";
import { DEVICE_TOKEN_CHANGED_EVENT, parsePairingInput, storeDeviceToken } from "../device-token.js";
import { Notice } from "./Notice.js";

export interface PairingBannerProps {
  /** A connection attempt is open right now. */
  connecting: boolean;
  /** Why the desktop app could not adopt its own managed credential, or null outside that case. */
  nativePairingFailure?: string | null;
  /** Adopts the desktop app's managed credential; false when another server owns the local port. */
  retryDesktopPairing?: () => Promise<boolean>;
}

/**
 * Shown when the /ui socket was policy-closed (1008): this device isn't paired (or was
 * revoked). Matters most for the INSTALLED iOS PWA — its storage is partitioned from Safari,
 * so a token adopted in the browser never carries over, and a standalone app has no address
 * bar to open a fresh `#pair=` link in. Pasting the token (or the whole link) here is the way in.
 *
 * The copy is in the person's terms (#2303), as the "Pair to Load Session" placeholder below it is;
 * the operator's way to reprint the startup link sits behind Show Details (§12.5, §13.2).
 */
export function PairingBanner({
  connecting,
  nativePairingFailure = desktopLocalPairingFailure(),
  retryDesktopPairing = adoptManagedDesktopPairing,
}: PairingBannerProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const submit = () => {
    const token = parsePairingInput(value);
    if (!token) {
      setError("that doesn't look like a pairing token or link");
      return;
    }
    storeDeviceToken(token);
    setSubmitted(true);
    // Reconnect IN-PROCESS (no reload): when localStorage is blocked the token lives only in
    // this page's memory — a reload would drop it and loop straight back to this card.
    window.dispatchEvent(new Event(DEVICE_TOKEN_CHANGED_EVENT));
  };
  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      const adopted = await retryDesktopPairing();
      if (!adopted) {
        throw new Error("Another Wollipog is already running on this computer. Paste a pairing link or token from it to pair with it.");
      }
      window.dispatchEvent(new Event(DEVICE_TOKEN_CHANGED_EVENT));
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "the desktop could not retry local pairing");
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Notice
      pageBanner
      tone="warning"
      role="status"
      actions={(
        <span className="pairing-controls">
          {nativePairingFailure && (
            <button
              type="button"
              className="btn secondary sm"
              onClick={() => void retry()}
              disabled={retrying || connecting}
            >
              {retrying ? "Retrying…" : "Retry Pairing"}
            </button>
          )}
          <input
            type="password"
            value={value}
            maxLength={2048}
            placeholder="#pair=… link or token"
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
              setSubmitted(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            aria-label="Pairing Token"
          />
          <button type="button" className="btn primary sm" onClick={submit} disabled={!value.trim() || connecting}>
            {connecting ? "Pairing…" : "Pair"}
          </button>
        </span>
      )}
      details={(
        <p className="pairing-details">
          The computer running Wollipog prints a pairing link when it starts. To print it again, run{" "}
          <code>wollipog pair url</code> there, or start Wollipog with <code>--print-pair-url</code>.
        </p>
      )}
    >
      {nativePairingFailure
        ? "This app couldn't pair itself with Wollipog. Retry pairing, or paste a pairing link or token here."
        : "Pair this device to use Wollipog: open a pairing link on it, or paste the link or token here. An owner or admin can create one in Connections › People & Devices."}
      {/* The banner is the live region; a nested alert would announce the error twice. */}
      {error && <p className="notice-error">{error}</p>}
      {submitted && !error && !connecting && (
        <p className="notice-error">Still not accepted. Check the token or pair a fresh one.</p>
      )}
    </Notice>
  );
}
