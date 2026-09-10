import { useRef, useState } from "react";
import { handoffDestinationError, type AgentDefinition, type SessionConfig } from "@wollipog/protocol";
import { Modal } from "./common.js";
import { effortLabel, permissionModeLabel } from "../format.js";
import { Select } from "./ui/ChoiceControls.js";

/** Seed a destination config, carrying forward the source session's deliberate service-tier choice.
 * The tier is carried even when this destination cannot honour it, so the dialog can say so before
 * the handoff is created rather than substituting a different tier behind the user's back. */
function seedConfig(agent: AgentDefinition | undefined, sourceServiceTier: string | undefined): SessionConfig {
  return {
    model: agent?.capabilities?.models.find((model) => !model.hidden)?.id,
    ...(sourceServiceTier ? { serviceTier: sourceServiceTier } : {}),
  };
}

export function ConversationHandoffDialog({ agents, sourceDriver, sourceServiceTier, turn, onClose, onCreate }: {
  agents: AgentDefinition[]; sourceDriver: string; sourceServiceTier?: string; turn: number; onClose: () => void;
  onCreate: (agentId: string, config: SessionConfig) => Promise<void>;
}) {
  const choices = agents.filter((agent) => agent.driver !== sourceDriver && ["claude-code", "codex-app-server"].includes(agent.driver ?? ""));
  const [agentId, setAgentId] = useState(choices[0]?.id ?? "");
  const agent = choices.find((item) => item.id === agentId);
  const [config, setConfig] = useState<SessionConfig>(() => seedConfig(agent, sourceServiceTier));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const reason = handoffDestinationError(agent, sourceDriver, config);
  const model = agent?.capabilities?.models.find((item) => item.id === config.model);
  // `default` is the provider-standard tier: it is always selectable and never needs advertising,
  // so it is excluded from the catalog list to avoid a duplicate entry.
  const advertisedTiers = model?.serviceTiers?.filter((item) => item.id !== "default") ?? [];
  const carriedTierUnsupported = !!config.serviceTier && config.serviceTier !== "default" &&
    !advertisedTiers.some((item) => item.id === config.serviceTier);
  // Render whenever the user has something to choose OR something to clear. A destination with no
  // tier catalog at all — every Claude model — still needs the control when a tier was carried in,
  // or the refusal below has no remedy and Create stays disabled forever.
  const showServiceTier = advertisedTiers.length > 0 || carriedTierUnsupported;
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
        setAgentId(value); setConfig(seedConfig(next, sourceServiceTier));
      }} /></div>
    <div className="field"><span>Model</span><Select label="Model" value={config.model ?? ""} disabled={busy}
      options={(agent?.capabilities?.models.filter((item) => !item.hidden) ?? []).map((item) => ({ value: item.id, label: item.displayName ?? item.id }))}
      onChange={(value) => setConfig({ ...config, model: value, effort: undefined })} /></div>
    <div className="field"><span>Effort</span><Select label="Effort" value={config.effort ?? ""} disabled={busy}
      options={[{ value: "", label: "Default" }, ...(model?.efforts?.length ? model.efforts : agent?.capabilities?.effortLevels ?? []).map((item) => ({ value: item, label: effortLabel(item) }))]}
      onChange={(value) => setConfig({ ...config, effort: value || undefined })} /></div>
    {showServiceTier && (
      <div className="field"><span>Service Tier</span><Select label="Service Tier" value={config.serviceTier ?? "default"} disabled={busy}
        options={[
          { value: "default", label: "Default" },
          ...advertisedTiers.map((item) => ({ value: item.id, label: item.name })),
          // The carried-over tier stays visible by name even when this destination cannot honour
          // it, so the refusal below reads as being about a specific choice rather than a blank.
          ...(carriedTierUnsupported ? [{ value: config.serviceTier!, label: config.serviceTier! }] : []),
        ]}
        onChange={(value) => setConfig({ ...config, serviceTier: value })} /></div>
    )}
    <div className="field"><span>Permissions</span><Select label="Permissions" value={config.permissionMode ?? ""} disabled={busy}
      options={[{ value: "", label: "Default" }, ...(agent?.capabilities?.permissionModes ?? []).map((item) => ({ value: item, label: permissionModeLabel(item, agent?.driver) }))]}
      onChange={(value) => setConfig({ ...config, permissionMode: value || undefined })} /></div>
    {(reason || error) && <p role="alert">{error ?? reason}</p>}
    </div>
  </Modal>;
}
