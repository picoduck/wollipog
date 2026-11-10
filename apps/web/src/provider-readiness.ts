import type { ProviderReadiness } from "@wollipog/protocol";
import { relativeTime } from "./format.js";

export function providerReadinessSentence(report: ProviderReadiness, current: boolean): string {
  const reason = {
    ready: "Sign-in confirmed.", sign_in_required: "Sign-in required.", in_use: "This sign-in is in use. Authentication was not inspected.",
    restricted: "This server cannot use this sign-in under its current access permissions.", unknown: "Sign-in status could not be confirmed.",
  }[report.reason];
  return `${current ? "" : "Last reported: "}${reason} Checked ${relativeTime(report.checkedAt)}.`;
}
