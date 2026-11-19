import React, { type ReactNode } from "react";
import type { SubscriptionUsageBucket } from "@wollipog/protocol";
import { maskedAccountTitles } from "../personal-identifiers.js";
import { AccountIdentifierRevealButton } from "./AccountIdentifier.js";
import { StatusBadge } from "./StatusBadge.js";
import { ChoiceRows, type ChoiceRowOption } from "./ui/ChoiceControls.js";

/** Below this share of a usage window left, its meter takes the warning tone (§11.6). */
export const ACCOUNT_USAGE_WARNING_PERCENT = 25;

/** The share of a usage window that is left, rounded to the whole percent the row shows. */
export function usageLeftPercent(bucket: SubscriptionUsageBucket): number | undefined {
  const left = bucket.remainingPercent ??
    (bucket.usedPercent === undefined ? undefined : 100 - bucket.usedPercent);
  return left === undefined ? undefined : Math.round(Math.min(100, Math.max(0, left)));
}

export type UsageWindowAttention = "exhausted" | "approaching_limit" | "on_pace_to_run_out" | "usage_warning";

/**
 * The badge a usage window needs, if any, in the usage vocabulary (§11.2): Exhausted when nothing is
 * left or the provider says so, Approaching Limit when less than `ACCOUNT_USAGE_WARNING_PERCENT` is
 * left. A provider warning on a window with more than that left is about pace, not about the limit:
 * Claude warns when a window is being used faster than it elapses (25% used a few hours into a
 * week), so it reads On Pace to Run Out. A warning on a window with no percentage reads Usage
 * Warning, since nothing says which of the two it is. Switch Account's meters and the Subscriptions
 * tab both read it, so one window never reads differently in the two places.
 */
export function usageWindowAttention(bucket: SubscriptionUsageBucket): UsageWindowAttention | null {
  // Exhaustion reads the unrounded share: 0.4% left still has headroom, though it shows "0% left".
  const raw = bucket.remainingPercent ?? (bucket.usedPercent === undefined ? undefined : 100 - bucket.usedPercent);
  if (bucket.status === "exhausted" || (raw !== undefined && raw <= 0)) return "exhausted";
  const left = usageLeftPercent(bucket);
  if (left !== undefined && left < ACCOUNT_USAGE_WARNING_PERCENT) return "approaching_limit";
  if (bucket.status === "warning") return left === undefined ? "usage_warning" : "on_pace_to_run_out";
  return null;
}

/**
 * A usage window's `.meter` class with its tone (§11.6): danger when exhausted, warning when little
 * is left. The meter measures what is left, so a fast pace with plenty left keeps the plain meter;
 * its badge carries the pace.
 */
export function usageMeterClass(bucket: SubscriptionUsageBucket): string {
  const attention = usageWindowAttention(bucket);
  return attention === "exhausted" ? "meter t-danger" : attention === "approaching_limit" ? "meter t-warning" : "meter";
}

/**
 * How long until a window runs out if it keeps being used at its average rate so far, in
 * milliseconds, when that comes before it resets. Undefined when it lasts until the reset or the
 * window's start is unknown (no length or reset time). The rate is measured over the window up to
 * `now`, so an older reading only understates the pace.
 */
export function usageWindowRunsOutIn(bucket: SubscriptionUsageBucket, now: number): number | undefined {
  const used = bucket.usedPercent ?? (bucket.remainingPercent === undefined ? undefined : 100 - bucket.remainingPercent);
  if (used === undefined || used <= 0 || used >= 100) return undefined;
  if (bucket.resetsAt === undefined || bucket.windowDurationMinutes === undefined) return undefined;
  const untilReset = bucket.resetsAt - now;
  const elapsed = bucket.windowDurationMinutes * 60_000 - untilReset;
  if (untilReset <= 0 || elapsed <= 0) return undefined;
  const runsOutIn = elapsed * (100 - used) / used;
  return runsOutIn < untilReset ? runsOutIn : undefined;
}

/** "about 16 hours": a rough span for a projection, never more precise than it can be. */
function approximateSpan(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `about ${Math.round(hours / 24)} days`;
}

/** The sentence behind a window's pace or warning badge: why it is there, as precisely as known. */
export function usageWindowAttentionDetail(bucket: SubscriptionUsageBucket, now: number): string | undefined {
  const attention = usageWindowAttention(bucket);
  if (attention === "on_pace_to_run_out") {
    const runsOutIn = usageWindowRunsOutIn(bucket, now);
    return runsOutIn === undefined
      ? "The provider warned that this window is being used faster than it resets."
      : `At this pace, this window runs out in ${approximateSpan(runsOutIn)}, before it resets.`;
  }
  if (attention === "usage_warning") return "The provider warned about this window's usage.";
  return undefined;
}

/**
 * One 6px `.meter` per usage window, each under "<Window> · N% left" in tabular figures (§11.6).
 * A window takes the tone of its `usageWindowAttention()`; a reading that is no longer current says
 * "Last Known" rather than passing for today's headroom.
 */
export function AccountUsageMeters({ buckets, stale = false }: {
  buckets: readonly SubscriptionUsageBucket[];
  stale?: boolean;
}) {
  return (
    <span className="account-usage">
      {buckets.map((bucket) => {
        const left = usageLeftPercent(bucket);
        return (
          <span className="account-usage-window" key={bucket.id}>
            <span className="account-usage-text">
              {left === undefined ? bucket.label : `${bucket.label} · ${left}% left`}
            </span>
            {left !== undefined && (
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
            )}
          </span>
        );
      })}
      {stale && <span className="account-usage-stale">Last Known</span>}
    </span>
  );
}

/**
 * The Accounts section head: its title and, when any row hides an email, the one Show Emails / Hide
 * Emails control that reveals every row at once (§11.8). The picker's rows are radios inside
 * labels, which cannot nest a control of their own, so the reveal lives here and no identifier or
 * reveal button ever sits in a sentence.
 */
export function AccountsHead({ revealable, revealed, onToggleReveal, controls, title = "Accounts", titleId }: {
  /** Whether any row hides an identifier; without one there is nothing to show. */
  revealable: boolean;
  revealed: boolean;
  onToggleReveal: () => void;
  /** The id of the rows the control reveals. */
  controls?: string;
  title?: string;
  titleId?: string;
}) {
  return (
    <div className="section-head">
      <h3 className="section-title" id={titleId}>{title}</h3>
      {revealable && (
        <AccountIdentifierRevealButton
          label="Emails"
          revealed={revealed}
          onToggle={onToggleReveal}
          controls={controls}
          withText
        />
      )}
    </div>
  );
}

/** One provider account as a choice row lists it. */
export interface AccountRowAccount {
  id: string;
  /** The configured label. It reaches the DOM only when it is not an identifier, or once revealed. */
  label: string;
  buckets?: readonly SubscriptionUsageBucket[];
  stale?: boolean;
  /** Why the account cannot be chosen, shown as the row's visible second line. */
  disabledReason?: string;
  /** The account's state beside its title, as an inline status badge (§11.2 Provider account). */
  status?: ReactNode;
  /** A second line that says what to do with the account; it takes the meters' place. */
  note?: string;
  /** A refused choice of this account, as the row's field error (§8.5). */
  error?: string;
  /** One control at the row's end (Sign In). */
  action?: ReactNode;
}

/** The session's own account, which leads the list. */
export interface CurrentAccountRow {
  id: string;
  label: string;
  /** The Machine name when the account was removed from it. */
  removedFrom?: string;
  /** Usage, when the session's account can also be chosen (a failed switch to it being retried). */
  buckets?: readonly SubscriptionUsageBucket[];
  stale?: boolean;
  /** Whether it can be chosen. It normally cannot: the session already uses it. */
  selectable?: boolean;
}

/** Row titles for a revealed or masked list: the listed accounts are numbered among themselves, so
 * the current row never shifts their numbers. `maskedTitles` fixes each account's masked title by id
 * instead, for a list whose accounts can leave while it is open: the rest keep their numbers. */
export function accountRowTitles(
  current: CurrentAccountRow | null,
  accounts: readonly AccountRowAccount[],
  revealed: boolean,
  maskedTitles?: ReadonlyMap<string, string>,
): { current: string | null; accounts: string[] } {
  const masked = maskedAccountTitles(accounts.map((account) => account.label));
  return {
    current: current ? (revealed ? current.label : maskedAccountTitles([current.label])[0]!) : null,
    accounts: revealed
      ? accounts.map((account) => account.label)
      : accounts.map((account, index) => maskedTitles?.get(account.id) ?? masked[index]!),
  };
}

/**
 * One account as a choice row (§8.4): its title, a "Current" chip on the session's own account, one
 * meter per usage window, and the visible reason when it cannot be chosen.
 *
 * `removedFrom` is the session's account after it was removed from its Machine: the row reads
 * "Removed Account", never the stored label, says what that means, and has no meters, because a
 * removed account has no usage to show.
 */
export function accountRowOption({
  id, title, current = false, removedFrom, buckets = [], stale = false, disabled = false, disabledReason, status, note, error, action,
}: {
  id: string;
  /** The row's title as it may be shown: masked or revealed by the caller. */
  title: string;
  current?: boolean;
  /** The Machine name, when the session's account is no longer on it. */
  removedFrom?: string;
  buckets?: readonly SubscriptionUsageBucket[];
  stale?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  status?: ReactNode;
  note?: string;
  error?: string;
  action?: ReactNode;
}): ChoiceRowOption<string> {
  const removed = removedFrom !== undefined;
  return {
    value: id,
    title: removed ? "Removed Account" : title,
    status: current ? <StatusBadge tone="neutral" noDot label="Current" /> : status,
    description: removed
      ? `Removed from ${removedFrom}. This session keeps its sign-in until you switch.`
      : note ?? (buckets.length > 0 || stale ? <AccountUsageMeters buckets={buckets} stale={stale} /> : undefined),
    disabled: disabled || disabledReason !== undefined,
    disabledReason,
    error,
    action,
    // The row's input carries its account, so a caller can move focus to a refused row.
    inputData: { "data-account-id": id },
  };
}

/**
 * The account rows: the session's current account first, then every other account, as one radio
 * group. Switch Account and Choose Another Account share it, so there is one chooser.
 */
export function AccountRows({
  id, label = "Accounts", current, accounts, value, onChange, revealed, maskedTitles, disabled = false,
}: {
  id?: string;
  /** The group's accessible name. */
  label?: string;
  current: CurrentAccountRow | null;
  accounts: readonly AccountRowAccount[];
  value: string | null;
  onChange: (id: string) => void;
  revealed: boolean;
  /** Each account's masked title by id, when the caller keeps them stable (`accountRowTitles`). */
  maskedTitles?: ReadonlyMap<string, string>;
  /** Every row refuses a change, as while a choice is being applied. */
  disabled?: boolean;
}) {
  const titles = accountRowTitles(current, accounts, revealed, maskedTitles);
  const options = [
    ...(current ? [accountRowOption({
      id: current.id,
      title: titles.current!,
      current: true,
      removedFrom: current.removedFrom,
      buckets: current.buckets,
      stale: current.stale,
      disabled: disabled || !current.selectable,
    })] : []),
    ...accounts.map((account, index) => accountRowOption({
      id: account.id,
      title: titles.accounts[index]!,
      buckets: account.buckets,
      stale: account.stale,
      disabled,
      disabledReason: account.disabledReason,
      status: account.status,
      note: account.note,
      error: account.error,
      action: account.action,
    })),
  ];
  return (
    <ChoiceRows<string>
      id={id}
      className="account-rows"
      label={label}
      value={value}
      onChange={onChange}
      options={options}
    />
  );
}
