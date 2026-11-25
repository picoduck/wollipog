import { useEffect, useState } from "react";
import type { AssistantThreadAccountChoices, ChangeAssistantThreadAccountRequest } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ApiError } from "../api.js";
import type { AssistantThread } from "../assistant-threads.js";
import { AssistantThreadAccountField } from "./AssistantThreadAccountField.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { Skeleton } from "./common.js";
import { Checkbox } from "./ui/ChoiceControls.js";

export function ChangeAssistantThreadAccountDialog({ thread, draft, onClose, onChoose }: {
  thread: AssistantThread;
  draft?: ChangeAssistantThreadAccountRequest;
  onClose: () => void;
  onChoose: (input: ChangeAssistantThreadAccountRequest, accountLabel: string) => void;
}) {
  const api = useApi();
  const [choices, setChoices] = useState<AssistantThreadAccountChoices | null>(null);
  const [account, setAccount] = useState<string | null>(draft?.providerAccountRef ?? null);
  const [freshConversation, setFreshConversation] = useState(draft?.freshConversation ?? false);
  const [failure, setFailure] = useState<string | null>(null);

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

  const selected = choices?.accounts.find((item) => item.accountRef === account && !item.reason &&
    (item.accountRef !== choices.currentAccountRef || choices.retryCurrentAccount));
  return <Modal title="Change Account" onClose={onClose}
    description="Restart this thread on another account. Its existing messages and launched work stay here."
    footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" disabled={!selected} onClick={() => {
        if (choices && selected) onChoose({
          providerAccountRef: selected.accountRef, expectedProviderAccountRef: choices.currentAccountRef ?? null, freshConversation,
        }, selected.label);
      }}>Use Account</button>
    </>}>
    <div className="form">
      {!choices && !failure && <Skeleton rows={2} announce="Loading accounts…" />}
      {choices && <>
        <AssistantThreadAccountField choices={choices} value={account} onChange={setAccount} disabled={false} />
        <Checkbox label="Start a Fresh Conversation" checked={freshConversation}
          onChange={setFreshConversation}
          helper="Use this if the provider can't carry the conversation over. The assistant starts without the context from earlier messages." />
      </>}
      {failure && <Notice tone="danger" role="alert">{failure}</Notice>}
    </div>
  </Modal>;
}
