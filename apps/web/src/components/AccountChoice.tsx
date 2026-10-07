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

/**
 * One 6px `.meter` per usage window, each under "<Window> · N% left" in tabular figures (§11.6).
 * A window with less than a quarter left is drawn in the warning tone; a reading that is no longer
 * current says "Last Known" rather than passing for today's headroom.
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
                className={`meter${left < ACCOUNT_USAGE_WARNING_PERCENT ? " t-warning" : ""}`}
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
