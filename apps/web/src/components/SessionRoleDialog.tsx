import { useEffect, useRef, useState } from "react";
import { sessionRole, type OrchestratorDefaults, type SessionRoleConversionPreview, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStoreActions } from "../store.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { roleSettingsError, SessionRoleSettings } from "./SessionRoleSettings.js";

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
  const [draft, setDraft] = useState<OrchestratorDefaults | null>(null);
  const dirty = useRef(false);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    setPreview(null);
    setError(null);
    void api.sessionRolePreview(session.id, target).then((value) => {
      if (active) {
        setPreview(value);
        if (value.orchestratorPolicy && (!dirty.current || session.roleConversion)) {
          const { behavior, delegation, execution } = value.orchestratorPolicy;
          setDraft(structuredClone({ behavior, delegation, execution }));
        }
      }
    }, (cause) => { if (active) setError((cause as Error).message); });
    return () => { active = false; };
  }, [api, session.id, current, session.status, session.roleConversion?.phase, supported, target]);
  const settingsError = draft ? roleSettingsError(draft, preview?.orchestratorCapabilities) : null;
  const canChange = Boolean(preview && (preview.canRetry ||
    ((preview.available || (preview.policyError && !preview.policyInherited)) && !settingsError && (target !== "orchestrator" || draft))));
  const change = async () => {
    if (busy || !supported || !canChange) return;
    setBusy(true);
    setError(null);
    try {
      loadSession(await api.changeSessionRole(session.id, target, expected, target === "orchestrator" && !session.roleConversion && draft && !preview?.policyInherited ? draft : undefined));
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
      <button className="btn primary" disabled={busy || !supported || !canChange}
        onClick={() => void change()}>{busy ? "Changing Role…" : session.roleConversion ? "Retry Role Change" : `Change to ${targetLabel}`}</button>
    </>}>
    <p>Current Role: <strong>{current === "orchestrator" ? "Orchestrator" : "Standard"}</strong></p>
    <p>The idle provider will close. Its existing conversation resumes with the new role's tools and instructions when you send the next message. Your conversation history, account, project, and worktree stay with this session.</p>
    <p>Provider permissions stay unchanged{preview?.permissionMode ? ` (${preview.permissionMode})` : ""}.</p>
    {target === "orchestrator"
      ? <p>Orchestrator adds scoped child-management tools. Settings start from your current defaults, or the controlling campaign's policy; review them below before confirming.</p>
      : <p>Standard removes Orchestrator tools and delegated authority. Completed children keep their links and remain accessible to you. Live children and unsettled decisions prevent conversion.</p>}
    {target === "orchestrator" && draft && <SessionRoleSettings value={draft}
      capabilities={preview?.orchestratorCapabilities} disabled={busy || Boolean(preview?.policyInherited) || Boolean(session.roleConversion) || (!preview?.available && !preview?.policyError)}
      onChange={(value) => { dirty.current = true; setDraft(value); }} />}
    {preview?.policyInherited && <Notice>These settings are fixed by the controlling campaign and cannot be overridden by this session.</Notice>}
    {settingsError && <Notice tone="warning" role="alert">{settingsError}</Notice>}
    {!supported && <Notice tone="warning">Update the control plane before changing an existing session's role.</Notice>}
    {supported && !preview && !error && <p role="status">Checking role compatibility…</p>}
    {preview?.reason && !preview.policyError && <Notice tone="warning">{preview.reason}</Notice>}
    {session.roleConversion && <Notice>Role conversion is in progress. These settings are already recorded and cannot change during retry. Retry to reconcile the same selection.</Notice>}
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
  </Modal>;
}
