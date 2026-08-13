import type { SessionView } from "@wollipog/protocol";
import { formatCost, formatTokens } from "./format.js";

/** Compact, screen-reader-friendly usage summary for the Inbox session surface. */
export function sessionPreviewUsage(
  session: Pick<SessionView, "contextTokensUsed" | "contextWindow" | "tokensIn" | "tokensOut" | "costUsd">,
): string | null {
  const used = session.contextTokensUsed ?? session.tokensIn + session.tokensOut;
  const context = session.contextWindow;
  const parts: string[] = [];
  if (context != null && context > 0) parts.push(`${formatTokens(used)} of ${formatTokens(context)} context`);
  else if (used > 0) parts.push(`${formatTokens(used)} tokens`);
  const cost = formatCost(session.costUsd);
  if (cost) parts.push(cost);
  return parts.length ? parts.join(" · ") : null;
}
