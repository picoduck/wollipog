import { useEffect, useId, useState } from "react";
import type { AssistantThreadHarness, AssistantThreadLaunchDefaults, AssistantThreadLimits } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { assistantThreadHarnessLabel, assistantThreadsOwnerOnly, assistantThreadsUnavailable, type AssistantThreadDefaults } from "../assistant-threads.js";
import { formatUsd } from "../guardrail-values.js";
import { useInstanceScope } from "../instance-scope.js";
import { AssistantThreadLimitsDialog } from "./AssistantThreadLimitsDialog.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { AssistantThreadAccountField, MACHINE_ACCOUNT_POLICY } from "./AssistantThreadAccountField.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";
import { ActionRow, LinkRow, SettingsGroup } from "./ui/SettingsRows.js";

export function AssistantThreadDefaultsPanel({ onOpenThreads }: { onOpenThreads: () => void }) {
  return <AssistantThreadDefaultsGroup key={useInstanceScope()} onOpenThreads={onOpenThreads} />;
}

function AssistantThreadDefaultsGroup({ onOpenThreads }: { onOpenThreads: () => void }) {
  const api = useApi();
  const [limits, setLimits] = useState<AssistantThreadLimits | null>(null);
  const [launch, setLaunch] = useState<AssistantThreadDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<"limits" | "launch" | null>(null);

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

  if (!limits && !launch?.launchDefaults && !error) return null;
  const close = () => setEditing(null);
  const saved = launch?.launchDefaults?.providerAccount;
  const choices = launch?.harnesses.find((option) => option.id === launch.harness)?.accountSelection;
  const account = choices?.accounts.find((choice) => !choice.reason && choice.accountRef === saved?.accountRef);
  return (
    <SettingsGroup title="Thread Defaults" scope="Your Account" intro="These defaults apply to new threads.">
      {error && <Notice tone="danger" role="alert" title="Couldn't Load Thread Defaults"
        actions={<button type="button" className="btn sm" onClick={() => { setError(null); setAttempt(attempt + 1); }}>Retry</button>}>
        {error}
      </Notice>}
      {launch?.launchDefaults && <>
        <ActionRow title="Default Harness and Account"
          description={<>{assistantThreadHarnessLabel(launch.harness, launch.harnesses)} · {account
            ? <AccountIdentifier value={account.label} label="Account Email" identity={account.accountRef} />
            : saved ? "Saved Account Unavailable" : "Machine Policy"}</>}
          hasPopup="dialog" actionLabel="Edit Harness and Account…" onAction={() => setEditing("launch")} />
        {editing === "launch" && <LaunchDefaultsDialog defaults={launch} onClose={close}
          onSave={async (next) => setLaunch(await api.setAssistantThreadLaunchDefaults(next))} />}
      </>}
      {limits && <>
        <ActionRow
          title="Default Thread Limits"
          description={`${limits.costUsd === null ? "No Budget" : `${formatUsd(limits.costUsd)} budget`} · ${limits.launchedSessions === null
            ? "No Launch Limit"
            : `${limits.launchedSessions} session ${limits.launchedSessions === 1 ? "launch" : "launches"}`}`}
          hasPopup="dialog"
          actionLabel="Edit Limits…"
          onAction={() => setEditing("limits")}
        />
        {editing === "limits" && <AssistantThreadLimitsDialog defaults limits={limits} onClose={close}
          onSave={async (next) => setLimits(await api.setAssistantThreadLimitDefaults(next))} />}
      </>}
      {(limits || launch?.launchDefaults) && <LinkRow title="Existing Threads"
        description="To change a budget for an existing thread, open its Thread Settings." onClick={onOpenThreads} />}
    </SettingsGroup>
  );
}

function LaunchDefaultsDialog({ defaults, onClose, onSave }: {
  defaults: AssistantThreadDefaults;
  onClose: () => void;
  onSave: (defaults: AssistantThreadLaunchDefaults) => Promise<void>;
}) {
  const form = useId();
  const [harness, setHarness] = useState(defaults.harness);
  const [accountRef, setAccountRef] = useState(defaults.launchDefaults?.providerAccount?.accountRef ?? MACHINE_ACCOUNT_POLICY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = defaults.harnesses.find((option) => option.id === harness)?.accountSelection;
  const selected = choices?.accounts.find((account) => account.accountRef === accountRef && !account.reason);
  const policy = accountRef === MACHINE_ACCOUNT_POLICY;

  const save = async () => {
    if (busy || (!policy && !selected)) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ harness, providerAccount: choices && selected
        ? { runnerId: choices.runnerId, accountRef: selected.accountRef } : null });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return <Modal title="Default Harness and Account" description="New threads start with these choices. You can choose a different harness or account when starting a thread."
    onClose={busy ? () => {} : onClose}
    footer={<>
      <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <BusyButton className="btn primary" form={form} type="submit" busy={busy} disabled={!policy && !selected} progress="Saving defaults…">
        Save Defaults
      </BusyButton>
    </>}>
    <form id={form} className="form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <ChoiceRows<AssistantThreadHarness> label="Default Harness" value={harness}
        onChange={(next) => { setHarness(next); setAccountRef(MACHINE_ACCOUNT_POLICY); }}
        options={defaults.harnesses.map((option) => ({ value: option.id, title: option.label, description: option.reason, disabled: busy }))} />
      {choices && !choices.unavailable && <AssistantThreadAccountField choices={choices} value={accountRef}
        onChange={setAccountRef} disabled={busy} usePolicy="default" label="Default Provider Account" />}
      {!policy && !selected && <Notice tone="warning"
        actions={<button type="button" className="btn sm" onClick={() => setAccountRef(MACHINE_ACCOUNT_POLICY)}>Use Machine Policy</button>}>
        The saved account is unavailable. Choose an eligible account or use the Machine's policy for future threads.
      </Notice>}
      {(!choices || choices.unavailable) && <p className="muted">{choices?.unavailable ?? "Account choices appear when a Machine can start this harness."}</p>}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </form>
  </Modal>;
}
