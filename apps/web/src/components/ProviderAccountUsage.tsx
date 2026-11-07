import React, { useEffect, useId, useState } from "react";
import type { ProviderAccountDefinition, RunnerView, SubscriptionUsageResponse } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { subscriptionResetLabel } from "../account-unavailable-reasons.js";
import { accountLabelText } from "../personal-identifiers.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { AccountUsageMeters, usageLeftPercent } from "./AccountChoice.js";
import { ChevronDownIcon } from "./Icons.js";

/** Read cached usage, never probe credentials from the account overview. The response is already
 * permission-scoped; a failed read leaves usage unknown instead of borrowing another account's. */
export function useMachineAccountUsage(runner: RunnerView, online: boolean) {
  const api = useApi();
  const [data, setData] = useState<SubscriptionUsageResponse | null>(null);
  const [now, setNow] = useState(Date.now);
  const accountKey = JSON.stringify(runner.providerAccounts?.map(account => [account.id, account.provider, account.authStatus, account.profile?.access]));
  useEffect(() => {
    let current = true;
    let reading = false;
    setData(null);
    const load = async () => {
      if (reading) return;
      reading = true;
      try { const next = await api.subscriptionUsage(); if (current) setData(next); }
      catch { /* Unknown usage does not prevent account management. */ }
      finally { reading = false; }
    };
    void load();
    const timer = window.setInterval(() => { setNow(Date.now()); void load(); }, 60_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [api, runner.runnerId, accountKey, online]);
  return { response: data, now: Math.max(now, Date.now()) };
}

export function ProviderAccountUsage({ account, runnerId, online, data }: {
  account: ProviderAccountDefinition;
  runnerId: string;
  online: boolean;
  data: ReturnType<typeof useMachineAccountUsage>;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const privacy = useAccountEmailPrivacy();
  const source = data.response?.sources.filter(value => value.runnerId === runnerId &&
    value.providerAccountId === account.id && value.provider === account.provider)
    .sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
  const buckets = source?.state === "available" ? source.buckets : [];
  const tightest = buckets.filter(bucket => usageLeftPercent(bucket) !== undefined)
    .sort((a, b) => usageLeftPercent(a)! - usageLeftPercent(b)!)[0];
  const stale = !online || source?.freshness === "stale" || !!source &&
    (data.now - source.fetchedAt > (data.response?.staleAfterMs ?? 0) || buckets.some(bucket => bucket.resetsAt !== undefined && bucket.resetsAt <= data.now));
  const name = accountLabelText(account.label, undefined, privacy.hide);
  const summary = tightest ? `${usageLeftPercent(tightest)}% Left${stale ? " · Last Known" : ""}. ${tightest.label}${tightest.resetsAt !== undefined ? ` · ${subscriptionResetLabel(tightest.resetsAt, data.now)}` : ""}` : "Usage Not Reported";
  return <div className="provider-account-usage">
    <button type="button" className="provider-usage-toggle" aria-expanded={expanded} aria-controls={id}
      aria-label={`Usage Details for ${name}: ${summary}`} onClick={() => setExpanded(!expanded)}>
      <span>{tightest ? <><span>{usageLeftPercent(tightest)}% Left{stale ? " · Last Known" : ""}</span>
        <span className="provider-usage-reset">{tightest.label}{tightest.resetsAt !== undefined ? ` · ${subscriptionResetLabel(tightest.resetsAt, data.now)}` : ""}</span></>
        : <span>Usage Not Reported</span>}</span>
      <ChevronDownIcon />
    </button>
    {expanded && <div className="provider-usage-details" id={id}>
      {buckets.length > 0 ? <AccountUsageMeters buckets={buckets} stale={stale} /> : <p>No allowance reading is available for this account.</p>}
      {buckets.map(bucket => bucket.resetsAt !== undefined && <p key={bucket.id}>{bucket.label}: {subscriptionResetLabel(bucket.resetsAt, data.now)}</p>)}
      {source && buckets.length > 0 && <p>{stale ? "Last known reading" : "Reading"}: <time dateTime={new Date(source.fetchedAt).toISOString()}>{new Date(source.fetchedAt).toLocaleString()}</time></p>}
    </div>}
  </div>;
}
