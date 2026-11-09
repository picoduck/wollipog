import type { SubscriptionUsageBucket, SubscriptionUsageSourceView } from "@wollipog/protocol";

/**
 * Reset times of one window can differ by provider rounding between reads. A real new window lands
 * at least a window's length later, so anything closer than this is the same window.
 */
const SAME_WINDOW_TOLERANCE_MS = 5 * 60_000;

/** One subscription on the Subscriptions tab, however many machines are signed in to it. */
export interface SubscriptionAccountGroup {
  key: string;
  /** What the card shows. The source itself when it stands alone, otherwise the merged readings. */
  account: SubscriptionUsageSourceView;
  members: readonly SubscriptionUsageSourceView[];
  machineCount: number;
  hasWindows: boolean;
  /** Only a Codex account can be asked for its usage; Claude's arrives with session responses. */
  refreshTargets: ReadonlyArray<{ runnerId: string; providerAccountId: string }>;
}

/** `newer` was read later. A later window beats it anyway; within one window its fields win, and
 * the fields it did not report (a status-only event's percentage) stay as last known. */
function mergeWindow(newer: SubscriptionUsageBucket, older: SubscriptionUsageBucket): SubscriptionUsageBucket {
  if (newer.resetsAt !== undefined && older.resetsAt !== undefined &&
      Math.abs(newer.resetsAt - older.resetsAt) > SAME_WINDOW_TOLERANCE_MS) {
    return newer.resetsAt > older.resetsAt ? newer : older;
  }
  return { ...older, ...newer };
}

function mergedAccount(members: readonly SubscriptionUsageSourceView[]): SubscriptionUsageSourceView {
  const reporting = members.filter((member) => member.buckets.length > 0);
  // Newest first. Machines report at different times, and a Claude machine only when it is in use.
  const ranked = [...(reporting.length > 0 ? reporting : members)].sort((left, right) => right.fetchedAt - left.fetchedAt);
  const newest = ranked[0]!;
  const buckets = new Map<string, SubscriptionUsageBucket>();
  for (const member of ranked) {
    for (const bucket of member.buckets) {
      const newer = buckets.get(bucket.id);
      buckets.set(bucket.id, newer ? mergeWindow(newer, bucket) : bucket);
    }
  }
  const plan = ranked.find((member) => member.plan)?.plan;
  const accountLabel = ranked.find((member) => member.accountLabel)?.accountLabel;
  const credits = ranked.find((member) => member.credits)?.credits;
  const spendControls = ranked.find((member) => member.spendControls?.length)?.spendControls;
  return {
    ...newest,
    buckets: [...buckets.values()],
    freshness: ranked.some((member) => member.freshness === "fresh") ? "fresh" : "stale",
    runnerStatus: ranked.find((member) => member.runnerStatus !== "offline")?.runnerStatus ?? newest.runnerStatus,
    ...(plan ? { plan } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(credits ? { credits } : {}),
    ...(spendControls ? { spendControls } : {}),
  };
}

/**
 * Collapses sources into subscriptions by the control plane's `subscriptionKey`. A source without
 * one stands alone: a matching label or plan is never evidence, because a wrong merge would hide a
 * real subscription's allowance.
 */
export function subscriptionAccountGroups(sources: readonly SubscriptionUsageSourceView[]): SubscriptionAccountGroup[] {
  const byKey = new Map<string, SubscriptionUsageSourceView[]>();
  for (const source of sources) {
    const key = source.subscriptionKey ?? `${source.runnerId}:${source.sourceId}`;
    const members = byKey.get(key);
    if (members) members.push(source);
    else byKey.set(key, [source]);
  }
  return [...byKey].map(([key, members]) => ({
    key,
    account: members.length === 1 ? members[0]! : mergedAccount(members),
    members,
    machineCount: new Set(members.map((member) => member.runnerId)).size,
    hasWindows: members.some((member) => member.buckets.length > 0),
    refreshTargets: members.flatMap((member) => member.provider === "codex" && member.providerAccountId
      ? [{ runnerId: member.runnerId, providerAccountId: member.providerAccountId }]
      : []),
  }));
}
