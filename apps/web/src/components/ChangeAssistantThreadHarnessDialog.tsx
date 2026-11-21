import { useEffect, useId, useState } from "react";
import type { AssistantThread, AssistantThreadHarness, AssistantThreadHarnessOption, ChangeAssistantThreadHarnessRequest } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { AssistantThreadAccountField } from "./AssistantThreadAccountField.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { Skeleton } from "./common.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";

export function ChangeAssistantThreadHarnessDialog({ thread, draft, onClose, onChoose }: {
  thread: AssistantThread;
  draft?: ChangeAssistantThreadHarnessRequest;
  onClose: () => void;
  onChoose: (input: ChangeAssistantThreadHarnessRequest, harnessLabel: string, accountLabel: string) => void;
}) {
  const api = useApi();
  const harnessLabelId = useId();
  const [options, setOptions] = useState<AssistantThreadHarnessOption[] | null>(null);
  const [harness, setHarness] = useState<AssistantThreadHarness | null>(draft?.harness ?? null);
  const [account, setAccount] = useState<string | null>(draft?.providerAccountRef ?? null);
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

  const target = options?.find((option) => option.id === harness && option.available);
  const selected = target?.accountSelection?.accounts.find((item) => item.accountRef === account && !item.reason);
  return <Modal title="Change Harness" phoneSheet="full" onClose={onClose}
    footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" disabled={!selected} onClick={() => {
        if (target && selected) onChoose({
          expectedSessionId: thread.sessionId, harness: target.id, providerAccountRef: selected.accountRef,
        }, target.label, selected.label);
      }}>Use Harness</button>
    </>}>
    <div className="form">
      {!options && !error && <Skeleton rows={2} announce="Loading harnesses…" />}
      {options && <div className="field">
        <span id={harnessLabelId}>Harness</span>
        <ChoiceRows className="assistant-thread-account-picker" label="Harness" labelledBy={harnessLabelId} value={harness}
          onChange={(id) => { setHarness(options.find((option) => option.id === id)?.id ?? null); setAccount(null); }}
          options={options.map((option) => ({
            value: option.id, title: option.label, disabled: !option.available, disabledReason: option.reason,
          }))} />
      </div>}
      {target?.accountSelection && <AssistantThreadAccountField choices={target.accountSelection} value={account} onChange={setAccount} disabled={false} />}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </div>
  </Modal>;
}
