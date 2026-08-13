import { useMemo, useState } from "react";
import { isTerminal } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStore } from "../store.js";
import { Modal } from "./common.js";
import { sessionAgentLabel } from "./agent-options.js";

export function NewPodDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const { sessions, pods, navigate } = useStore();
  const occupied = useMemo(
    () => new Set([...pods.values()].filter((pod) => pod.status === "active").flatMap((pod) => pod.members.map((member) => member.sessionId))),
    [pods],
  );
  const candidates = useMemo(
    () => [...sessions.values()]
      .filter((session) => session.useWorktree && !isTerminal(session.status) && !occupied.has(session.id))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, occupied],
  );
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (sessionId: string) => setSelected((current) =>
    current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId],
  );

  const submit = async () => {
    if (busy) return;
    if (!title.trim()) return setError("Enter a pod title.");
    if (selected.length < 2) return setError("Select at least two isolated sessions.");
    setBusy(true);
    setError(null);
    try {
      const { pod } = await api.createPod({
        title: title.trim(),
        objective: objective.trim() || undefined,
        sessionIds: selected,
      });
      navigate({ name: "pod", id: pod.id });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New Collaboration Pod"
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !title.trim() || selected.length < 2} onClick={() => void submit()}>
            {busy ? "Creating…" : `Create pod · ${selected.length} members`}
          </button>
        </>
      }
    >
      <div className="form">
        <p className="muted">
          Pods group existing sessions across agents and runners. Only isolated worktree sessions are eligible.
        </p>
        <label className="field">
          <span>Title</span>
          <input value={title} maxLength={120} autoFocus onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="field">
          <span>Objective (Optional)</span>
          <textarea value={objective} rows={3} maxLength={4000} onChange={(event) => setObjective(event.target.value)} />
        </label>
        <div className="field">
          <span>Isolated Sessions</span>
          {candidates.length === 0 ? (
            <p className="muted">Start at least two worktree sessions that are not already in a pod.</p>
          ) : (
            <div className="pod-member-picks">
              {candidates.map((session) => (
                <label key={session.id} className={`pod-member-pick ${selected.includes(session.id) ? "on" : ""}`}>
                  <input type="checkbox" checked={selected.includes(session.id)} onChange={() => toggle(session.id)} />
                  <span>
                    <strong>{session.title || "Untitled"}</strong>
                    <small>
                      {sessionAgentLabel(session.agentName, session.driver, session.agentId)} · {session.runnerId}
                      {session.worktreePath ? " · Worktree Ready" : " · Worktree Starting"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
