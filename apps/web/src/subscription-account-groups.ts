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
  /** The accounts the control plane says can be read on request. An older control plane says
   * nothing, and there only a Codex account could be. */
  refreshTargets: ReadonlyArray<{ runnerId: string; providerAccountId: string }>;
}

const STATUS_SEVERITY: Readonly<Record<NonNullable<SubscriptionUsageBucket["status"]>, number>> = {
  available: 0,
  warning: 1,
  exhausted: 2,
};

/** The worse of two statuses of one window. A status arrives apart from the percentage it sits
 * beside, so a machine with an older percentage can hold the latest word that a limit was reached.
 * Showing that for the rest of the window is the safe error; hiding it is not. */
function worseStatus(
  left: SubscriptionUsageBucket["status"],
  right: SubscriptionUsageBucket["status"],
): SubscriptionUsageBucket["status"] {
  if (!left || !right) return left ?? right;
  return STATUS_SEVERITY[left] >= STATUS_SEVERITY[right] ? left : right;
}

/** `newer` was read later. A later window beats it anyway; within one window its fields win, and
 * the fields it did not report (a status-only event's percentage) stay as last known. */
function mergeWindow(newer: SubscriptionUsageBucket, older: SubscriptionUsageBucket): SubscriptionUsageBucket {
  if (newer.resetsAt !== undefined && older.resetsAt !== undefined &&
      Math.abs(newer.resetsAt - older.resetsAt) > SAME_WINDOW_TOLERANCE_MS) {
    return newer.resetsAt > older.resetsAt ? newer : older;
  }
  const status = worseStatus(newer.status, older.status);
  return { ...older, ...newer, ...(status ? { status } : {}) };
}

function mergedAccount(members: readonly SubscriptionUsageSourceView[]): SubscriptionUsageSourceView {
  const reporting = members.filter((member) => member.buckets.length > 0);
  // Newest first. Machines report at different times, and a Claude machine only when it is in use.
  const ranked = [...(reporting.length > 0 ? reporting : members)].sort((left, right) => right.fetchedAt - left.fetchedAt);
  const newest = ranked[0]!;
  // A snapshot's time moves on with any update, so each window compares by when it was itself
  // reported. An older runner dates nothing, and its snapshot's time is the best evidence left.
  const readings = new Map<string, Array<{ bucket: SubscriptionUsageBucket; at: number }>>();
  for (const member of ranked) {
    for (const bucket of member.buckets) {
      const reading = { bucket, at: bucket.observedAt ?? member.fetchedAt };
      const known = readings.get(bucket.id);
      if (known) known.push(reading);
      else readings.set(bucket.id, [reading]);
    }
  }
  const buckets = [...readings.values()].map((known) => known
    .sort((left, right) => right.at - left.at)
    .map((reading) => reading.bucket)
    .reduce(mergeWindow));
  const plan = ranked.find((member) => member.plan)?.plan;
  const accountLabel = ranked.find((member) => member.accountLabel)?.accountLabel;
  const credits = ranked.find((member) => member.credits)?.credits;
  const spendControls = ranked.find((member) => member.spendControls?.length)?.spendControls;
  return {
    ...newest,
    buckets,
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
    refreshTargets: members.flatMap((member) =>
      member.providerAccountId && (member.refreshable ?? member.provider === "codex")
        ? [{ runnerId: member.runnerId, providerAccountId: member.providerAccountId }]
        : []),
  }));
}
