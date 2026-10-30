import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStore } from "../store.js";
import { POD_SESSION_RULE, newPodBlockedReason, podEligibleSessions } from "../pod-session-choices.js";
import { PodsIcon } from "./Icons.js";
import { Modal } from "./common.js";
import { Notice } from "./Notice.js";
import { PodSessionChoices } from "./PodSessionChoices.js";
import { State } from "./State.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * New Pod (#2982; docs/design-system.md §7, §8, §12): a Name, an optional Objective and the eligible
 * sessions as one filterable list. Create Pod stays disabled with its reason in the footer until a
 * name and two sessions are chosen; a server error is a danger notice at the body's end. With no
 * eligible session the list's place says No Sessions Can Join and offers New Session…. On a phone
 * it is a full-height sheet. While the pod is being created the dialog cannot be dismissed or
 * replaced, so the person always lands on the pod it made or sees why it wasn't.
 */
export function NewPodDialog({ onClose, onNewSession }: {
  onClose: () => void;
  /** Opens New Session in this dialog's place. */
  onNewSession?: () => void;
}) {
  const api = useApi();
  const { sessions, pods, navigate } = useStore();
  const ids = useId();
  const live = useMemo(() => podEligibleSessions(sessions.values(), pods.values()), [sessions, pods]);
  // The list as it stood when Create Pod was pressed, kept until the request settles: the new pod
  // reaches this device (pod_upsert) before the request's answer, and would otherwise empty the list
  // and offer New Session… in the middle of creating it (CR-1.1).
  const [submitted, setSubmitted] = useState<SessionView[] | null>(null);
  const candidates = submitted ?? live;
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Set on every setup, not only the first: StrictMode replays setup and cleanup once, and a flag
  // only ever cleared would drop the answer after the replay.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const creating = useRef(false);

  // A chosen session that has since joined another pod or ended no longer counts.
  const eligible = new Set(candidates.map((session) => session.id));
  const chosen = selected.filter((sessionId) => eligible.has(sessionId));
  const blockedReason = newPodBlockedReason(name, chosen.length);
  const reasonId = `${ids}-reason`;

  const toggle = (sessionId: string) => setSelected((current) =>
    current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId],
  );
  const close = () => { if (!creating.current) onClose(); };
  const newSession = () => { if (!creating.current) onNewSession?.(); };

  const submit = async () => {
    if (creating.current || blockedReason) return;
    creating.current = true;
    setSubmitted(candidates);
    setBusy(true);
    setFailure(null);
    try {
      const { pod } = await api.createPod({
        title: name.trim(),
        objective: objective.trim() || undefined,
        sessionIds: chosen,
      });
      creating.current = false;
      if (!mounted.current) return;
      navigate({ name: "pod", id: pod.id });
      onClose();
    } catch (cause) {
      creating.current = false;
      if (!mounted.current) return;
      setFailure(cause instanceof Error && cause.message ? cause.message : String(cause));
      setSubmitted(null);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New Pod"
      description="Group sessions so their agents can share notes and merge work."
      phoneSheet="full"
      onClose={close}
      footer={(
        <>
          {blockedReason && <span className="new-pod-reason" id={reasonId}>{blockedReason}</span>}
          <button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button>
          {/* "New Pod" opens the dialog; creating is its confirm, as "New Session" → "Create Session". */}
          <BusyButton className="btn primary" busy={busy} progress="Creating the pod…"
            disabled={Boolean(blockedReason)} aria-describedby={blockedReason ? reasonId : undefined}
            onClick={() => void submit()}>
            Create Pod
          </BusyButton>
        </>
      )}
    >
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span>Objective (Optional)</span>
          <textarea value={objective} rows={3} maxLength={4000} onChange={(event) => setObjective(event.target.value)} />
        </label>
        {candidates.length === 0 ? (
          <State
            compact
            icon={<PodsIcon />}
            title="No Sessions Can Join"
            actions={onNewSession && (
              <button type="button" className="btn" disabled={busy} onClick={newSession}>New Session…</button>
            )}
          >
            {POD_SESSION_RULE}
          </State>
        ) : (
          <PodSessionChoices sessions={candidates} value={chosen} onToggle={toggle} />
        )}
      </div>
      {failure && (
        <Notice tone="danger" role="alert" details={<code>{failure}</code>}>
          The pod wasn't created. Try again.
        </Notice>
      )}
    </Modal>
  );
}
