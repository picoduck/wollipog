import { useEffect, useId, useState, type ReactNode } from "react";
import type { AssistantThreadLaunchDefaults, AssistantThreadLaunchDefaultsPatch, AssistantThreadLimits } from "@wollipog/protocol";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { useApi } from "../api-context.js";
import { formatAssistantDefaultDelegation } from "../assistant-decision-delegation.js";
import { assistantThreadHarnessLabel, assistantThreadsOwnerOnly, assistantThreadsUnavailable, type AssistantThreadDefaults } from "../assistant-threads.js";
import { formatUsd, parseCount, parseUsd } from "../guardrail-values.js";
import { useInstanceScope } from "../instance-scope.js";
import { accountLabelText } from "../personal-identifiers.js";
import { AssistantBudgetPresets, assistantBudgetSelection } from "./AssistantBudgetPresets.js";
import { AssistantDecisionDelegationDialog } from "./AssistantDecisionDelegationDialog.js";
import { AssistantThreadAccountField, MACHINE_ACCOUNT_POLICY } from "./AssistantThreadAccountField.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox, ChoiceRows } from "./ui/ChoiceControls.js";
import { ActionRow, SettingsGroup } from "./ui/SettingsRows.js";

const titles = {
  harness: "Harness",
  account: "Account",
  budget: "Budget per Thread",
  launches: "Session Launches per Thread",
  delegation: "Decision Delegation for New Threads",
} as const;

type DefaultField = keyof typeof titles;

export function AssistantThreadDefaultsPanel() {
  return <AssistantThreadDefaultsGroup key={useInstanceScope()} />;
}

function AssistantThreadDefaultsGroup() {
  const api = useApi();
  const [limits, setLimits] = useState<AssistantThreadLimits | null>(null);
  const [launch, setLaunch] = useState<AssistantThreadDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<DefaultField | null>(null);
  const privacy = useAccountEmailPrivacy();

  useEffect(() => {
    let current = true;
    const failed = (cause: unknown) => {
      if (current && !assistantThreadsUnavailable(cause) && !assistantThreadsOwnerOnly(cause)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void api.assistantThreadLimitDefaults().then((response) => { if (current) setLimits(response); }, failed);
    void api.assistantThreadDefaults().then((response) => { if (current) setLaunch(response); }, failed);
    return () => { current = false; };
  }, [api, attempt]);

  const launchDefaults = launch?.launchDefaults;
  const decisionDefault = launch?.decisionDefault;
  if (!limits && !launchDefaults && decisionDefault === undefined && !error) return null;
  const close = () => setEditing(null);
  const saved = launchDefaults?.providerAccount;
  const choices = launch?.harnesses.find((option) => option.id === launch.harness)?.accountSelection;
  const account = choices?.runnerId === saved?.runnerId
    ? choices?.accounts.find((choice) => !choice.reason && choice.accountRef === saved?.accountRef)
    : undefined;
  const row = (field: DefaultField, value: string) =>
    <ActionRow title={titles[field]} actionLabel={value} hasPopup="dialog" onAction={() => setEditing(field)} />;

  return <SettingsGroup className="assistant-thread-defaults" title="Thread Defaults" scope="Your Account"
    intro="These defaults apply to new threads."
    failure={error ? {
      message: "Couldn't load thread defaults.", detail: error,
      onRetry: () => { setError(null); setAttempt((count) => count + 1); },
    } : null}>
    {launch && launchDefaults && <>
      {row("harness", assistantThreadHarnessLabel(launch.harness, launch.harnesses))}
      {row("account", account ? accountLabelText(account.label, undefined, privacy.hide)
        : saved ? "Saved Account Unavailable" : "Machine Policy")}
      {(editing === "harness" || editing === "account") && <LaunchDefaultDialog
        field={editing} defaults={launch} launchDefaults={launchDefaults} onClose={close}
        onSave={async (update) => {
          if (decisionDefault !== undefined) {
            setLaunch(await api.patchAssistantThreadLaunchDefaults(update));
            return;
          }
          const current = await api.assistantThreadDefaults();
          if ("expectedHarness" in update && current.harness !== update.expectedHarness) {
            throw new Error("The default harness changed. Reopen Assistant Settings to choose its account.");
          }
          setLaunch(await api.setAssistantThreadLaunchDefaults("harness" in update
            ? { harness: update.harness, providerAccount: update.harness === current.harness ? current.launchDefaults?.providerAccount ?? null : null }
            : { harness: current.harness, providerAccount: update.providerAccount }));
        }} />}
    </>}
    {limits && <>
      {row("budget", limits.costUsd === null ? "No Limit" : assistantBudgetSelection(limits.costUsd) === "custom"
        ? formatUsd(limits.costUsd) : `$${limits.costUsd}`)}
      {row("launches", limits.launchedSessions === null ? "No Limit" : String(limits.launchedSessions))}
      {(editing === "budget" || editing === "launches") && <LimitDefaultDialog field={editing} limits={limits}
        onClose={close} onSave={async (update) => setLimits(decisionDefault !== undefined
          ? await api.patchAssistantThreadLimitDefaults(update)
          : await api.setAssistantThreadLimitDefaults({ ...await api.assistantThreadLimitDefaults(), ...update }))} />}
    </>}
    {decisionDefault !== undefined && <>
      {row("delegation", formatAssistantDefaultDelegation(decisionDefault))}
      {editing === "delegation" && <AssistantDecisionDelegationDialog defaultGrant={decisionDefault}
        onClose={close} onSaveDefault={async (next) => {
          const { grant } = await api.setAssistantThreadDecisionDefault(next);
          setLaunch((current) => current && { ...current, decisionDefault: grant });
        }} />}
    </>}
  </SettingsGroup>;
}

function DefaultEditDialog({ title, onClose, onSave, children }: {
  title: string;
  onClose: () => void;
  onSave: () => Promise<void>;
  children: (busy: boolean) => ReactNode;
}) {
  const form = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };
  return <Modal title={title} className="assistant-default-dialog" phoneSheet="full" onClose={busy ? () => {} : onClose} footer={<>
    <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
    <BusyButton className="btn primary" form={form} type="submit" busy={busy} progress="Saving default…">Save Default</BusyButton>
  </>}>
    <form id={form} className="form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {children(busy)}
      {error && <Notice tone="danger" role="alert" noticeRef={(node) => node?.scrollIntoView({ block: "nearest" })}>{error}</Notice>}
    </form>
  </Modal>;
}

function LaunchDefaultDialog({ field, defaults, launchDefaults, onClose, onSave }: {
  field: "harness" | "account";
  defaults: AssistantThreadDefaults;
  launchDefaults: AssistantThreadLaunchDefaults;
  onClose: () => void;
  onSave: (update: AssistantThreadLaunchDefaultsPatch) => Promise<void>;
}) {
  const [harness, setHarness] = useState(launchDefaults.harness);
  const [accountRef, setAccountRef] = useState(launchDefaults.providerAccount?.accountRef ?? MACHINE_ACCOUNT_POLICY);
  const choices = defaults.harnesses.find((option) => option.id === launchDefaults.harness)?.accountSelection;
  const selected = choices?.accounts.find((account) => account.accountRef === accountRef && !account.reason);
  const policy = accountRef === MACHINE_ACCOUNT_POLICY;

  return <DefaultEditDialog title={titles[field]} onClose={onClose} onSave={async () => {
    if (field === "harness") return onSave({ harness });
    if (!policy && (!choices || !selected)) throw new Error("Choose an eligible account or use Machine Policy.");
    await onSave({ expectedHarness: launchDefaults.harness,
      providerAccount: choices && selected ? { runnerId: choices.runnerId, accountRef: selected.accountRef } : null });
  }}>
    {(busy) => field === "harness"
      ? <>
        <ChoiceRows label="Harness" value={harness} onChange={setHarness}
          options={defaults.harnesses.map((option) => ({ value: option.id, title: option.label, description: option.reason, disabled: busy }))} />
        {harness !== launchDefaults.harness && launchDefaults.providerAccount && <p className="field-helper">
          Changing the harness resets the account to Machine Policy.
        </p>}
      </>
      : <>
        {choices && !choices.unavailable
          ? <AssistantThreadAccountField choices={choices} value={accountRef} onChange={setAccountRef} disabled={busy} usePolicy="default" />
          : <p className="field-helper">{choices?.unavailable ?? "Account choices appear when a Machine can start this harness."}</p>}
        {!policy && !selected && <Notice tone="warning"
          actions={<button type="button" className="btn" disabled={busy}
            onClick={() => setAccountRef(MACHINE_ACCOUNT_POLICY)}>Use Machine Policy</button>}>
          The saved account is unavailable.
        </Notice>}
      </>}
  </DefaultEditDialog>;
}

function LimitDefaultDialog({ field, limits, onClose, onSave }: {
  field: "budget" | "launches";
  limits: AssistantThreadLimits;
  onClose: () => void;
  onSave: (update: Partial<AssistantThreadLimits>) => Promise<void>;
}) {
  const [cost, setCost] = useState(limits.costUsd?.toString() ?? "");
  const [preset, setPreset] = useState(() => assistantBudgetSelection(limits.costUsd));
  const [launches, setLaunches] = useState(limits.launchedSessions?.toString() ?? "");
  const [noLaunchLimit, setNoLaunchLimit] = useState(limits.launchedSessions === null);
  const save = async () => {
    if (field === "budget") {
      if (preset === "none") return onSave({ costUsd: null });
      const budget = parseUsd(cost);
      if (!budget.ok) throw new Error(budget.error);
      if (budget.value === null) throw new Error("Enter an amount or choose No Limit.");
      if (!Number.isSafeInteger(Math.round(budget.value * 100)) || Number(budget.value.toFixed(2)) !== budget.value) {
        throw new Error("Enter a cost budget in whole cents, such as 2.50.");
      }
      return onSave({ costUsd: budget.value });
    }
    if (!noLaunchLimit && !launches.trim()) throw new Error("Enter a session launch limit or choose No Limit.");
    const count = parseCount(noLaunchLimit ? "" : launches, Number.MAX_SAFE_INTEGER);
    if (!count.ok) throw new Error(count.error);
    await onSave({ launchedSessions: count.value });
  };
  return <DefaultEditDialog title={titles[field]} onClose={onClose} onSave={save}>
    {(busy) => field === "budget" ? <AssistantBudgetPresets value={cost} selection={preset} disabled={busy}
      onChange={(value, selection) => { setCost(value); setPreset(selection); }} />
      : <>
      <label className="field"><span>Session Launch Limit</span>
        <input value={noLaunchLimit ? "" : launches} inputMode="numeric" disabled={busy || noLaunchLimit}
          onChange={(event) => setLaunches(event.target.value)} />
      </label>
      <Checkbox label="No Limit" checked={noLaunchLimit} disabled={busy} onChange={setNoLaunchLimit} />
      <p className="field-helper">Set the launch limit to 0 to pause new launches.</p>
    </>}
  </DefaultEditDialog>;
}
