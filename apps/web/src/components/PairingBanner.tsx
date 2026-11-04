import React, { useCallback, useEffect, useState } from "react";
import { adoptManagedDesktopPairing, desktopLocalPairingFailure } from "../desktop-local-pairing.js";
import { DEVICE_TOKEN_CHANGED_EVENT } from "../device-token.js";
import type { ConnState } from "../store.js";
import { Notice } from "./Notice.js";
import { PairThisDeviceDialog } from "./PairThisDeviceDialog.js";
import { BusyButton } from "./ui/BusyButton.js";

export interface PairingBannerProps {
  /** The connection's state: whether an attempt is open, and whether a stored link was accepted. */
  conn: ConnState;
  /** Why the desktop app could not adopt its own managed credential, or null outside that case. */
  nativePairingFailure?: string | null;
  /** Adopts the desktop app's managed credential; false when another server owns the local port. */
  retryDesktopPairing?: () => Promise<boolean>;
}

/**
 * Shown when the /ui socket was policy-closed (1008): this device isn't paired (or was
 * revoked). Matters most for the INSTALLED iOS PWA — its storage is partitioned from Safari,
 * so a token adopted in the browser never carries over, and a standalone app has no address
 * bar to open a fresh `#pair=` link in. Pair This Device… is the way in.
 *
 * The banner is one sentence and its actions (#3005; docs/design-system.md §12.5, §13.3): the field,
 * its errors and where to find a link are Pair This Device's, a dialog. In the desktop app, when it
 * could not read its own managed pairing, Retry Pairing tries again and Paste a Link… opens the same
 * dialog; the desktop's own words for the failure stay behind Show Details.
 */
export function PairingBanner({
  conn,
  nativePairingFailure = desktopLocalPairingFailure(),
  retryDesktopPairing = adoptManagedDesktopPairing,
}: PairingBannerProps) {
  const connecting = conn === "connecting";
  const [dialogOpen, setDialogOpen] = useState(false);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  // Another Wollipog owns the local port: its own pairing link is the only way in.
  const [portTaken, setPortTaken] = useState(false);
  const [failureDetail, setFailureDetail] = useState(nativePairingFailure);
  const [retrying, setRetrying] = useState(false);
  // Busy from the press through the reconnect an adopted credential starts, as Retry Now is.
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    if (!connecting) setReconnecting(false);
  }, [connecting]);

  const retry = async () => {
    if (retrying || reconnecting || connecting) return;
    setRetrying(true);
    try {
      const adopted = await retryDesktopPairing();
      setPortTaken(!adopted);
      if (adopted) {
        setFailureDetail(null);
        setReconnecting(true);
        window.dispatchEvent(new Event(DEVICE_TOKEN_CHANGED_EVENT));
      }
    } catch (retryError) {
      setPortTaken(false);
      setFailureDetail(retryError instanceof Error ? retryError.message : null);
    } finally {
      setRetrying(false);
    }
  };

  // A retry that finds the port taken clears the desktop's recorded failure, but this is still the
  // desktop app's banner: once seen, the failure keeps it.
  const [desktop, setDesktop] = useState(nativePairingFailure != null);
  if (nativePairingFailure != null && !desktop) setDesktop(true);
  const sentence = !desktop
    ? "This device isn't paired with Wollipog yet."
    : portTaken
      ? "Another Wollipog is already running on this computer. Paste a pairing link from it."
      : "This app couldn't read its saved pairing, so it can't connect.";
  const openDialog = () => setDialogOpen(true);
  return (
    <>
      <Notice
        pageBanner
        tone="warning"
        role="status"
        actions={desktop ? (
          <>
            <BusyButton
              className="btn sm"
              busy={retrying || (reconnecting && connecting)}
              progress="Retrying pairing…"
              aria-disabled={connecting || undefined}
              onClick={() => void retry()}
            >
              Retry Pairing
            </BusyButton>
            <button type="button" className="btn sm" aria-haspopup="dialog" onClick={openDialog}>Paste a Link…</button>
          </>
        ) : (
          <button type="button" className="btn sm primary" aria-haspopup="dialog" onClick={openDialog}>Pair This Device…</button>
        )}
        details={desktop && !portTaken && failureDetail ? <code>{failureDetail}</code> : undefined}
      >
        {sentence}
      </Notice>
      {dialogOpen && <PairThisDeviceDialog conn={conn} onClose={closeDialog} />}
    </>
  );
}
