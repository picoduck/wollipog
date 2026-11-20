import { useEffect, useId, useState } from "react";
import type { AssistantThread, AssistantThreadHarness, AssistantThreadHarnessOption } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { AssistantThreadAccountField } from "./AssistantThreadAccountField.js";
import { ArrowLeftRightIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { Skeleton } from "./common.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";

export function ChangeAssistantThreadHarnessDialog({ thread, onClose, onChanged }: {
  thread: AssistantThread;
  onClose: () => void;
  onChanged: (thread: AssistantThread) => void;
}) {
  const api = useApi();
  const harnessLabelId = useId();
  const [options, setOptions] = useState<AssistantThreadHarnessOption[] | null>(null);
  const [harness, setHarness] = useState<AssistantThreadHarness | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api.assistantThreadHarnessChoices(thread.id).then(({ harnesses }) => {
      if (current) setOptions(harnesses);
    }, (cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : "Could not load harnesses.");
    });
    return () => { current = false; };
  }, [api, thread.id]);

  const target = options?.find((option) => option.id === harness);
  const selected = target?.accountSelection?.accounts.find((item) => item.accountRef === account && !item.reason);
  const change = async () => {
    if (!target || !selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.changeAssistantThreadHarness(thread.id, {
        expectedSessionId: thread.sessionId, harness: target.id, providerAccountRef: selected.accountRef,
      });
      onChanged(result.thread);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the harness.");
    } finally {
      setBusy(false);
    }
  };

  return <Modal title={confirming ? "Confirm Harness Change" : "Change Harness"}
    phoneSheet="full" onClose={busy ? () => {} : onClose}
    footer={<>
      <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      {confirming ? <>
        <button type="button" className="btn" disabled={busy} onClick={() => { setConfirming(false); setError(null); }}>Back</button>
        <BusyButton className="btn primary" busy={busy} progress="Starting the selected harness…"
          icon={<ArrowLeftRightIcon size={14} aria-hidden="true" />} onClick={() => void change()}>
          Change Harness
        </BusyButton>
      </> : <button type="button" className="btn primary" disabled={!selected} onClick={() => setConfirming(true)}>Review Change</button>}
    </>}>
    <div className="form">
      {confirming && target && selected ? <>
        <p>Future messages will go to {target.id === "codex" ? "OpenAI" : "Anthropic"} through {target.label}.</p>
        <div className="field">
          <span>Account</span>
          <AccountIdentifier value={selected.label} label="Account Email" identity={selected.accountRef} />
        </div>
        <p>The new conversation starts fresh. Earlier messages stay readable in this thread. Linked work, usage, budget and launch limit carry over.</p>
        {thread.decisionDelegation?.grant?.categories.includes("ui_evidence_review") &&
          <Notice tone="warning">Confirm the provider disclosure again in Decision Delegation before using UI Evidence Approval.</Notice>}
        {busy && <p role="status">Starting the selected harness. The original conversation is kept until the new harness is ready.</p>}
      </> : <>
        {!options && !error && <Skeleton rows={2} announce="Loading harnesses…" />}
        {options && <div className="field">
          <span id={harnessLabelId}>Harness</span>
          <ChoiceRows className="assistant-thread-account-picker" label="Harness" labelledBy={harnessLabelId} value={harness}
          onChange={(id) => { setHarness(options.find((option) => option.id === id)?.id ?? null); setAccount(null); }}
          options={options.map((option) => ({
            value: option.id, title: option.label, disabled: !option.available, disabledReason: option.reason,
          }))} />
        </div>}
        {target?.accountSelection && <AssistantThreadAccountField choices={target.accountSelection}
          value={account} onChange={setAccount} disabled={busy} />}
      </>}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </div>
  </Modal>;
}
