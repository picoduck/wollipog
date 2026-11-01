import type { PairingBlocker } from "../device-token.js";

/** The person's step line under the one Pair Device title (docs/design-system.md §7.2, #2999). */
export const PAIR_STEP_PERSON = "Step 1 of 2: Choose who it's for.";
export const PAIR_STEP_DEVICE = "Step 2 of 2: Name the device.";
export const SUSPENDED_REASON = "Suspended. Restore their access to pair a device.";
export const DEVICE_NAME_HELPER = "Use a name they'll recognize later, like Pixel 9 or Home Laptop.";
export const DEVICE_NAME_REQUIRED = "Name the device.";
export const SHOWN_ONCE = "The link works once and isn't shown again. Pair the device before you close this.";
export const SCAN_OR_COPY = "Scan the code with the device's camera, or copy the link and open it on the device.";
export const ADDRESS_HELPER = "Pick an address the device can reach.";
export const SAME_COMPUTER = "The link still works in another browser on this computer.";
export const MANUAL_SETUP_NOTE = "Use these only if the device can't open a link.";

/**
 * What a blocked result says (§13.2): a Title Case title and one sentence the person can act on,
 * then, behind Show Details, what an operator needs. `details` never reaches the DOM until opened.
 */
export interface PairingBlockedCopy {
  title: string;
  sentence: string;
  /** The resolving action: Open Network Settings, which also closes the dialog. */
  networkSettings: boolean;
  details?: { sentence: string; command?: string };
}

/** `serverDetail` is the remote-access setup's own message, kept for Show Details. */
export function pairingBlockedCopy(reason: PairingBlocker, serverDetail?: string): PairingBlockedCopy {
  switch (reason) {
    case "loopback":
      return {
        title: "Other Devices Can't Reach This Computer Yet",
        sentence: "Wollipog only listens on this computer, so a phone can't open the link. Turn on network access, then create a new link.",
        networkSettings: true,
        details: {
          sentence: "Operators can set CONTROL_PLANE_PUBLIC_ORIGIN to the address other devices reach this computer at, such as an HTTPS proxy or Tailscale Serve, or set CONTROL_PLANE_HOST=0.0.0.0 to listen on every network.",
        },
      };
    case "not-web-served":
      return {
        title: "This Computer Isn't Serving Wollipog's Pages",
        sentence: "Build Wollipog's web app on this computer, then create a new link.",
        networkSettings: false,
        details: { sentence: "Run this in the Wollipog checkout:", command: "pnpm --filter @wollipog/web build" },
      };
    case "remote-access":
      return {
        title: "Remote Access Needs Attention",
        sentence: "Finish setting up remote access in Network settings, then create a new link.",
        networkSettings: true,
        ...(serverDetail ? { details: { sentence: serverDetail } } : {}),
      };
    case "no-address":
      return {
        title: "No Network Address Found",
        sentence: "Connect this computer to a network, then create a new link.",
        networkSettings: false,
      };
  }
}
