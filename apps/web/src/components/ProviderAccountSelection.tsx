import React, { useEffect, useState } from "react";
import {
  providerAccountChoiceRequiredSentence,
  providerAccountSelectionRecord,
  providerAccountSelectionSentence,
  providerAccountSkipSummary,
  providerForDriver,
  isProviderAccountRef,
  runnerSupportsProtocol,
  type ProviderAccountSelectionCandidate,
  type ProviderAccountSelectionPreview,
  type ProviderAccountSkipReason,
  type RunnerView,
} from "@wollipog/protocol";
import type { ProviderAccountSelectionTarget } from "../api.js";
import { useApi } from "../api-context.js";
import { subscriptionResetLabel } from "../account-unavailable-reasons.js";
import { statusMeta } from "../status-meta.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { FieldWarning } from "./FieldWarning.js";

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

/** An account's sign-in in the words Switch Account and Choose Another Account use (§11.2). */
export function providerAccountDescription(authStatus: "authenticated" | "unauthenticated" | "unknown" | undefined): string {
  const status = authStatus === "authenticated" ? "signed_in"
    : authStatus === "unauthenticated" ? "sign_in_required" : "status_unknown";
  const { label } = statusMeta("provider_account", status);
  return status === "sign_in_required" ? `${label} · Sign in again before using it.` : label;
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

/** How often a shown preview is read again, as usage and cooldowns move. */
export const PROVIDER_ACCOUNT_PREVIEW_REFRESH_MS = 60_000;

/** Where a launch would go, in the terms its request uses, so the server predicts that launch's own
 * project. A project is what was chosen, No Project is a choice too, and with neither (a server
 * without projects) the server infers it from the workspace, as it will at launch. */
export function providerAccountPreviewPlacement(input: {
  projectsSupported: boolean;
  projectId: string | null | undefined;
  /** Absent for a browsed path, which never joins a project by inference. */
  workspaceId: string | undefined;
}): Pick<ProviderAccountSelectionTarget, "projectId" | "workspaceId" | "noProject"> {
  return {
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : input.projectsSupported ? { noProject: "1" as const } : {}),
  };
}

/** Read the preview for one target, refreshing as usage and cooldowns move. A reading for another
 * target is never returned, so a dialog can't show the previous agent's account while it loads. */
export function useProviderAccountSelection(
  runnerId: string | undefined,
  target: ProviderAccountSelectionTarget | null,
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
    const timer = window.setInterval(() => void load(), PROVIDER_ACCOUNT_PREVIEW_REFRESH_MS);
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

const PROVIDER_NAME = { claude: "Claude", codex: "Codex" } as const;

/** Every automation run resolves its account when it starts, so a preview is only an expectation. */
export const AUTOMATION_ACCOUNT_RECHECK = "The account is rechecked when each run starts.";

/** Why no account can start a scheduled run (#4512). A launch dialog asks for a choice instead; an
 * automation still saves, and each run that starts before this changes is refused. */
export function providerAccountAutomationRefusalSentence(preview: ProviderAccountSelectionPreview): string {
  const name = PROVIDER_NAME[preview.provider];
  const skipped: Partial<Record<ProviderAccountSkipReason, number>> = {};
  for (const candidate of preview.candidates) {
    if (candidate.reason && candidate.position !== null) skipped[candidate.reason] = (skipped[candidate.reason] ?? 0) + 1;
  }
  const summary = providerAccountSkipSummary(skipped);
  switch (preview.refusal) {
    case "no_eligible_account":
      return `No ${name} account in this machine's Priority Order can start a run right now${summary ? ` (${summary})` : ""}.`;
    case "empty_order": return `This machine's ${name} Priority Order has no accounts.`;
    case "unsupported_mode": return `This machine's ${name} account policy was saved by a newer server, so this server can't apply it.`;
    case "account_memory": return `This project's memory is stored with each ${name} account on this machine, so Priority Order won't move it between accounts.`;
    case "runner_update_required": return `This machine's runner can't enforce the ${name} Priority Order.`;
    case "default_missing": return `This machine's ${name} Default Account is no longer on this machine.`;
    case "default_unavailable": return `This machine's ${name} Default Account isn't ready to start a run.`;
    default: return `This machine can't choose a ${name} account for a run by itself.`;
  }
}

/** What each run of a session automation is expected to use (#4512). An account the automation names
 * is what each run uses, since an explicit account beats the policy. Otherwise this is the same
 * preview as New Session, read even when the machine has no accounts left, because a saved Priority
 * Order or Default Account still refuses those runs. Nothing shows until a reading for this exact
 * target arrives, or when the read fails: a run still resolves for itself. */
export function AutomationExpectedProviderAccount({ runner, agentId, placement, namedAccountId, choosable = false, id }: {
  runner: RunnerView;
  agentId: string;
  /** The run's project placement, or null when it can't be derived (the editor shows that error). */
  placement: Pick<ProviderAccountSelectionTarget, "projectId" | "workspaceId" | "noProject"> | null;
  /** The account the automation itself names, if any. */
  namedAccountId?: string;
  /** Whether the form offers its own account choice, which a refusal can point to. */
  choosable?: boolean;
  id?: string;
}) {
  const agent = runner.agents.find((candidate) => candidate.id === agentId);
  const provider = agent ? providerForDriver(agent.driver ?? "acp") : null;
  // With neither accounts nor a saved policy for this provider there is nothing to bind or refuse. An
  // older runner's view omits both, though a saved Priority Order still refuses its launches, so only
  // a view that carries them can rule the preview out.
  const applies = provider !== null && (!runnerSupportsProtocol(runner.protocolVersion, "providerAccounts") ||
    (runner.providerAccounts ?? []).some((account) => account.provider === provider) ||
    (runner.providerAccountDefaults ?? []).some((policy) => policy.provider === provider));
  const preview = useProviderAccountSelection(runner.runnerId, applies && placement && !namedAccountId ? { agentId, ...placement } : null,
    providerAccountSelectionRefreshKey(runner, runner.status === "online"));
  if (namedAccountId) {
    const named = runner.providerAccounts?.find((candidate) => candidate.id === namedAccountId);
    if (named) {
      return (
        <p className="field-helper" id={id}>
          Each run uses{" "}
          <AccountIdentifier identity={`${runner.runnerId}:${named.id}`} value={named.label} label="Account Email" />,
          {" "}the account chosen for this automation.
        </p>
      );
    }
    // An agent or API caller may name an account by its opaque reference, which only the control
    // plane resolves (a digest this page can't compute everywhere), so it can't be called missing.
    if (isProviderAccountRef(namedAccountId)) {
      return (
        <p className="field-helper" id={id}>
          Each run uses the account this automation names. It was named by reference, so this page can't show which one.
        </p>
      );
    }
    return (
      <FieldWarning id={id}>
        The account chosen for this automation is no longer on this machine, so each run is refused when it starts.
      </FieldWarning>
    );
  }
  if (!preview || preview.status === "none") return null;
  if (preview.status === "choice_required") {
    return (
      <FieldWarning id={id}>
        {providerAccountAutomationRefusalSentence(preview)} Runs that start before this changes are refused.{" "}
        {choosable ? "Choose an account above, or review" : "Review"} this machine's Provider Accounts.
        {" "}You can still save. {AUTOMATION_ACCOUNT_RECHECK}
      </FieldWarning>
    );
  }
  const account = preview.accountId ? runner.providerAccounts?.find((candidate) => candidate.id === preview.accountId) : undefined;
  if (!account) return null;
  return (
    <p className="field-helper" id={id}>
      Each run is expected to use{" "}
      <AccountIdentifier identity={`${runner.runnerId}:${account.id}`} value={account.label} label="Account Email" />.{" "}
      {providerAccountExpectationSentence(preview)} {AUTOMATION_ACCOUNT_RECHECK}
    </p>
  );
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
