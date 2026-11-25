import { useId } from "react";
import { PROVIDER_ACCOUNT_SKIP_TEXT, type AssistantThreadAccountChoices } from "@wollipog/protocol";
import { isPersonalIdentifier, maskedAccountTitles } from "../personal-identifiers.js";
import { AccountIdentifierRevealButton, useAccountIdentifierReveal } from "./AccountIdentifier.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";

/** A missing explicit choice at creation follows the Machine's policy at launch. */
export const MACHINE_ACCOUNT_POLICY = "machine-policy";

export function canUseMachineAccountPolicy(choices: AssistantThreadAccountChoices): boolean {
  return !choices.policyRefusal && !choices.accounts.some((account) =>
    account.accountRef === choices.policyAccountRef && account.reason);
}

export function AssistantThreadAccountField({ choices, value, onChange, disabled, usePolicy, label = "Account" }: {
  choices: AssistantThreadAccountChoices;
  value: string | null;
  onChange: (value: string) => void;
  disabled: boolean;
  usePolicy?: "launch" | "default";
  label?: string;
}) {
  const labelId = useId();
  const labels = choices.accounts.map((account) => account.label);
  const [revealed, toggle] = useAccountIdentifierReveal(JSON.stringify(choices.accounts.map(({ accountRef, label }) => [accountRef, label])));
  const titles = revealed ? labels : maskedAccountTitles(labels);
  const policyIndex = choices.accounts.findIndex((account) => account.accountRef === choices.policyAccountRef);
  const expected = choices.accounts[policyIndex];
  const options = choices.accounts.map((account, index) => {
    const current = account.accountRef === choices.currentAccountRef;
    const disabledReason = account.reason
      ? `This account ${PROVIDER_ACCOUNT_SKIP_TEXT[account.reason]}.`
      : current && !choices.retryCurrentAccount ? "The thread already uses this account." : undefined;
    return {
      value: account.accountRef, title: titles[index]!,
      disabled: disabled || !!disabledReason, disabledReason,
    };
  });
  if (usePolicy && !choices.unavailable) {
    const disabledReason = usePolicy === "launch" ? choices.policyRefusal ??
      (expected?.reason ? `The account selected by policy ${PROVIDER_ACCOUNT_SKIP_TEXT[expected.reason]}.` : undefined) : undefined;
    options.unshift({
      value: MACHINE_ACCOUNT_POLICY,
      title: policyIndex >= 0 ? `Machine Policy · ${titles[policyIndex]}` : "Machine Policy",
      disabled: disabled || !!disabledReason, disabledReason,
    });
  }
  return (
    <div className="field">
      <div className="pid-field-head">
        <span id={labelId}>{label}</span>
        {labels.some(isPersonalIdentifier) && (
          <AccountIdentifierRevealButton label="Emails" revealed={revealed} onToggle={toggle} withText />
        )}
      </div>
      {choices.unavailable || options.length === 0 ? (
        <p className="field-helper">{choices.unavailable ?? "There are no configured accounts for this harness on this Machine."}</p>
      ) : (
        <ChoiceRows className="assistant-thread-account-picker" label={label} labelledBy={labelId}
          value={value} onChange={onChange} options={options} />
      )}
    </div>
  );
}
