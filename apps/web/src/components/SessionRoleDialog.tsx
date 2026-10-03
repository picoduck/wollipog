import { useEffect, useState } from "react";
import { WORKFLOW_DECISION_CATEGORIES, sessionRole, type SessionRoleConversionPreview, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStoreActions } from "../store.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";

const DECISION_LABELS = {
  implementation_question: "Implementation Questions", pr_merge: "PR Merge",
  merged_branch_deletion: "Merged Branch Deletion", follow_up_issue_publication: "Follow-Up Publication",
  ui_evidence_approval: "UI Evidence Approval",
};

export function SessionRoleDialog({ session, supported, onClose, returnFocusRef }: {
  session: SessionView;
  supported: boolean;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const { loadSession } = useStoreActions();
  const current = sessionRole(session);
  const target = session.roleConversion?.targetRole ?? (current === "normal" ? "orchestrator" : "normal");
  const expected = session.roleConversion ? (target === "normal" ? "orchestrator" : "normal") : current;
  const [preview, setPreview] = useState<SessionRoleConversionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    setPreview(null);
    setError(null);
    void api.sessionRolePreview(session.id, target).then((value) => {
      if (active) setPreview(value);
    }, (cause) => { if (active) setError((cause as Error).message); });
    return () => { active = false; };
  }, [api, session.id, current, session.status, session.roleConversion?.phase, supported, target]);
  const change = async () => {
    if (busy || !supported || (!preview?.available && !preview?.canRetry)) return;
    setBusy(true);
    setError(null);
    try {
      loadSession(await api.changeSessionRole(session.id, target, expected));
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      // A timeout may have committed already. Read the durable state before allowing another
      // click to choose a target; retry keeps the exact pending intent on the server.
      try { loadSession((await api.session(session.id)).session); } catch { /* Keep the original refusal. */ }
      setBusy(false);
    }
  };
  const targetLabel = target === "orchestrator" ? "Orchestrator" : "Standard";
  return <Modal title="Change Session Role" onClose={busy ? () => {} : onClose} returnFocusRef={returnFocusRef}
    footer={<>
      <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !supported || (!preview?.available && !preview?.canRetry)}
        onClick={() => void change()}>{busy ? "Changing Role…" : session.roleConversion ? "Retry Role Change" : `Change to ${targetLabel}`}</button>
    </>}>
    <p>Current role: <strong>{current === "orchestrator" ? "Orchestrator" : "Standard"}</strong></p>
    <p>The idle provider will close. Its existing conversation resumes with the new role's tools and instructions when you send the next message. Your conversation history, account, project, and worktree stay with this session.</p>
    <p>Provider permissions stay unchanged{preview?.permissionMode ? ` (${preview.permissionMode})` : ""}.</p>
    {target === "orchestrator"
      ? <p>Orchestrator adds scoped child-management tools and applies your current Orchestrator defaults, or the controlling campaign's policy.</p>
      : <p>Standard removes Orchestrator tools and delegated authority. Completed children keep their links and remain accessible to you. Live children and unsettled decisions prevent conversion.</p>}
    {preview?.orchestratorPolicy && <dl>
      <dt>Live Child Limit</dt><dd>{preview.orchestratorPolicy.behavior.maximumConcurrentChildren}</dd>
      <dt>Descendant Requests</dt><dd>{preview.orchestratorPolicy.delegation.parentControl === "off" ? "Human" : "Orchestrator"}</dd>
      <dt>Integration Isolation</dt><dd>{preview.orchestratorPolicy.execution.integrationIsolation ? "Enabled" : "Disabled"}</dd>
      {WORKFLOW_DECISION_CATEGORIES.map((category) => <div key={category}>
        <dt>{DECISION_LABELS[category]}</dt>
        <dd>{preview.orchestratorPolicy!.delegation.decisions[category] === "orchestrator" ? "Orchestrator" : "Human"}</dd>
      </div>)}
    </dl>}
    {!supported && <Notice tone="warning">Update the control plane before changing an existing session's role.</Notice>}
    {supported && !preview && !error && <p role="status">Checking role compatibility…</p>}
    {preview?.reason && <Notice tone="warning">{preview.reason}</Notice>}
    {session.roleConversion && <Notice>Role conversion is in progress. Retry to reconcile its recorded state.</Notice>}
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
  </Modal>;
}
