import { useEffect, useState } from "react";
import type { AssistantThreadAccountChoices } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ApiError } from "../api.js";
import type { AssistantThread } from "../assistant-threads.js";
import { AssistantThreadAccountField } from "./AssistantThreadAccountField.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { Skeleton } from "./common.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox } from "./ui/ChoiceControls.js";

export function ChangeAssistantThreadAccountDialog({ thread, onClose, onChanged }: {
  thread: AssistantThread;
  onClose: () => void;
  onChanged: (thread: AssistantThread) => void;
}) {
  const api = useApi();
  const [choices, setChoices] = useState<AssistantThreadAccountChoices | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [freshConversation, setFreshConversation] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    void api.assistantThreadAccountChoices(thread.id).then((result) => {
      if (current) setChoices(result);
    }, (error: unknown) => {
      if (!current) return;
      setFailure(error instanceof ApiError && error.status === 404 && error.details?.error === "not found"
        ? "Update the control plane to change the thread's account."
        : error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [api, thread.id]);

  const change = async () => {
    if (!choices || !account || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.changeAssistantThreadAccount(thread.id, {
        providerAccountRef: account, expectedProviderAccountRef: choices.currentAccountRef ?? null, freshConversation,
      });
      onChanged(result.thread);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  return (
    <Modal title="Change Account" onClose={busy ? () => {} : onClose}
      description="Restart this thread on another account. Its existing messages and launched work stay here."
      footer={(
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <BusyButton className="btn primary" busy={busy} disabled={!account}
            progress="Changing the account…" onClick={() => void change()}>Change Account</BusyButton>
        </>
      )}
    >
      <div className="form">
        {!choices && !failure && <Skeleton rows={2} announce="Loading accounts…" />}
        {choices && <>
          <AssistantThreadAccountField choices={choices} value={account} onChange={setAccount} disabled={busy} />
          <Checkbox label="Start a Fresh Conversation" checked={freshConversation} disabled={busy}
            onChange={setFreshConversation}
            helper="Use this if the provider can't carry the conversation over. The assistant starts without the context from earlier messages." />
        </>}
        {failure && <Notice tone="danger" role="alert">{failure}</Notice>}
      </div>
    </Modal>
  );
}
