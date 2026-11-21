import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_ASSISTANT_THREAD_LIMITS, type AssistantDecisionDelegation, type AssistantThreadLimits,
  type ChangeAssistantThreadAccountRequest, type ChangeAssistantThreadHarnessRequest,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { formatAssistantDelegationSummary } from "../assistant-decision-delegation.js";
import { assistantThreadHarnessLabel, assistantThreadsUnavailable, type AssistantThread } from "../assistant-threads.js";
import { formatUsd, parseCount, parseUsd, plainDecimal } from "../guardrail-values.js";
import { useTimelineClock } from "../timeline-clock.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { AssistantBudgetPresets, assistantBudgetSelection } from "./AssistantBudgetPresets.js";
import { AssistantDecisionDelegationDialog } from "./AssistantDecisionDelegationDialog.js";
import { ASSISTANT_DEFAULTS_VIEW, AssistantSettingsLink } from "./AssistantSettingsLink.js";
import { ThreadUsageMeter } from "./AssistantThreadPanel.js";
import { ChangeAssistantThreadAccountDialog } from "./ChangeAssistantThreadAccountDialog.js";
import { ChangeAssistantThreadHarnessDialog } from "./ChangeAssistantThreadHarnessDialog.js";
import { ArrowLeftRightIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ActionRow, SettingsGroup, SwitchRow } from "./ui/SettingsRows.js";
import { useIsMobile } from "./useIsMobile.js";

type ConversationEdit =
  | { kind: "harness"; input: ChangeAssistantThreadHarnessRequest; harnessLabel: string; accountLabel: string }
  | { kind: "account"; input: ChangeAssistantThreadAccountRequest; sessionId: string; accountLabel: string };
type Editor = "harness" | "account" | "delegation" | "confirm";

// An older server stores a zero cap instead of a pause flag. Only this browser tab knows the
// previous limit in that case. Threads paused elsewhere resume at the standard launch limit.
function legacyLaunchLimit(threadId: string): number | null {
  try {
    const stored = sessionStorage.getItem(`assistant-launch-limit:${threadId}`);
    if (stored === "null") return null;
    const count = Number(stored);
    if (count > 0 && Number.isSafeInteger(count)) return count;
  } catch { /* Browser storage is optional. */ }
  return DEFAULT_ASSISTANT_THREAD_LIMITS.launchedSessions;
}

export function AssistantThreadLimitsDialog({ thread, model, effort, onClose, onChanged }: {
  thread: AssistantThread;
  model?: string;
  effort?: string;
  onClose: () => void;
  onChanged: (thread: AssistantThread) => void;
}) {
  const api = useApi();
  const phone = useIsMobile();
  const form = useId();
  const costLimit = thread.usage?.costUsd.limit ?? null;
  const launchLimit = thread.usage?.launchedSessions.limit ?? null;
  const [cost, setCost] = useState(() => costLimit === null ? "" : plainDecimal(costLimit));
  const [selection, setSelection] = useState(() => assistantBudgetSelection(costLimit));
  const [launches, setLaunches] = useState(() => {
    const limit = launchLimit === 0 ? legacyLaunchLimit(thread.id) : launchLimit;
    return limit === null ? "" : String(limit);
  });
  const [paused, setPaused] = useState(thread.launchPaused || launchLimit === 0);
  const [costEdited, setCostEdited] = useState(false);
  const [launchesEdited, setLaunchesEdited] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [conversation, setConversation] = useState<ConversationEdit | null>(null);
  const [delegation, setDelegation] = useState<AssistantDecisionDelegation>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);
  const closeEditor = () => setEditor(null);
  const grant = (delegation ?? thread.decisionDelegation)?.grant;
  const now = useTimelineClock(grant?.expiresAt != null);
  const archived = thread.status === "archived";
  const readOnly = archived ? "Archived threads are read-only."
    : !thread.usage ? "This control plane does not report thread limits. Update Wollipog to manage them."
    : !thread.limitsEditable ? "This control plane uses fixed thread limits. Update Wollipog to change them." : null;
  const disabled = saving || Boolean(readOnly);
  const working = thread.status === "working";
  const conversationDisabled = saving || archived || working;
  const saveDisabled = archived || (Boolean(readOnly) && !conversation);
  const conversationHelp = !readOnly && working ? "Wait for the current turn to finish before changing the conversation."
    : !readOnly && !thread.harnessChangeSupported ? "Start a new thread to use a different harness."
    : "Changing the harness starts a fresh provider conversation. Earlier conversations stay readable.";
  const accountLabel = conversation?.accountLabel ?? thread.providerAccountLabel;
  const providerChange = conversation?.kind === "harness";
  const restarting = providerChange || (conversation?.kind === "account" && conversation.input.freshConversation);
  const parsedCount = parseCount(launches, Number.MAX_SAFE_INTEGER, 1);

  const save = async (confirmed = false) => {
    if (saving || saveDisabled) return;
    setError(null);
    const budget = parseUsd(selection === "none" ? "" : cost);
    let limits: AssistantThreadLimits | undefined;
    if (costEdited || launchesEdited) {
      if (costEdited) {
        if (!budget.ok) return setError(budget.error);
        if (selection === "custom" && budget.value === null) return setError("Enter a cost budget or choose No Limit.");
        if (budget.value !== null && budget.value !== costLimit && (!Number.isSafeInteger(Math.round(budget.value * 100)) ||
            Number(budget.value.toFixed(2)) !== budget.value)) return setError("Enter a cost budget in whole cents, such as 2.50.");
      }
      if (launchesEdited && !parsedCount.ok) return setError(parsedCount.error);
      const canPreservePause = thread.launchPaused !== undefined;
      const count = parsedCount.ok ? parsedCount.value : null;
      limits = {
        costUsd: costEdited && budget.ok ? budget.value : costLimit,
        launchedSessions: launchesEdited ? paused && !canPreservePause ? 0 : count : launchLimit,
        ...(canPreservePause && launchesEdited ? { launchPaused: paused } : {}),
      };
    }
    if (conversation) {
      if (working) return setError("Wait for the current turn to finish before changing the conversation.");
      const expectedSessionId = conversation.kind === "harness" ? conversation.input.expectedSessionId : conversation.sessionId;
      if (expectedSessionId !== thread.sessionId) {
        setConversation(null);
        return setError("The conversation changed in another window. Choose a harness or account again.");
      }
      if (!confirmed) return setEditor("confirm");
    }
    setSaving(true);
    const applied: string[] = [];
    try {
      if (limits) {
        onChanged((await api.setAssistantThreadLimits(thread.id, limits)).thread);
        if (launchesEdited && thread.launchPaused === undefined) {
          try {
            const key = `assistant-launch-limit:${thread.id}`;
            if (paused && parsedCount.ok) sessionStorage.setItem(key, JSON.stringify(parsedCount.value));
            else sessionStorage.removeItem(key);
          } catch { /* The limit was saved even if browser storage is unavailable. */ }
        }
        setCostEdited(false);
        setLaunchesEdited(false);
        applied.push("Spending changes");
      }
      if (delegation) {
        onChanged((await api.setAssistantThreadDelegation(thread.id, delegation)).thread);
        setDelegation(undefined);
        applied.push("Decision delegation");
      }
      // Restart last: a provider change invalidates disclosure for the former conversation.
      if (conversation) {
        const result = conversation.kind === "harness"
          ? await api.changeAssistantThreadHarness(thread.id, conversation.input)
          : await api.changeAssistantThreadAccount(thread.id, conversation.input);
        onChanged(result.thread);
      }
      onClose();
    } catch (cause) {
      const message = assistantThreadsUnavailable(cause)
        ? "This control plane could not save the change. Update Wollipog and try again."
        : cause instanceof Error ? cause.message : String(cause);
      setError(applied.length ? `${applied.join(" and ")} saved. ${message}` : message);
    } finally {
      setSaving(false);
    }
  };

  const saveButton = <BusyButton className="btn primary" type="submit" form={form} busy={saving}
    disabled={saveDisabled} progress="Saving changes…">Save Changes</BusyButton>;
  const editLaunches = (value: string) => {
    setLaunches(value);
    setLaunchesEdited(true);
  };
  const launchCount = parsedCount.ok ? parsedCount.value : null;
  const preview = parseUsd(cost);
  const budgetPreview = selection === "none" ? null : preview.ok ? preview.value ?? costLimit : costLimit;
  return <>
    {editor !== "confirm" && <Modal title="Thread Settings" phoneSheet="full" onClose={saving ? () => {} : onClose}
      className="assistant-thread-settings"
      headerActions={phone ? <>
        <button type="button" className="btn assistant-thread-settings-cancel" onClick={onClose} disabled={saving}>Cancel</button>
        {saveButton}
      </> : undefined}
      footer={phone ? undefined : <>
        <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        {saveButton}
      </>}>
      <form id={form} className="form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {readOnly && <Notice tone="neutral" role="status">{readOnly}</Notice>}
        {error && <Notice tone="danger" role="alert" noticeRef={errorRef}>{error}</Notice>}
        <SettingsGroup title="Conversation" foot={conversationHelp}>
          <ActionRow title="Harness" description={providerChange ? conversation.harnessLabel
            : [assistantThreadHarnessLabel(thread.harness), model ?? "Model Unavailable", effort ?? "Effort Unavailable"].join(" · ")}
            actionLabel="Change…" hasPopup="dialog" disabled={conversationDisabled || !thread.harnessChangeSupported}
            onAction={() => setEditor("harness")} />
          <ActionRow title="Account" description={accountLabel
            ? <AccountIdentifier className="assistant-thread-account-label" value={accountLabel} label="Account Email" identity={thread.id} />
            : thread.accountChangeSupported ? "Machine Sign-In" : "Unavailable"}
            actionLabel="Change…" hasPopup="dialog"
            disabled={conversationDisabled || (!providerChange && !thread.accountChangeSupported)}
            onAction={() => setEditor(providerChange ? "harness" : "account")} />
        </SettingsGroup>
        {conversation && <div className="field-row">
          <button type="button" className="btn ghost" disabled={conversationDisabled} onClick={() => setConversation(null)}>Undo Conversation Change</button>
        </div>}
        <SettingsGroup title="Spending">
          <div className="setting-row assistant-thread-spending-row">
            <div className="field">
              <strong className="setting-row-title">Budget</strong>
              {thread.usage ? <>
                <AssistantBudgetPresets value={cost} selection={selection} disabled={disabled}
                  onChange={(value, next) => { setCost(value); setSelection(next); setCostEdited(true); }} />
                <ThreadUsageMeter label="Budget" value={{ used: thread.usage.costUsd.used, limit: budgetPreview }}
                  format={formatUsd} unlimited="No Budget" hideLabel />
              </> : <span className="muted">Unavailable</span>}
            </div>
          </div>
          <div className="setting-row assistant-thread-spending-row">
            <div className="field">
              <strong className="setting-row-title">Session Launches</strong>
              {thread.usage && <div className="assistant-launch-stepper" role="group" aria-label="Session Launches">
                <button type="button" className="btn" aria-label="Decrease Session Launch Limit"
                  disabled={disabled || launchCount === null || launchCount <= 1}
                  onClick={() => editLaunches(String((launchCount ?? 2) - 1))}>−</button>
                <input aria-label="Session Launch Limit" inputMode="numeric" placeholder="No Limit"
                  value={launches} disabled={disabled} onChange={(event) => editLaunches(event.target.value)} />
                <button type="button" className="btn" aria-label="Increase Session Launch Limit"
                  disabled={disabled || launchCount === Number.MAX_SAFE_INTEGER}
                  onClick={() => editLaunches(String((launchCount ?? 0) + 1))}>+</button>
                <button type="button" className="btn" aria-pressed={launches === ""} disabled={disabled}
                  onClick={() => editLaunches("")}>No Limit</button>
              </div>}
              {thread.usage && <span className="muted">{thread.usage.launchedSessions.used} launched.</span>}
            </div>
          </div>
          <SwitchRow title="Pause New Launches" description="The assistant keeps talking but can't start sessions."
            checked={Boolean(paused)} disabled={disabled} onClick={() => { setPaused(!paused); setLaunchesEdited(true); }} />
        </SettingsGroup>
        <SettingsGroup title="Decisions">
          <ActionRow title="Decision Delegation" description={thread.decisionDelegation ? formatAssistantDelegationSummary(grant, now) : "Unavailable"}
            actionLabel="Manage…" hasPopup="dialog" disabled={disabled || !thread.decisionDelegation}
            onAction={() => setEditor("delegation")} />
        </SettingsGroup>
        <p className="field-helper">For new-thread defaults, go to{" "}<AssistantSettingsLink
          view={ASSISTANT_DEFAULTS_VIEW} className="assistant-thread-defaults-link">Settings › Assistant</AssistantSettingsLink>.</p>
      </form>
    </Modal>}
    {editor === "harness" && <ChangeAssistantThreadHarnessDialog thread={thread}
      draft={conversation?.kind === "harness" ? conversation.input : undefined} onClose={closeEditor}
      onChoose={(input, harnessLabel, accountLabel) => {
        setConversation({ kind: "harness", input, harnessLabel, accountLabel });
        closeEditor();
      }} />}
    {editor === "account" && <ChangeAssistantThreadAccountDialog thread={thread}
      draft={conversation?.kind === "account" ? conversation.input : undefined} onClose={closeEditor}
      onChoose={(input, accountLabel) => {
        setConversation({ kind: "account", input, accountLabel, sessionId: thread.sessionId });
        closeEditor();
      }} />}
    {editor === "delegation" && thread.decisionDelegation && <AssistantDecisionDelegationDialog draft
      delegation={delegation ?? thread.decisionDelegation} evidenceReview={thread.evidenceReview} onClose={closeEditor}
      onSave={async (value) => setDelegation(value)} />}
    {editor === "confirm" && conversation && <Modal title="Confirm Conversation Change"
      onClose={saving ? () => {} : closeEditor}
      footer={<>
        <button type="button" className="btn" disabled={saving} onClick={closeEditor}>Keep Editing</button>
        <BusyButton className="btn primary" busy={saving} progress="Saving changes…"
          icon={<ArrowLeftRightIcon size={14} aria-hidden="true" />} onClick={() => void save(true)}>
          Confirm and Save
        </BusyButton>
      </>}>
      <div className="form">
        {providerChange
          ? <p>The Assistant will restart on {conversation.harnessLabel}. Future messages will go to {conversation.input.harness === "codex" ? "OpenAI" : "Anthropic"}.</p>
          : <p>The Assistant will restart on the selected account.</p>}
        <div className="field">
          <span>Account</span>
          <AccountIdentifier className="assistant-thread-account-label" value={conversation.accountLabel}
            label="Account Email" identity={conversation.input.providerAccountRef} />
        </div>
        <p>{restarting ? "The provider conversation starts fresh. " : "The Assistant will try to resume the current provider conversation. "}
          Earlier messages stay readable. Linked work, usage, budget and launch settings carry over.</p>
        {grant?.categories.includes("ui_evidence_review") && <Notice tone="warning">
          Confirm the provider disclosure again in Decision Delegation before using Approve UI Evidence.
        </Notice>}
        {saving && <p role="status">Saving thread settings. The original conversation is kept until the restart is ready.</p>}
        {error && <Notice tone="danger" role="alert" noticeRef={errorRef}>{error}</Notice>}
      </div>
    </Modal>}
  </>;
}
