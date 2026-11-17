import { useEffect, useState } from "react";
import { useApi } from "../api-context.js";
import { ApiError } from "../api.js";
import {
  ASSISTANT_THREAD_HARNESS_LABELS,
  assistantThreadsUnavailable,
  type AssistantThread,
  type AssistantThreadDefaults,
  type AssistantThreadHarness,
} from "../assistant-threads.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { Skeleton } from "./common.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";

/** What New Thread says on a control plane that predates assistant threads. */
export const THREADS_UNAVAILABLE_MESSAGE =
  "Assistant threads aren't available on this control plane yet. Update Wollipog to start one.";

type DefaultsState =
  | { kind: "loading" }
  | { kind: "ready"; defaults: AssistantThreadDefaults }
  | { kind: "unavailable" }
  | { kind: "failed"; message: string };

/**
 * New Thread (#4664): pick Claude Code or Codex, with the saved Orchestrator harness preselected,
 * and optionally name the thread. A harness the control plane can't run says why and can't be
 * chosen; a refusal (409) shows the server's guidance and keeps the dialog open.
 */
export function NewAssistantThreadDialog({ unavailable, onClose, onCreated }: {
  /** The thread list already found no Thread API, so the dialog only explains. */
  unavailable: boolean;
  onClose: () => void;
  onCreated: (thread: AssistantThread) => void;
}) {
  const api = useApi();
  const [state, setState] = useState<DefaultsState>(unavailable ? { kind: "unavailable" } : { kind: "loading" });
  const [harness, setHarness] = useState<AssistantThreadHarness | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (unavailable) return;
    let current = true;
    setState({ kind: "loading" });
    void api.assistantThreadDefaults().then((defaults) => {
      if (!current) return;
      setState({ kind: "ready", defaults });
      const preferred = defaults.harnesses.find((option) => option.id === defaults.harness && option.available);
      setHarness(preferred?.id ?? defaults.harnesses.find((option) => option.available)?.id ?? null);
    }, (cause: unknown) => {
      if (!current) return;
      setState(assistantThreadsUnavailable(cause)
        ? { kind: "unavailable" }
        : { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { current = false; };
  }, [api, unavailable, attempt]);

  const create = async () => {
    if (!harness || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const trimmed = title.trim();
      const { thread } = await api.createAssistantThread({ harness, ...(trimmed ? { title: trimmed } : {}) });
      onCreated(thread);
    } catch (cause) {
      if (assistantThreadsUnavailable(cause)) setState({ kind: "unavailable" });
      else setFailure(cause instanceof ApiError && cause.status === 409 && cause.message
        ? cause.message
        : `The thread wasn't started. ${cause instanceof Error ? cause.message : String(cause)}`.trim());
    } finally {
      setBusy(false);
    }
  };

  const ready = state.kind === "ready";
  return (
    <Modal
      title="New Thread"
      description="Start a conversation with the Wollipog Assistant."
      onClose={busy ? () => {} : onClose}
      // Without a form the footer's Close is the one way out, so the header draws no second one.
      closeButton={ready}
      footer={ready ? (
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <BusyButton className="btn primary" busy={busy} progress="Starting the thread…" disabled={!harness}
            onClick={() => void create()}>
            Start Thread
          </BusyButton>
        </>
      ) : (
        <button type="button" className="btn" onClick={onClose}>Close</button>
      )}
    >
      {state.kind === "loading" && <Skeleton rows={2} announce="Loading harnesses…" />}
      {state.kind === "unavailable" && (
        <Notice tone="neutral" role="status" title="Threads Aren't Available Yet">{THREADS_UNAVAILABLE_MESSAGE}</Notice>
      )}
      {state.kind === "failed" && (
        <Notice tone="danger" role="alert" title="Couldn't Load Harnesses"
          actions={<button type="button" className="btn sm" onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
          details={<code>{state.message}</code>}>
          Retry to load the harnesses this thread can run on.
        </Notice>
      )}
      {ready && (
        <div className="form">
          <ChoiceRows<AssistantThreadHarness>
            label="Harness"
            value={harness}
            onChange={setHarness}
            options={state.defaults.harnesses.map((option) => ({
              value: option.id,
              title: option.label || ASSISTANT_THREAD_HARNESS_LABELS[option.id],
              description: option.id === state.defaults.harness ? "Your Orchestrator harness." : undefined,
              disabled: !option.available,
              disabledReason: option.available ? undefined : option.reason ?? "Not available on your machines.",
            }))}
          />
          <label className="field">
            <span>Title (Optional)</span>
            <input value={title} maxLength={200} placeholder="New Thread" onChange={(event) => setTitle(event.target.value)} />
          </label>
          {failure && <Notice tone="danger" role="alert">{failure}</Notice>}
        </div>
      )}
    </Modal>
  );
}
