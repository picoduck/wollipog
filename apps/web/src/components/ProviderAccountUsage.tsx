import React, { useEffect, useId, useState } from "react";
import type { ProviderAccountDefinition, RunnerView, SubscriptionUsageResponse } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { subscriptionResetLabel } from "../account-unavailable-reasons.js";
import { accountLabelText } from "../personal-identifiers.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { AccountUsageMeters, usageLeftPercent } from "./AccountChoice.js";
import { ChevronDownIcon } from "./Icons.js";

type AccountAccess = ReadonlyMap<string, string | undefined>;

function accountAccess(runner: RunnerView): AccountAccess {
  return new Map(runner.providerAccounts?.map(account => [account.id, account.profile?.access]));
}

/** Read cached usage, never probe credentials from the account overview. The response is already
 * permission-scoped. A failed read keeps the last reading for this API and Machine, which ages into
 * Last Known, rather than saying nothing was ever reported. It never carries to another API or Machine,
 * or to an account whose server access has changed since it was read. */
export function useMachineAccountUsage(runner: RunnerView, online: boolean) {
  const api = useApi();
  const [reading, setReading] = useState<{ api: unknown; runnerId: string; access: AccountAccess; response: SubscriptionUsageResponse } | null>(null);
  const [now, setNow] = useState(Date.now);
  const accountKey = JSON.stringify(runner.providerAccounts?.map(account => [account.id, account.provider, account.authStatus, account.profile?.access]));
  useEffect(() => {
    let current = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      const access = accountAccess(runner);
      try {
        const response = await api.subscriptionUsage();
        if (current) setReading({ api, runnerId: runner.runnerId, access, response });
      } catch { /* Unknown usage does not prevent account management. */ }
      finally { inFlight = false; }
    };
    void load();
    const timer = window.setInterval(() => { setNow(Date.now()); void load(); }, 60_000);
    return () => { current = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `accountKey` carries what `runner` adds
  }, [api, runner.runnerId, accountKey, online]);
  const access = accountAccess(runner);
  const response = reading && reading.api === api && reading.runnerId === runner.runnerId ? { ...reading.response,
    sources: reading.response.sources.filter(source => !source.providerAccountId ||
      access.get(source.providerAccountId) === reading.access.get(source.providerAccountId)) } : null;
  return { response, now: Math.max(now, Date.now()) };
}

export function ProviderAccountUsage({ account, runnerId, online, data }: {
  account: ProviderAccountDefinition;
  runnerId: string;
  online: boolean;
  data: ReturnType<typeof useMachineAccountUsage>;
}) {
  const [expanded, setExpanded] = useState(false);
  // Keep an operated disclosure focusable even if a refresh temporarily has no buckets.
  const [disclosureUsed, setDisclosureUsed] = useState(false);
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
  const compact = tightest ? `${usageLeftPercent(tightest)}% Left${stale ? " · Last Known" : tightest.resetsAt !== undefined ? ` · ${subscriptionResetLabel(tightest.resetsAt, data.now)}` : ""}` : "Usage Not Reported";
  return <div className="provider-account-usage">
    {buckets.length > 0 || disclosureUsed ? <button type="button" className="provider-usage-toggle" aria-expanded={expanded} aria-controls={id}
      aria-label={`Usage Details for ${name}: ${summary}`} onClick={() => { setDisclosureUsed(true); setExpanded(!expanded); }}>
      <span>{compact}</span><ChevronDownIcon />
    </button> : <span className="provider-usage-empty">{compact}</span>}
    {expanded && <div className="provider-usage-details" id={id}>
      {buckets.length > 0 ? <AccountUsageMeters buckets={buckets} stale={stale} /> : <p>No allowance reading is available for this account.</p>}
      {buckets.map(bucket => bucket.resetsAt !== undefined && <p key={bucket.id}>{bucket.label}: {subscriptionResetLabel(bucket.resetsAt, data.now)}</p>)}
      {source && buckets.length > 0 && <p>{stale ? "Last known reading" : "Reading"}: <time dateTime={new Date(source.fetchedAt).toISOString()}>{new Date(source.fetchedAt).toLocaleString()}</time></p>}
    </div>}
  </div>;
}
