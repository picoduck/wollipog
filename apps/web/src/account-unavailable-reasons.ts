import type {
  ProviderAccountDefinition,
  SessionProviderAccountUnavailable,
  SubscriptionUsageBucket,
} from "@wollipog/protocol";

/** When a usage window resets, relative to `now`, as the Usage page and account rows say it. */
export function subscriptionResetLabel(timestamp: number, now = Date.now()): string {
  const difference = timestamp - now;
  if (difference <= 0) return "Reset time has passed";
  const minutes = Math.ceil(difference / 60_000);
  if (minutes < 60) return `Resets in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `Resets in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.ceil(hours / 24);
  return `Resets in ${days} days`;
}

function exhaustedReason(window: SubscriptionUsageBucket | undefined, now: number): string {
  if (!window) return "A usage window is used up.";
  // A reset time that has passed says nothing about when the account is usable again: the next
  // reading will tell, so the sentence names only the window.
  if (window.resetsAt === undefined || window.resetsAt <= now) return `The ${window.label} window is used up.`;
  return `The ${window.label} window is used up and ${subscriptionResetLabel(window.resetsAt, now).replace(/^Resets/, "resets")}.`;
}

/**
 * Why a Machine account cannot take over a session's conversation, as the one sentence an account
 * row shows under its title (#2276). Shared by Switch Account and Choose Another Account (#2208).
 *
 * The control plane decides the reason; this only words it. A code from a newer control plane that
 * this dashboard does not know still reads as unavailable.
 */
export function accountUnavailableReason(
  account: Pick<SessionProviderAccountUnavailable, "reason" | "exhaustedWindow">,
  machine: string,
  now = Date.now(),
): string {
  switch (account.reason) {
    case "signed_out": return `Signed out on ${machine}.`;
    case "sign_in_unknown": return `Sign-in status unknown on ${machine}.`;
    case "usage_unknown": return "No current usage reading is available.";
    case "usage_exhausted": return exhaustedReason(account.exhaustedWindow, now);
    default: return "Not available for this session right now.";
  }
}

/**
 * The reason for an account an older control plane (one that does not list unavailable accounts)
 * left out, from what the dashboard knows about it. Such a control plane offers only signed-in
 * accounts with usage headroom, and for a signed-in account it left out the dashboard cannot tell an
 * unknown reading from a used-up window, so the reason says only that no headroom was reported.
 */
export function derivedAccountUnavailableReason(
  account: Pick<ProviderAccountDefinition, "authStatus">,
  machine: string,
): string {
  if (account.authStatus === "unauthenticated") return accountUnavailableReason({ reason: "signed_out" }, machine);
  if (account.authStatus === "unknown") return accountUnavailableReason({ reason: "sign_in_unknown" }, machine);
  return "No usage headroom reported.";
}
