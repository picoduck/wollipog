import type {
  ProviderAccountDefinition,
  ProviderAuthenticationAccountOption,
  SessionProviderAccountOption,
  SessionProviderAccountOptionsResponse,
  SessionProviderAccountUnavailable,
  SessionProviderAccountUnavailableReason,
  SessionView,
  SubscriptionUsageBucket,
  SubscriptionUsageSourceView,
} from "@wollipog/protocol";

export function providerForSessionAccountSwitch(
  driver: SessionView["driver"],
): "claude" | "codex" | null {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  return null;
}

/** Every same-Machine, same-provider account for an Authentication Required card. Unlike the
 * headroom chooser, recovery never hides an account: one that needs sign-in or whose status is
 * unknown stays visible with that state, and the runner rechecks any account before using it. */
export function providerAuthenticationAccountOptions(
  session: Pick<SessionView, "driver" | "runnerId" | "providerAccountId">,
  accounts: ProviderAccountDefinition[],
  sources: SubscriptionUsageSourceView[],
): ProviderAuthenticationAccountOption[] {
  const provider = providerForSessionAccountSwitch(session.driver);
  if (!provider) return [];
  return accounts.filter((account) => account.provider === provider).map((account) => {
    const source = sources.find((candidate) =>
      candidate.runnerId === session.runnerId && candidate.providerAccountId === account.id);
    return {
      id: account.id,
      label: account.label,
      authStatus: account.authStatus,
      availability: account.id === session.providerAccountId
        ? "current"
        : account.authStatus === "authenticated"
        ? "available"
        : account.authStatus === "unauthenticated"
        ? "sign_in_required"
        : "status_unknown",
      ...(source ? { usageState: source.state, buckets: source.buckets } : {}),
    };
  });
}

/** A window counts as used up from its latest reading only until its reset time passes, as the
 * runner's automatic switch counts it (#2304); a window with no reset time stays used up until a
 * newer reading says otherwise. */
function bucketExhausted(bucket: SubscriptionUsageBucket, now: number): boolean {
  if (bucket.resetsAt !== undefined && bucket.resetsAt <= now) return false;
  return bucket.status === "exhausted" || bucket.remainingPercent === 0 ||
    (bucket.usedPercent !== undefined && bucket.usedPercent >= 100);
}

/** The used-up window that keeps an account unavailable longest: one with no reset time, else the
 * one that resets last. */
function longestExhaustedWindow(exhausted: SubscriptionUsageBucket[]): SubscriptionUsageBucket | undefined {
  return exhausted.reduce<SubscriptionUsageBucket | undefined>((longest, bucket) =>
    !longest || (longest.resetsAt !== undefined &&
      (bucket.resetsAt === undefined || bucket.resetsAt > longest.resetsAt)) ? bucket : longest, undefined);
}

/** Split the session's same-Machine, same-provider accounts into the ones a switch may choose and
 * the ones it may not, each of those with a typed reason (#2276). Only signed-in accounts whose
 * latest provider windows do not report exhaustion are offered; unknown usage is not headroom, and a
 * window whose reset time is at or before `now` no longer reports exhaustion. The
 * session's own account is offered only while a failed switch to it is being retried, and is never
 * listed as unavailable.
 *
 * The unavailable list names accounts from the Machine's inventory, so it is filled only for a
 * requester who can already see that inventory (`listUnavailable`). A session can be shared with
 * people who cannot see its Machine; they get an empty list. */
export function providerAccountSwitchChoices(
  session: Pick<SessionView,
    "driver" | "runnerId" | "providerAccountId" | "providerAccountSwitchFailure"
  >,
  accounts: ProviderAccountDefinition[],
  sources: SubscriptionUsageSourceView[],
  { now, listUnavailable = true }: { now: number; listUnavailable?: boolean },
): Required<SessionProviderAccountOptionsResponse> {
  const offered: SessionProviderAccountOption[] = [];
  const unavailable: SessionProviderAccountUnavailable[] = [];
  const provider = providerForSessionAccountSwitch(session.driver);
  if (!provider) return { accounts: offered, unavailable };
  for (const account of accounts) {
    if (account.provider !== provider) continue;
    const own = account.id === session.providerAccountId;
    const retryingFailedAccount = session.providerAccountSwitchFailure?.providerAccountId === account.id;
    if (own && !retryingFailedAccount) continue;
    const reject = (reason: SessionProviderAccountUnavailableReason, exhaustedWindow?: SubscriptionUsageBucket) => {
      if (!own && listUnavailable) {
        unavailable.push({ id: account.id, label: account.label, reason, ...(exhaustedWindow ? { exhaustedWindow } : {}) });
      }
    };
    if (account.authStatus === "unauthenticated") { reject("signed_out"); continue; }
    if (account.authStatus !== "authenticated") { reject("sign_in_unknown"); continue; }
    const source = sources.find((candidate) =>
      candidate.runnerId === session.runnerId && candidate.providerAccountId === account.id);
    if (!source || source.state !== "available") { reject("usage_unknown"); continue; }
    const exhausted = source.buckets.filter((bucket) => bucketExhausted(bucket, now));
    if (exhausted.length) { reject("usage_exhausted", longestExhaustedWindow(exhausted)); continue; }
    offered.push({
      id: account.id,
      label: account.label,
      authStatus: account.authStatus,
      usageState: source.state,
      freshness: source.freshness,
      buckets: source.buckets,
    });
  }
  return { accounts: offered, unavailable };
}

/** The accounts a switch may choose: same-Machine, same-provider, signed-in accounts whose latest
 * provider windows do not report exhaustion at `now`. */
export function providerAccountSwitchOptions(
  session: Pick<SessionView,
    "driver" | "runnerId" | "providerAccountId" | "providerAccountSwitchFailure"
  >,
  accounts: ProviderAccountDefinition[],
  sources: SubscriptionUsageSourceView[],
  now: number,
): SessionProviderAccountOption[] {
  return providerAccountSwitchChoices(session, accounts, sources, { now }).accounts;
}
