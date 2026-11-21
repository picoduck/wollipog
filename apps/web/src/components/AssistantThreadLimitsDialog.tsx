import { useEffect, useId, useRef, useState } from "react";
import type { AssistantThreadLimits } from "@wollipog/protocol";
import { assistantThreadHarnessLabel, assistantThreadsUnavailable, type AssistantThread } from "../assistant-threads.js";
import { formatUsd, parseCount, parseUsd } from "../guardrail-values.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { ASSISTANT_DEFAULTS_VIEW, AssistantSettingsLink } from "./AssistantSettingsLink.js";
import { ChangeAssistantThreadAccountDialog } from "./ChangeAssistantThreadAccountDialog.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox } from "./ui/ChoiceControls.js";
import { ActionRow, SettingsGroup } from "./ui/SettingsRows.js";

export function AssistantThreadLimitsDialog({ defaults, limits, thread, model, effort, startAtSpending, onNewThread, onChangeHarness, onAccountChanged, onClose, onSave }: {
  defaults?: boolean;
  limits?: AssistantThreadLimits;
  thread?: AssistantThread;
  model?: string | null;
  effort?: string | null;
  startAtSpending?: boolean;
  onNewThread?: () => void;
  onChangeHarness?: () => void;
  onAccountChanged?: (thread: AssistantThread) => void;
  onClose: () => void;
  onSave: (limits: AssistantThreadLimits) => Promise<void>;
}) {
  const form = useId();
  const [cost, setCost] = useState(limits?.costUsd?.toString() ?? "");
  const [launches, setLaunches] = useState(limits?.launchedSessions?.toString() ?? "");
  const [noCostLimit, setNoCostLimit] = useState(limits?.costUsd === null);
  const [noLaunchLimit, setNoLaunchLimit] = useState(limits?.launchedSessions === null);
  const [editingAccount, setEditingAccount] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLElement>(null);
  const spendingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);
  const readOnly = thread?.status === "archived" ? "Archived threads are read-only."
    : !limits ? "This control plane does not report thread limits. Update Wollipog to manage them."
    : thread && !thread.limitsEditable ? "This control plane uses fixed thread limits. Update Wollipog to change them." : null;

  const persist = async (next: AssistantThreadLimits) => {
    if (saving || readOnly) return;
    setError(null);
    setSaving(true);
    try {
      await onSave(next);
      if (defaults) onClose();
      if (next.costUsd === null) setNoCostLimit(true);
    } catch (cause) {
      setError(assistantThreadsUnavailable(cause)
        ? "This version of Wollipog uses fixed Assistant thread limits. Update Wollipog to change them."
        : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const save = async () => {
    if (saving || readOnly) return;
    if (!noCostLimit && !cost.trim()) return setError("Enter a cost budget or choose No Limit.");
    if (!noLaunchLimit && !launches.trim()) return setError("Enter a session launch limit or choose No Limit.");
    const budget = parseUsd(noCostLimit ? "" : cost);
    const count = parseCount(noLaunchLimit ? "" : launches, Number.POSITIVE_INFINITY);
    if (!budget.ok) return setError(budget.error);
    if (budget.value !== null && budget.value !== limits?.costUsd && (!Number.isSafeInteger(Math.round(budget.value * 100)) ||
        Number(budget.value.toFixed(2)) !== budget.value)) {
      return setError("Enter a cost budget in whole cents, such as 2.50.");
    }
    if (!count.ok) return setError(count.error);
    await persist({ costUsd: budget.value, launchedSessions: count.value });
  };

  const account = thread?.providerAccountLabel
    ? <AccountIdentifier value={thread.providerAccountLabel} label="Account Email" identity={thread.id} />
    : thread?.accountChangeSupported ? "Machine Sign-In" : "Unavailable";
  const accountRefusal = thread?.status === "archived" ? "Archived threads are read-only."
    : !thread?.accountChangeSupported ? "This control plane does not support changing the account."
    : thread.status === "working" ? "Wait for the current turn to finish before changing the account." : null;
  return (
    <Modal
      title={defaults ? "Default Thread Limits" : "Thread Settings"}
      description={defaults ? "These limits apply to new Assistant threads." : "The cost budget covers this thread and the work it launches."}
      phoneSheet={thread ? "full" : undefined}
      initialFocusRef={startAtSpending ? spendingRef : undefined}
      onClose={saving ? () => {} : onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={saving}>{thread ? "Done" : "Cancel"}</button>
        <BusyButton className="btn primary" type="submit" form={form} busy={saving} disabled={Boolean(readOnly)} progress="Saving limits…">Save Limits</BusyButton>
      </>}
    >
      {thread && <>
        <SettingsGroup title="Conversation" foot={thread.decisionDelegation && thread.status !== "archived"
          ? <AssistantSettingsLink view={{ name: "assistants", threadId: thread.id, delegation: true }}>Decision Delegation</AssistantSettingsLink>
          : undefined}>
          <ActionRow title="Harness"
            description={<>{[assistantThreadHarnessLabel(thread.harness), model, effort].filter(Boolean).join(" · ")}<br />
              {thread.harnessChangeSupported
                ? "Changing harnesses starts a fresh provider conversation. Earlier conversations remain readable in this thread."
                : "This thread's conversation belongs to this harness. Start a new thread to use a different one."}</>}
            actionLabel={thread.harnessChangeSupported ? "Change Harness…" : "New Thread"} hasPopup="dialog"
            onAction={() => (thread.harnessChangeSupported ? onChangeHarness : onNewThread)?.()} />
          <ActionRow title="Account" description={<>{account}{accountRefusal && <><br />{accountRefusal}</>}</>}
            actionLabel="Change Account…" disabled={Boolean(accountRefusal) || editingAccount}
            onAction={() => setEditingAccount(true)} />
        </SettingsGroup>
        {editingAccount && <ChangeAssistantThreadAccountDialog inline thread={thread} onClose={() => setEditingAccount(false)}
          onChanged={(next) => { setEditingAccount(false); onAccountChanged?.(next); }} />}
        <div className="field">
          <p className="field-helper">You can edit this budget in Session Guardrails. Use Assistant Defaults for new threads.</p>
          <div className="notice-actions">
            <AssistantSettingsLink view={{ name: "session", id: thread.sessionId, guardrails: true }}>Session Guardrails</AssistantSettingsLink>
            <AssistantSettingsLink view={ASSISTANT_DEFAULTS_VIEW}>Assistant Defaults</AssistantSettingsLink>
          </div>
        </div>
        {readOnly && <Notice tone="neutral" role="status">{readOnly}</Notice>}
      </>}
      <form id={form} className="form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {thread && <h3 className="field-label" ref={spendingRef} tabIndex={-1}>Spending</h3>}
        <div className="field" role="group" aria-label="Cost Budget">
          <label className="field">
            <span>Cost Budget (USD)</span>
            <input value={noCostLimit ? "" : cost} placeholder={noCostLimit ? "No Limit" : undefined} inputMode="decimal"
              disabled={saving || noCostLimit || Boolean(readOnly)} onChange={(event) => setCost(event.target.value)} />
          </label>
          {thread?.usage && <p className="field-helper">{formatUsd(thread.usage.costUsd.used)} spent.</p>}
          <Checkbox label="No Limit" checked={noCostLimit} disabled={saving || Boolean(readOnly)} onChange={setNoCostLimit} />
        </div>
        <div className="field" role="group" aria-label="Session Launch Limit">
          <label className="field">
            <span>Session Launch Limit</span>
            <input value={noLaunchLimit ? "" : launches} placeholder={noLaunchLimit ? "No Limit" : undefined} inputMode="numeric"
              disabled={saving || noLaunchLimit || Boolean(readOnly)} onChange={(event) => setLaunches(event.target.value)} />
          </label>
          {thread?.usage && <p className="field-helper">{thread.usage.launchedSessions.used} launched.</p>}
          <Checkbox label="No Limit" checked={noLaunchLimit} disabled={saving || Boolean(readOnly)} onChange={setNoLaunchLimit} />
        </div>
        {!readOnly && <p className="muted">Set the launch limit to 0 to pause new launches.</p>}
        {thread && limits?.costUsd === 25 && !readOnly && <div className="field-row">
          <button type="button" className="btn" disabled={saving} onClick={() => void persist({ ...limits, costUsd: null })}>Remove Cost Limit</button>
        </div>}
        {error && <Notice tone="danger" role="alert" noticeRef={errorRef}>{error}</Notice>}
      </form>
    </Modal>
  );
}
