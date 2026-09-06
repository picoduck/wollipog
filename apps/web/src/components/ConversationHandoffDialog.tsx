import { useRef, useState } from "react";
import { handoffDestinationError, type AgentDefinition, type SessionConfig } from "@wollipog/protocol";
import { Modal } from "./common.js";
import { effortLabel, permissionModeLabel } from "../format.js";
import { Select } from "./ui/ChoiceControls.js";

export function ConversationHandoffDialog({ agents, sourceDriver, turn, onClose, onCreate }: {
  agents: AgentDefinition[]; sourceDriver: string; turn: number; onClose: () => void;
  onCreate: (agentId: string, config: SessionConfig) => Promise<void>;
}) {
  const choices = agents.filter((agent) => agent.driver !== sourceDriver && ["claude-code", "codex-app-server"].includes(agent.driver ?? ""));
  const [agentId, setAgentId] = useState(choices[0]?.id ?? "");
  const agent = choices.find((item) => item.id === agentId);
  const [config, setConfig] = useState<SessionConfig>({ model: agent?.capabilities?.models.find((model) => !model.hidden)?.id });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const reason = handoffDestinationError(agent, sourceDriver, config);
  const model = agent?.capabilities?.models.find((item) => item.id === config.model);
  const submit = async () => {
    if (lock.current || reason) return;
    lock.current = true; setBusy(true); setError(undefined);
    try { await onCreate(agentId, config); } catch (cause) { setError((cause as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Modal title="Hand Off to Another Agent" onClose={busy ? () => {} : onClose} footer={<>
    <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
    <button className="btn primary" onClick={() => void submit()} disabled={busy || !!reason}>{busy ? "Creating…" : "Create Handoff"}</button>
  </>}>
    <div className="message-action-form">
    <p>Files come from the exact checkpoint after turn {turn}. The destination starts a fresh provider conversation. Its private state and credentials are independent.</p>
    <p>A draft contains up to 24,000 characters of visible user and assistant dialogue. Tool output, reasoning, questions and approvals are omitted. Attachment incompatibilities prevent creation. Review the draft and omission disclosure in the child before pressing Send. Creating the handoff sends nothing.</p>
    <div className="field"><span>Destination Agent</span><Select label="Destination Agent" value={agentId} disabled={busy}
      options={choices.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => {
        const next = choices.find((item) => item.id === value);
        setAgentId(value); setConfig({ model: next?.capabilities?.models.find((item) => !item.hidden)?.id });
      }} /></div>
    <div className="field"><span>Model</span><Select label="Model" value={config.model ?? ""} disabled={busy}
      options={(agent?.capabilities?.models.filter((item) => !item.hidden) ?? []).map((item) => ({ value: item.id, label: item.displayName ?? item.id }))}
      onChange={(value) => setConfig({ ...config, model: value, effort: undefined })} /></div>
    <div className="field"><span>Effort</span><Select label="Effort" value={config.effort ?? ""} disabled={busy}
      options={[{ value: "", label: "Default" }, ...(model?.efforts?.length ? model.efforts : agent?.capabilities?.effortLevels ?? []).map((item) => ({ value: item, label: effortLabel(item) }))]}
      onChange={(value) => setConfig({ ...config, effort: value || undefined })} /></div>
    <div className="field"><span>Permissions</span><Select label="Permissions" value={config.permissionMode ?? ""} disabled={busy}
      options={[{ value: "", label: "Default" }, ...(agent?.capabilities?.permissionModes ?? []).map((item) => ({ value: item, label: permissionModeLabel(item, agent?.driver) }))]}
      onChange={(value) => setConfig({ ...config, permissionMode: value || undefined })} /></div>
    {(reason || error) && <p role="alert">{error ?? reason}</p>}
    </div>
  </Modal>;
}
