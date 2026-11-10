import type { ProviderReadiness } from "@wollipog/protocol";
import { relativeTime } from "./format.js";

export function providerReadinessSentence(report: ProviderReadiness, current: boolean): string {
  // Discovery refreshes every five minutes. A disconnected or replayed report older than two
  // refresh windows remains useful history, never a fresh authentication assertion.
  current = current && Date.now() - report.checkedAt <= 10 * 60_000;
  const reason = {
    ready: "Sign-in confirmed.", sign_in_required: "Sign-in required.", in_use: "This sign-in is in use. Authentication was not inspected.",
    restricted: "This server cannot use this sign-in under its current access permissions.", unknown: "Sign-in status could not be confirmed.",
  }[report.reason];
  return `${current ? "" : "Last reported: "}${reason} Checked ${relativeTime(report.checkedAt)}.`;
}
