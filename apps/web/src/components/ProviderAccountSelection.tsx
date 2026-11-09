import React, { useEffect, useState } from "react";
import {
  providerAccountChoiceRequiredSentence,
  providerAccountSelectionRecord,
  providerAccountSelectionSentence,
  providerAccountSkipSummary,
  type ProviderAccountSelectionCandidate,
  type ProviderAccountSelectionPreview,
  type ProviderAccountSkipReason,
  type RunnerView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { subscriptionResetLabel } from "../account-unavailable-reasons.js";
import { AccountIdentifier } from "./AccountIdentifier.js";

/**
 * What a launch without a chosen account would do (#4353). Every reading comes from the control
 * plane's preview, which runs the launch's own resolver, so a screen can't promise another account.
 * A preview promises nothing: the launch resolves again, and a failed read shows no expectation.
 */

/** Sentence fragments for "Skipped: …", shorter than the refusal sentences' wording. */
const SKIP_LABEL: Readonly<Record<ProviderAccountSkipReason, string>> = {
  not_ranked: "not in the Priority Order",
  missing: "no longer on this machine",
  access_not_granted: "not available to this server",
  access_pending: "server access still being confirmed",
  access_refused: "server access was revoked",
  signed_out: "needs sign-in",
  sign_in_unknown: "sign-in couldn't be confirmed",
  context_incompatible: "can't run in this agent's environment",
  api_billing: "would spend API credits",
  billing_unknown: "billing couldn't be verified",
  cooldown: "recently hit a usage limit",
  usage_exhausted: "at a usage limit",
  spend_limit_reached: "spend limit reached",
};

/** "Skipped: at a usage limit (Session Window). Resets in 2 hours." It names the window or spend
 * control, because the row's usage summary may be about another, and never the account. A cooldown
 * isn't a provider's reset, so it says when the account is available again. */
export function providerAccountSkipLabel(candidate: Pick<ProviderAccountSelectionCandidate, "reason" | "retryAt" | "limitLabel">, now = Date.now()): string | undefined {
  if (!candidate.reason || candidate.reason === "not_ranked") return undefined;
  const limit = candidate.limitLabel ? ` (${candidate.limitLabel})` : "";
  const reset = candidate.retryAt !== undefined && candidate.retryAt > now ? subscriptionResetLabel(candidate.retryAt, now) : null;
  const when = reset === null ? "" : ` ${candidate.reason === "cooldown" ? reset.replace(/^Resets in/u, "Available again in") : reset}.`;
  return `Skipped: ${SKIP_LABEL[candidate.reason]}${limit}.${when}`;
}

/** Everything a preview reads from the Machine, so it refreshes when any of them change. */
export function providerAccountSelectionRefreshKey(runner: RunnerView | undefined, online: boolean): string {
  if (!runner) return "";
  return JSON.stringify([
    online,
    runner.protocolVersion,
    runner.providerAccountDefaults,
    runner.providerAccounts?.map((account) => [account.id, account.authStatus, account.billing, account.selectionCooldownUntil, account.profile?.access]),
    runner.agents.map((agent) => [agent.id, agent.available, agent.providerAccountReadiness]),
  ]);
}

const REFRESH_MS = 60_000;

/** Read the preview for one target, refreshing as usage and cooldowns move. A reading for another
 * target is never returned, so a dialog can't show the previous agent's account while it loads. */
export function useProviderAccountSelection(
  runnerId: string | undefined,
  target: { agentId?: string; provider?: "claude" | "codex"; projectId?: string } | null,
  refreshKey: string,
): ProviderAccountSelectionPreview | null {
  const api = useApi();
  const key = runnerId && target ? JSON.stringify([runnerId, target]) : null;
  const [reading, setReading] = useState<{ key: string; preview: ProviderAccountSelectionPreview } | null>(null);
  useEffect(() => {
    if (!key || !runnerId || !target) return;
    let current = true;
    const load = async () => {
      try {
        const preview = await api.providerAccountSelection(runnerId, target);
        if (current) setReading({ key, preview });
      } catch {
        // An unreadable preview means no expectation is shown; the launch still resolves for itself.
        if (current) setReading(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => { current = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` and `refreshKey` carry the target and everything it reads
  }, [key, refreshKey]);
  return reading?.key === key ? reading.preview : null;
}

/** Why the preview expects this account, or why it can't pick one, in plain language. */
export function providerAccountExpectationSentence(preview: ProviderAccountSelectionPreview): string {
  return preview.status === "choice_required" && preview.refusal
    ? providerAccountChoiceRequiredSentence(preview.provider, preview.refusal, preview.candidates)
    : providerAccountSelectionSentence(providerAccountSelectionRecord(preview));
}

/** Why Provider Accounts has no expected account. Unlike a launch's refusal, it speaks about new
 * sessions in general and from this page, where the accounts in question are listed just below. */
export function providerAccountGroupRefusalSentence(preview: ProviderAccountSelectionPreview, providerName: string): string {
  if (preview.refusal === "empty_order") {
    return `This Priority Order has no accounts. Add one from its menu so new ${providerName} sessions can choose it.`;
  }
  if (preview.refusal !== "no_eligible_account") return providerAccountExpectationSentence(preview);
  const skipped: Partial<Record<ProviderAccountSkipReason, number>> = {};
  for (const candidate of preview.candidates) {
    if (candidate.reason && candidate.position !== null) skipped[candidate.reason] = (skipped[candidate.reason] ?? 0) + 1;
  }
  const summary = providerAccountSkipSummary(skipped);
  return `No account in this Priority Order can start a new ${providerName} session right now${summary ? ` (${summary})` : ""}. ` +
    "Until one can, each new session needs an account chosen when it starts.";
}

/** The expected account beside a launch that doesn't choose one, and why. */
export function ExpectedProviderAccount({ runner, preview, providerName }: {
  runner: Pick<RunnerView, "runnerId" | "providerAccounts">;
  preview: ProviderAccountSelectionPreview;
  /** Named when one surface lists several providers. */
  providerName?: string;
}) {
  const account = preview.accountId ? runner.providerAccounts?.find((candidate) => candidate.id === preview.accountId) : undefined;
  if (preview.status === "none" || (preview.status === "selected" && !account)) return null;
  return (
    <p className="field-helper">
      {preview.status === "selected" && account && (
        <>
          {providerName ? `${providerName} sessions use ` : "New sessions use "}
          <AccountIdentifier identity={`${runner.runnerId}:${account.id}`} value={account.label} label="Account Email" />.{" "}
        </>
      )}
      {providerAccountExpectationSentence(preview)}
    </p>
  );
}
