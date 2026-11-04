import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import type {
  SubscriptionUsageBucket,
  SubscriptionUsageResponse,
  SubscriptionUsageSourceView,
  SubscriptionUsageSpendControl,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { subscriptionResetLabel } from "../account-unavailable-reasons.js";
import { viewPath } from "../navigation.js";
import { isPersonalIdentifier, redactPersonalIdentifiers } from "../personal-identifiers.js";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { subscriptionPlanLabel } from "../usage-view-model.js";
import { usageLeftPercent, usageMeterClass, usageWindowAttention } from "./AccountChoice.js";
import { useFeedback } from "./FeedbackProvider.js";
import { AccountIcon, ChevronRightIcon, ComputerIcon, RefreshIcon } from "./Icons.js";
import { PersonalIdentifierRevealButton, PersonalIdentifierText, usePersonalIdentifierReveal } from "./PersonalIdentifier.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

/** What Refresh All refreshes, as the in-flight key; an account's key is `runnerId:providerAccountId`. */
const ALL = "*";

export interface SubscriptionRefreshTarget {
  runnerId: string;
  providerAccountId: string;
}

/**
 * The Subscriptions tab's data (#3014): the sources, their first load, and the refreshes, which
 * report through toasts (§13.1). Usage and Cost holds it, so the tab's count and the phone's
 * Refresh Subscriptions item read the same sources the tab shows.
 */
export function useSubscriptionUsage() {
  const api = useApi();
  const { showToast } = useFeedback();
  const [data, setData] = useState<SubscriptionUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  // One refresh at a time: a second press while one runs would only race the first.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.subscriptionUsage());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load subscription usage");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async (target?: SubscriptionRefreshTarget) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(target ? `${target.runnerId}:${target.providerAccountId}` : ALL);
    try {
      const refreshed = await api.refreshSubscriptionUsage(target);
      setData(refreshed);
      setError(null);
      const result = refreshed.refresh;
      if (result?.attempted === 0) {
        showToast("No machine was online to refresh. The last known values are unchanged.", { tone: "warning" });
      } else if (result?.failed) {
        showToast(result.attempted === 1
          ? "The machine couldn't refresh. The last known values are still shown."
          : `${result.failed} of ${result.attempted} machines couldn't refresh. The last known values are still shown.`,
        { tone: "warning" });
      } else {
        showToast(target ? "Account refreshed." : "Subscriptions refreshed.", { tone: "success" });
      }
    } catch (cause) {
      showToast(target ? "Couldn't refresh the account." : "Couldn't refresh subscriptions.", {
        tone: "error",
        detail: cause instanceof Error ? cause.message : undefined,
      });
    } finally {
      inFlight.current = false;
      setRefreshing(null);
    }
  }, [api, showToast]);

  // The tab's count is exactly the Approaching Limit and Exhausted badges the tab shows.
  const attention = useMemo(
    () => (data?.sources ?? []).flatMap((source) => source.buckets.map(usageWindowAttention)).filter((badge) => badge !== null),
    [data],
  );

  return { data, loading, error, reload: load, refreshing, refresh, attention };
}

export type SubscriptionUsageState = ReturnType<typeof useSubscriptionUsage>;

/** A reset or update time in full, to the minute: the tooltip behind "Resets in 6 days". */
export function subscriptionFullTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** "12:35 AM" on the day of `today`, otherwise (or without it) "Sep 25, 12:25 AM". */
function shortTime(timestamp: number, today?: number): string {
  const date = new Date(timestamp);
  const sameDay = today !== undefined && date.toDateString() === new Date(today).toDateString();
  return date.toLocaleString(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function providerName(source: SubscriptionUsageSourceView): string {
  return source.provider === "codex" ? "Codex" : "Claude";
}

/** The account's one badge, only when something is wrong (§11.1): no "Available" on a healthy one. */
function accountBadge(source: SubscriptionUsageSourceView): StatusMeta | null {
  switch (source.state) {
    case "unauthenticated": return statusMeta("usage", "sign_in_required");
    case "unavailable": return statusMeta("usage", "temporarily_unavailable");
    case "unsupported": return statusMeta("usage", "unsupported");
    case "not_applicable": return statusMeta("usage", "not_applicable");
    default: return source.freshness === "stale" ? statusMeta("usage", "stale") : null;
  }
}

/** Why a source shows no windows, as one sentence. The machine being offline says the most. */
function unavailableReason(source: SubscriptionUsageSourceView, hide: boolean): string {
  if (source.runnerStatus === "offline") {
    return `The machine is offline. Last update ${shortTime(source.fetchedAt)}.`;
  }
  if (source.detail) return hide ? redactPersonalIdentifiers(source.detail) : source.detail;
  switch (source.state) {
    case "unauthenticated": return `${source.agentName} is not signed in.`;
    case "not_applicable": return "This sign-in has no subscription allowance.";
    case "unsupported": return `This version of ${source.agentName} doesn't report subscription usage.`;
    default: return "No allowance windows were reported.";
  }
}

/** The neutral badge of an unavailable source: what kind of unavailable it is. */
function unavailableLabel(source: SubscriptionUsageSourceView): string {
  if (source.runnerStatus === "offline") return "Offline";
  switch (source.state) {
    case "unauthenticated": return "Signed Out";
    case "not_applicable": return "Not Applicable";
    case "unsupported": return "Unsupported";
    default: return "Unavailable";
  }
}

function spendControlText(control: SubscriptionUsageSpendControl, now: number): string {
  const amount = control.used && control.limit ? `${control.used} of ${control.limit}`
    : control.used ? `${control.used} used`
      : control.limit ?? "";
  return `${control.label}${amount ? `: ${amount}` : ""}${control.reached ? ", reached" : ""}` +
    (control.resetsAt ? `, ${lowerFirst(subscriptionResetLabel(control.resetsAt, now))}` : "");
}

/**
 * One usage window as a row (§11.6), read as Switch Account reads it: the window's name, a meter of
 * what is left, "N% left" in tabular figures and when it resets, with the full time in the tooltip.
 * A window the provider does not measure says so instead of drawing a dash.
 */
function SubscriptionWindow({ bucket, now }: { bucket: SubscriptionUsageBucket; now: number }) {
  const left = usageLeftPercent(bucket);
  const attention = usageWindowAttention(bucket);
  return (
    <li className={left === undefined ? "subscription-window unmeasured" : "subscription-window"}>
      <span className="subscription-window-name">
        <span className="subscription-window-label">{bucket.label}</span>
        {attention && <StatusBadge meta={statusMeta("usage", attention)} />}
      </span>
      {left === undefined ? (
        <span className="subscription-window-left">No percentage reported</span>
      ) : (
        <>
          <span
            className={usageMeterClass(bucket)}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={left}
            aria-label={`${bucket.label} Left`}
          >
            <span style={{ width: `${left}%` }} />
          </span>
          <span className="subscription-window-left">{left}% left</span>
        </>
      )}
      {bucket.resetsAt !== undefined && (
        <span className="subscription-window-reset" title={subscriptionFullTime(bucket.resetsAt)}>
          {subscriptionResetLabel(bucket.resetsAt, now)}
        </span>
      )}
    </li>
  );
}

/**
 * The account on the meta line, through the shared mask (§11.8). Its reveal control sits with the
 * account's other controls at the line's end, so the identifier and its control are passed apart.
 */
function useAccountText(source: SubscriptionUsageSourceView) {
  const privacy = useAccountEmailPrivacy();
  const value = source.accountLabel ?? "";
  // Without an account binding the label is the provider-reported email.
  const masked = privacy.hide && value !== "" && (!source.providerAccountId || isPersonalIdentifier(value));
  const [revealed, toggle] = usePersonalIdentifierReveal(
    JSON.stringify([privacy.revision, source.runnerId, source.sourceId, source.providerAccountId ?? "", value]),
  );
  if (!value) return { text: null, reveal: null };
  if (!masked) {
    return {
      text: <span className="subscription-plan-account"><AccountIcon size={14} /><span className="pid-value">{value}</span></span>,
      reveal: null,
    };
  }
  return {
    text: (
      <span className="pid subscription-plan-account" data-revealed={revealed}>
        {/* The lead names a mask (§11.8); a revealed email says what it is. */}
        <PersonalIdentifierText value={value} revealed={revealed} kind="email" lead={revealed ? undefined : "Account"} />
      </span>
    ),
    reveal: <PersonalIdentifierRevealButton label="Account Email" revealed={revealed} onToggle={toggle} />,
  };
}

function SubscriptionAccount({ source, now, refreshing, onRefresh }: {
  source: SubscriptionUsageSourceView;
  now: number;
  refreshing: string | null;
  onRefresh: (target: SubscriptionRefreshTarget) => void;
}) {
  const titleId = `subscription-${useId().replace(/:/g, "")}`;
  const privacy = useAccountEmailPrivacy();
  const account = useAccountText(source);
  const badge = accountBadge(source);
  const target = source.provider === "codex" && source.providerAccountId
    ? { runnerId: source.runnerId, providerAccountId: source.providerAccountId }
    : null;
  const busy = target !== null && (refreshing === ALL || refreshing === `${target.runnerId}:${target.providerAccountId}`);
  const extras = [
    ...(source.credits ? [`Credits: ${source.credits.unlimited ? "Unlimited"
      : source.credits.balance ?? (source.credits.hasCredits ? "Available" : "None")}`] : []),
    ...(source.spendControls ?? []).map((control) => spendControlText(control, now)),
  ];
  const lastUpdate = `Last update ${subscriptionFullTime(source.fetchedAt)}.`;
  return (
    <section className="surface subscription-plan" aria-labelledby={titleId}>
      <header className="subscription-plan-head">
        <div className="subscription-plan-heading">
          <h3 className="subscription-plan-title" id={titleId}>
            {providerName(source)}{source.plan ? ` ${subscriptionPlanLabel(source.plan)}` : ""}
          </h3>
          {badge && (
            <StatusBadge
              meta={badge}
              title={source.runnerStatus === "offline" ? `The machine is offline. ${lastUpdate}` : lastUpdate}
            />
          )}
        </div>
        <p className="subscription-plan-meta">
          <span className="subscription-plan-machine">
            <ComputerIcon size={14} />
            <span>{source.agentName} on {source.runnerName}</span>
          </span>
          {account.text}
        </p>
        {(account.reveal || target) && (
          <div className="subscription-plan-actions">
            {account.reveal}
            {target && (
              <BusyButton
                className="icon-btn sm"
                busy={busy}
                progress="Refreshing the account…"
                aria-label="Refresh Account"
                title="Refresh Account"
                aria-disabled={refreshing !== null && !busy ? true : undefined}
                icon={<RefreshIcon size={14} />}
                onClick={() => onRefresh(target)}
              >
                {null}
              </BusyButton>
            )}
          </div>
        )}
      </header>
      <ul className="subscription-windows" aria-label="Usage Windows">
        {source.buckets.map((bucket) => <SubscriptionWindow key={bucket.id} bucket={bucket} now={now} />)}
      </ul>
      {source.detail && (
        <p className="subscription-plan-note">{privacy.hide ? redactPersonalIdentifiers(source.detail) : source.detail}</p>
      )}
      {extras.length > 0 && (
        <p className="subscription-plan-extras">{extras.map((text) => <span key={text}>{text}</span>)}</p>
      )}
    </section>
  );
}

function UnavailableSources({ sources }: { sources: readonly SubscriptionUsageSourceView[] }) {
  const privacy = useAccountEmailPrivacy();
  return (
    <details className="disclosure">
      <summary>
        <ChevronRightIcon size={14} className="disclosure-chevron" />
        {sources.length} {sources.length === 1 ? "Source" : "Sources"} Unavailable
      </summary>
      <div className="disclosure-body">
        <ul className="surface subscription-unavailable-list">
          {sources.map((source) => (
            <li className="subscription-unavailable-row" key={`${source.runnerId}:${source.sourceId}`}>
              <span className="subscription-unavailable-text">
                <span className="subscription-unavailable-name">{source.agentName} on {source.runnerName}</span>
                <span className="subscription-unavailable-reason">{unavailableReason(source, privacy.hide)}</span>
              </span>
              <StatusBadge tone="neutral" label={unavailableLabel(source)} />
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/**
 * The Subscriptions tab (#3014, docs/design-system.md §5.1, §5.5, §11.6, §12): "{N} Accounts" with
 * when it last updated and Refresh All, one surface per account with a row per usage window, the
 * sources that report no windows folded into one disclosure, and the loading, error and empty
 * states. On phones Refresh All is the app bar's Refresh Subscriptions instead (`UsageView`).
 */
export function SubscriptionsTab({ usage, phone, onOpenConnections }: {
  usage: SubscriptionUsageState;
  phone: boolean;
  onOpenConnections?: () => void;
}) {
  const { data, loading, error, reload, refreshing, refresh } = usage;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  // A refresh moves every reset closer, so the labels catch up with it at once.
  useEffect(() => setNow(Date.now()), [data]);

  if (!data) {
    if (loading) {
      return (
        <div className="surface" role="status">
          <span className="sr-only">Loading subscriptions…</span>
          {[0, 1, 2].map((index) => (
            <div className="row subscription-skeleton-row" aria-hidden="true" key={index}>
              <span className="skeleton-bar title" />
              <span className="skeleton-bar" />
            </div>
          ))}
        </div>
      );
    }
    return (
      <State
        variant="error"
        title="Couldn't Load Subscriptions"
        actions={<button type="button" className="btn sm" onClick={() => void reload()}>Retry</button>}
        details={error ?? undefined}
      >
        Each plan's remaining allowance couldn't be read. Retry to ask again.
      </State>
    );
  }

  if (data.sources.length === 0) {
    const connections = viewPath({ name: "runners", section: "machines" });
    return (
      <State
        pageLevel
        icon={<AccountIcon />}
        title="No Subscriptions Connected"
        actions={(
          <a
            className="btn primary lg"
            href={connections}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (!onOpenConnections || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onOpenConnections();
            }}
          >
            Open Connections
          </a>
        )}
      >
        Sign in to Codex or Claude on a connected machine, and each plan's remaining allowance shows here.
      </State>
    );
  }

  const accounts = data.sources.filter((source) => source.buckets.length > 0);
  const unavailable = data.sources.filter((source) => source.buckets.length === 0);
  const updatedAt = Math.max(...data.sources.map((source) => source.fetchedAt));
  return (
    <>
      <div className="section-head">
        <div className="subscriptions-heading">
          <h2 className="section-title">{accounts.length} {accounts.length === 1 ? "Account" : "Accounts"}</h2>
          <span className="subscriptions-updated" title={subscriptionFullTime(updatedAt)}>Updated {shortTime(updatedAt, now)}</span>
        </div>
        {!phone && (
          <BusyButton
            className="btn sm"
            busy={refreshing === ALL}
            progress="Refreshing subscriptions…"
            aria-disabled={refreshing !== null && refreshing !== ALL ? true : undefined}
            icon={<RefreshIcon size={14} />}
            onClick={() => void refresh()}
          >
            Refresh All
          </BusyButton>
        )}
      </div>
      {accounts.length > 0 && (
        <div className="subscription-plans">
          {accounts.map((source) => (
            <SubscriptionAccount
              key={`${source.runnerId}:${source.sourceId}`}
              source={source}
              now={now}
              refreshing={refreshing}
              onRefresh={(target) => void refresh(target)}
            />
          ))}
        </div>
      )}
      {unavailable.length > 0 && <UnavailableSources sources={unavailable} />}
    </>
  );
}
