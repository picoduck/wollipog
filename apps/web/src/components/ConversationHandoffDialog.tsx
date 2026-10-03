import { useRef, useState } from "react";
import { handoffDestinationError, type AgentDefinition, type SessionConfig } from "@wollipog/protocol";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { ChevronRightIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { effortLabel, permissionModeLabel, resolvedModelLabel, serviceTierLabel } from "../format.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";

const HANDOFF_DRIVERS = ["claude-code", "codex-app-server"];
const REFUSAL_ID = "handoff-refusal";
const REASON_ID = "handoff-reason";
const TIER_ERROR_ID = "handoff-tier-error";

/** Seed a destination config, carrying forward the source session's deliberate service-tier choice.
 * The tier is carried even when this destination cannot honour it, so the dialog can say so before
 * the handoff is created rather than substituting a different tier behind the user's back. */
function seedConfig(agent: AgentDefinition | undefined, sourceServiceTier: string | undefined): SessionConfig {
  return {
    model: agent?.capabilities?.models.find((model) => !model.hidden)?.id,
    ...(sourceServiceTier ? { serviceTier: sourceServiceTier } : {}),
  };
}

/** Why this agent cannot take the hand-off right now, or null when it can. Shown under the agent's
 * name in the list (§11.3: never hide a choice that could exist). Settings-dependent refusals
 * (model, effort, tier) are not here: they belong to the field that causes them. */
export function handoffAgentUnavailableReason(agent: AgentDefinition, source: { driver: string; agentId?: string }, machineName?: string): string | null {
  const machine = machineName || "this machine";
  if (!HANDOFF_DRIVERS.includes(agent.driver ?? "")) return "Doesn't support hand-offs.";
  if (agent.driver === source.driver) {
    return agent.id === source.agentId ? "Already this session's agent." : "Same provider as this session. Use Fork instead.";
  }
  if (agent.installation?.selection === "other" || agent.harnessSelectionBlocked) {
    return "Another installation is selected in Machine Settings.";
  }
  if (agent.available !== true) return `Not available on ${machine}.`;
  if (agent.authStatus !== "authenticated") return `Sign in on ${machine} first.`;
  if (!agent.capabilities?.models.some((model) => !model.hidden)) return "No models available.";
  return null;
}

export function ConversationHandoffDialog({ agents, sourceDriver, sourceAgentId, sourceServiceTier, machineName, turn, refusal = null, onClose, onCreate }: {
  agents: AgentDefinition[]; sourceDriver: string; sourceAgentId?: string; sourceServiceTier?: string;
  /** The Machine the agents run on, named in a sign-in reason. */
  machineName?: string;
  turn: number;
  /** Why the signed-in person may not hand off, when that changes while the dialog is open (#1864). */
  refusal?: string | null;
  onClose: () => void;
  onCreate: (agentId: string, config: SessionConfig) => Promise<void>;
}) {
  // Every agent that could take a hand-off is listed, with the reason it can't when it can't. Agents
  // of other drivers are listed only once installed, so an uninstalled registry entry is not noise.
  const listed = agents
    .filter((agent) => HANDOFF_DRIVERS.includes(agent.driver ?? "") || agent.available === true)
    .map((agent) => ({ agent, unavailable: handoffAgentUnavailableReason(agent, { driver: sourceDriver, agentId: sourceAgentId }, machineName) }))
    .sort((a, b) => Number(a.unavailable !== null) - Number(b.unavailable !== null));
  const choices = listed.filter((item) => item.unavailable === null).map((item) => item.agent);
  const [agentId, setAgentId] = useState(choices[0]?.id ?? "");
  const agent = choices.find((item) => item.id === agentId);
  const [config, setConfig] = useState<SessionConfig>(() => seedConfig(agent, sourceServiceTier));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const destinationReason = handoffDestinationError(agent, sourceDriver, config);
  const reason = refusal ?? destinationReason;
  const model = agent?.capabilities?.models.find((item) => item.id === config.model);
  // `default` is the provider-standard tier: it is always selectable and never needs advertising,
  // so it is excluded from the catalog list to avoid a duplicate entry.
  const advertisedTiers = model?.serviceTiers?.filter((item) => item.id !== "default") ?? [];
  const carriedTierUnsupported = !!config.serviceTier && config.serviceTier !== "default" &&
    !advertisedTiers.some((item) => item.id === config.serviceTier);
  // Render whenever the user has something to choose OR something to clear. A destination with no
  // tier catalog at all — every Claude model — still needs the control when a tier was carried in,
  // or the refusal has no remedy and Create stays disabled forever.
  const showServiceTier = advertisedTiers.length > 0 || carriedTierUnsupported;
  // The carried tier is named as the source's own catalog names it, never by its provider id.
  const carriedTierName = config.serviceTier ? agents
    .filter((item) => item.driver === sourceDriver)
    .flatMap((item) => item.capabilities?.models ?? [])
    .flatMap((item) => item.serviceTiers ?? [])
    .find((tier) => tier.id === config.serviceTier)?.name || serviceTierLabel(config.serviceTier) : undefined;
  const tierError = carriedTierUnsupported
    ? `${agent?.name ?? "This agent"} doesn't offer the ${carriedTierName} tier. Choose another tier.`
    : null;
  // Why Create Handoff is disabled, beside it in the footer (§7.3, §8.5). A Viewer refusal has its own
  // line above the footer instead.
  const footerReason = refusal !== null || !destinationReason ? null
    // The chosen agent can drop out while the dialog is open (it signs out, its runner updates).
    : !agent ? (choices.length ? "Choose an agent." : "No agent can take this hand-off.")
    : carriedTierUnsupported ? "Choose a supported service tier."
    : destinationReason;
  const submit = async () => {
    if (lock.current || reason) return;
    lock.current = true; setBusy(true); setError(undefined);
    try { await onCreate(agentId, config); } catch (cause) { setError((cause as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  const permissions = (
    <div className={`field${showServiceTier ? "" : " handoff-field-wide"}`}><span>Permissions</span><Select label="Permissions" value={config.permissionMode ?? ""} disabled={busy}
      options={[{ value: "", label: "Default" }, ...(agent?.capabilities?.permissionModes ?? []).map((item) => ({ value: item, label: permissionModeLabel(item, agent?.driver) }))]}
      onChange={(value) => setConfig({ ...config, permissionMode: value || undefined })} /></div>
  );
  return <Modal title="Hand Off to Another Agent"
    description={`Start a fresh conversation with another agent, using this session's files and dialogue up to Turn ${turn}.`}
    onClose={busy ? () => {} : onClose} footer={<>
      {footerReason && <p className="handoff-reason" id={REASON_ID}>{footerReason}</p>}
      <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
      <BusyButton className="btn primary" busy={busy} progress="Creating the handoff…" onClick={() => void submit()} disabled={!!reason}
        aria-describedby={refusal !== null ? REFUSAL_ID : footerReason ? REASON_ID : undefined}>Create Handoff</BusyButton>
    </>}>
    <div className="handoff-dialog-body">
      <details className="disclosure handoff-carries">
        <summary><ChevronRightIcon className="disclosure-chevron" />What Carries Over</summary>
        <div className="disclosure-body">
          <dl className="facts">
            <div><dt>Files</dt><dd>The checkpoint after Turn {turn}.</dd></div>
            <div><dt>Conversation</dt><dd>Visible user and agent messages, up to 24,000 characters.</dd></div>
            <div><dt>Left Out</dt><dd>Tool output, reasoning, questions and approvals.</dd></div>
            <div><dt>This Session</dt><dd>Unchanged.</dd></div>
          </dl>
          <p className="handoff-carries-note">Nothing is sent until you press Send in the new session.</p>
        </div>
      </details>
      <div className="field"><span>Agent</span><Select label="Agent" value={agent ? agentId : null} disabled={busy}
        options={listed.map(({ agent: item, unavailable }) => ({
          value: item.id, label: item.name,
          ...(unavailable ? { disabled: true, disabledReason: unavailable } : {}),
        }))} onChange={(value) => {
          const next = choices.find((item) => item.id === value);
          setAgentId(value); setConfig(seedConfig(next, sourceServiceTier));
        }} /></div>
      <div className="field-row">
        <div className="field"><span>Model</span><Select label="Model" value={config.model ?? ""} disabled={busy}
          options={(agent?.capabilities?.models.filter((item) => !item.hidden) ?? []).map((item) => ({ value: item.id, label: item.displayName ?? resolvedModelLabel(item.id) }))}
          onChange={(value) => setConfig({ ...config, model: value, effort: undefined })} /></div>
        <div className="field"><span>Effort</span><Select label="Effort" value={config.effort ?? ""} disabled={busy}
          options={[{ value: "", label: "Default" }, ...(model?.efforts?.length ? model.efforts : agent?.capabilities?.effortLevels ?? []).map((item) => ({ value: item, label: effortLabel(item) }))]}
          onChange={(value) => setConfig({ ...config, effort: value || undefined })} /></div>
      </div>
      <div className="field-row">
        {showServiceTier && (
          <div className="field"><span>Service Tier</span><Select label="Service Tier" value={config.serviceTier ?? "default"} disabled={busy}
            invalid={carriedTierUnsupported} describedBy={tierError ? TIER_ERROR_ID : undefined}
            options={[
              { value: "default", label: "Default" },
              ...advertisedTiers.map((item) => ({ value: item.id, label: item.name || serviceTierLabel(item.id) })),
              // The carried-over tier stays visible by name even when this destination cannot honour
              // it, so the field error reads as being about a specific choice rather than a blank.
              ...(carriedTierUnsupported ? [{ value: config.serviceTier!, label: carriedTierName! }] : []),
            ]}
            onChange={(value) => setConfig({ ...config, serviceTier: value })} />
            {tierError && <FieldError id={TIER_ERROR_ID}>{tierError}</FieldError>}
          </div>
        )}
        {permissions}
      </div>
      {refusal !== null && <p className="handoff-refusal" id={REFUSAL_ID} role="status">{refusal}</p>}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </div>
  </Modal>;
}
