import { MAX_LIVE_CHILD_LIMIT, WORKFLOW_DECISION_CATEGORIES, agentHarnessIdentityKey,
  type OrchestratorDefaults, type OrchestratorSettingsCapabilities } from "@wollipog/protocol";
import { agentHarnessOptionLabel } from "../agent-presentation.js";
import { effortLabel } from "../format.js";
import { DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE } from "../ui-evidence-disclosure.js";

const DECISION_LABELS = {
  implementation_question: "Implementation Questions", pr_merge: "PR Merge",
  merged_branch_deletion: "Merged Branch Deletion", follow_up_issue_publication: "Follow-Up Publication",
  ui_evidence_approval: "UI Evidence Approval",
};

export function roleSettingsError(draft: OrchestratorDefaults, capabilities?: OrchestratorSettingsCapabilities): string | null {
  const limit = draft.behavior.maximumConcurrentChildren;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIVE_CHILD_LIMIT) return `Enter a whole number from 0 to ${MAX_LIVE_CHILD_LIMIT}.`;
  if (draft.execution.strictProjectIsolation) return "Strict Project Isolation requires the coupled preset. Disable it here to preserve these provider permissions.";
  const { childHarness, childModel, childEffort } = draft.behavior;
  if (!childHarness && !childModel && !childEffort) return null;
  const compatible = capabilities?.harnesses?.some((harness) => harness.installations > 0 &&
    (!childHarness || agentHarnessIdentityKey(harness) === agentHarnessIdentityKey(childHarness)) &&
    (childModel ? harness.supportedPairs.some((pair) => pair.modelId === childModel &&
      (!childEffort || pair.effortLevels.includes(childEffort)))
      : !childEffort || harness.effortLevels.includes(childEffort)));
  return compatible ? null : "Choose Automatic or a Child Harness, Child Model, and Child Effort supported together by a current installation.";
}

/** Session-scoped draft; this never changes the authenticated user's saved defaults. */
export function SessionRoleSettings({ value, capabilities, disabled, onChange }: {
  value: OrchestratorDefaults; capabilities?: OrchestratorSettingsCapabilities; disabled: boolean;
  onChange: (value: OrchestratorDefaults) => void;
}) {
  const harnesses = capabilities?.harnesses ?? [];
  const selected = value.behavior.childHarness;
  const candidates = selected ? harnesses.filter((harness) => agentHarnessIdentityKey(harness) === agentHarnessIdentityKey(selected)) : harnesses;
  const models = [...new Map(candidates.flatMap((harness) => harness.models.map((model) => [model.id, model] as const))).values()];
  const efforts = [...new Set(candidates.flatMap((harness) => value.behavior.childModel
    ? harness.supportedPairs.filter((pair) => pair.modelId === value.behavior.childModel).flatMap((pair) => pair.effortLevels)
    : harness.effortLevels))].sort();
  const behavior = (patch: Partial<OrchestratorDefaults["behavior"]>) => onChange({ ...value, behavior: { ...value.behavior, ...patch } });
  return <fieldset disabled={disabled} className="session-role-settings">
    <legend>Orchestrator Settings</legend>
    <p>Review and change these settings before confirming. They apply to this session; your saved defaults stay unchanged.</p>
    <label>Child Harness
      <select value={selected ? agentHarnessIdentityKey(selected) : ""} onChange={(event) => {
        const harness = harnesses.find((item) => agentHarnessIdentityKey(item) === event.currentTarget.value);
        behavior({ childHarness: harness ? { agentId: harness.agentId, driver: harness.driver, context: harness.context } : null,
          childModel: null, childEffort: null });
      }}>
        <option value="">Automatic</option>
        {harnesses.map((harness) => <option key={agentHarnessIdentityKey(harness)} value={agentHarnessIdentityKey(harness)}>{agentHarnessOptionLabel(harness)}{harness.installations ? "" : " (Unavailable)"}</option>)}
        {selected && !harnesses.some((harness) => agentHarnessIdentityKey(harness) === agentHarnessIdentityKey(selected)) &&
          <option value={agentHarnessIdentityKey(selected)}>Saved Harness (Unavailable)</option>}
      </select>
    </label>
    <label>Child Model
      <select value={value.behavior.childModel ?? ""} onChange={(event) => behavior({ childModel: event.currentTarget.value || null, childEffort: null })}>
        <option value="">Automatic</option>
        {models.map((model) => <option key={model.id} value={model.id}>{model.displayName ?? model.id}</option>)}
        {value.behavior.childModel && !models.some((model) => model.id === value.behavior.childModel) && <option value={value.behavior.childModel}>{value.behavior.childModel} (Unavailable)</option>}
      </select>
    </label>
    <label>Child Effort
      <select value={value.behavior.childEffort ?? ""} onChange={(event) => behavior({ childEffort: event.currentTarget.value || null })}>
        <option value="">Automatic</option>
        {efforts.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
        {value.behavior.childEffort && !efforts.includes(value.behavior.childEffort) && <option value={value.behavior.childEffort}>{effortLabel(value.behavior.childEffort)} (Unavailable)</option>}
      </select>
    </label>
    <label>Maximum Concurrent Children
      <input type="number" inputMode="numeric" min={0} max={MAX_LIVE_CHILD_LIMIT} value={Number.isNaN(value.behavior.maximumConcurrentChildren) ? "" : value.behavior.maximumConcurrentChildren}
        onChange={(event) => behavior({ maximumConcurrentChildren: event.currentTarget.value === "" ? NaN : Number(event.currentTarget.value) })} />
    </label>
    <label>Follow-Ups
      <select value={value.behavior.followUps} onChange={(event) => behavior({ followUps: event.currentTarget.value as OrchestratorDefaults["behavior"]["followUps"] })}>
        <option value="recommend_only">Recommend Only</option><option value="execute_approved">Execute Approved</option>
      </select>
    </label>
    <label>Completion
      <select value={value.behavior.completion} onChange={(event) => behavior({ completion: event.currentTarget.value as OrchestratorDefaults["behavior"]["completion"] })}>
        <option value="retain">Retain</option><option value="stop_and_archive">Stop and Archive</option>
      </select>
    </label>
    <label>Descendant Requests
      <select value={value.delegation.parentControl} onChange={(event) => onChange({ ...value, delegation: { ...value.delegation, parentControl: event.currentTarget.value as OrchestratorDefaults["delegation"]["parentControl"] } })}>
        <option value="off">Human</option><option value="questions">Questions</option><option value="questions_and_approvals">Questions and Approvals</option>
      </select>
    </label>
    {WORKFLOW_DECISION_CATEGORIES.map((category) => <label key={category}>{DECISION_LABELS[category]}
      <select value={value.delegation.decisions[category]} onChange={(event) => onChange({ ...value, delegation: { ...value.delegation,
        decisions: { ...value.delegation.decisions, [category]: event.currentTarget.value as "human" | "orchestrator" } } })}>
        <option value="human">Human</option><option value="orchestrator">Orchestrator</option>
      </select>
    </label>)}
    <label>Strict Project Isolation
      <select value={value.execution.strictProjectIsolation ? "enabled" : "disabled"} onChange={(event) => onChange({ ...value, execution: { ...value.execution, strictProjectIsolation: event.currentTarget.value === "enabled" } })}>
        <option value="disabled">Disabled</option><option value="enabled" disabled>Enabled (Requires Coupled Preset)</option>
      </select>
    </label>
    <p>Strict Project Isolation requires the coupled preset and cannot be enabled while preserving this session's provider permissions.</p>
    <label>Integration Isolation
      <select value={value.execution.integrationIsolation ? "enabled" : "disabled"} onChange={(event) => onChange({ ...value, execution: { ...value.execution, integrationIsolation: event.currentTarget.value === "enabled" } })}>
        <option value="disabled">Disabled</option><option value="enabled">Enabled</option>
      </select>
    </label>
    <p>Integration Isolation loads Wollipog management tools as the only integration. Disabling it keeps this harness's normal integrations.</p>
    <p>{DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE}</p>
    <p>Secrets, authentication, persistent permission grants, governance, budgets, and tool guardrails remain human-owned. Video and unsupported UI evidence routes to a human.</p>
  </fieldset>;
}
