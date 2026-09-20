import type {
  ProviderAccountDefinition,
  SessionProviderAccountOption,
  SessionView,
  SubscriptionUsageSourceView,
} from "@wollipog/protocol";

export function providerForSessionAccountSwitch(
  driver: SessionView["driver"],
): "claude" | "codex" | null {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  return null;
}

/** Select only same-Machine, same-provider, signed-in accounts whose latest provider windows do
 * not report exhaustion. Unknown usage is not headroom and therefore stays out of the chooser. */
export function providerAccountSwitchOptions(
  session: Pick<SessionView,
    "driver" | "runnerId" | "providerAccountId" | "providerAccountSwitchFailure"
  >,
  accounts: ProviderAccountDefinition[],
  sources: SubscriptionUsageSourceView[],
): SessionProviderAccountOption[] {
  const provider = providerForSessionAccountSwitch(session.driver);
  if (!provider) return [];
  return accounts.flatMap((account) => {
    const retryingFailedAccount = session.providerAccountSwitchFailure?.providerAccountId === account.id;
    if (account.provider !== provider ||
        (account.id === session.providerAccountId && !retryingFailedAccount) ||
        account.authStatus !== "authenticated") return [];
    const source = sources.find((candidate) =>
      candidate.runnerId === session.runnerId && candidate.providerAccountId === account.id);
    if (!source || source.state !== "available") return [];
    const exhausted = source.buckets.some((bucket) =>
      bucket.status === "exhausted" || bucket.remainingPercent === 0 ||
      (bucket.usedPercent !== undefined && bucket.usedPercent >= 100));
    if (exhausted) return [];
    return [{
      id: account.id,
      label: account.label,
      authStatus: account.authStatus,
      usageState: source.state,
      freshness: source.freshness,
      buckets: source.buckets,
    }];
  });
}
