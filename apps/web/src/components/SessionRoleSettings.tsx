import { MAX_LIVE_CHILD_LIMIT, WORKFLOW_DECISION_CATEGORIES, agentHarnessIdentityKey,
  type OrchestratorDefaults, type OrchestratorSettingsCapabilities } from "@wollipog/protocol";
import { agentHarnessOptionLabel } from "../agent-presentation.js";
import { Select, type SelectOption } from "./ui/ChoiceControls.js";
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

function RoleSelect<T extends string>({ label, ...props }: {
  label: string; value: T; options: readonly SelectOption<T>[]; disabled: boolean; onChange: (value: T) => void;
}) {
  return <div className="field"><span className="field-label">{label}</span><Select label={label} {...props} /></div>;
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
    <RoleSelect label="Child Harness" disabled={disabled} value={selected ? agentHarnessIdentityKey(selected) : ""}
      options={[{ value: "", label: "Automatic" }, ...harnesses.map((harness) => ({
        value: agentHarnessIdentityKey(harness), label: agentHarnessOptionLabel(harness),
        disabled: harness.installations === 0, disabledReason: harness.installations === 0 ? "No current installation supports this harness." : undefined,
      })), ...(selected && !harnesses.some((harness) => agentHarnessIdentityKey(harness) === agentHarnessIdentityKey(selected))
        ? [{ value: agentHarnessIdentityKey(selected), label: "Saved Harness", disabled: true, disabledReason: "This saved harness is unavailable." }] : [])]}
      onChange={(key) => {
        const harness = harnesses.find((item) => agentHarnessIdentityKey(item) === key);
        behavior({ childHarness: harness ? { agentId: harness.agentId, driver: harness.driver, context: harness.context } : null,
          childModel: null, childEffort: null });
      }} />
    <RoleSelect label="Child Model" disabled={disabled} value={value.behavior.childModel ?? ""}
      options={[{ value: "", label: "Automatic" }, ...models.map((model) => ({ value: model.id, label: model.displayName ?? model.id })),
        ...(value.behavior.childModel && !models.some((model) => model.id === value.behavior.childModel)
          ? [{ value: value.behavior.childModel, label: value.behavior.childModel, disabled: true, disabledReason: "This saved model is unavailable." }] : [])]}
      onChange={(childModel) => behavior({ childModel: childModel || null, childEffort: null })} />
    <RoleSelect label="Child Effort" disabled={disabled} value={value.behavior.childEffort ?? ""}
      options={[{ value: "", label: "Automatic" }, ...efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
        ...(value.behavior.childEffort && !efforts.includes(value.behavior.childEffort)
          ? [{ value: value.behavior.childEffort, label: effortLabel(value.behavior.childEffort), disabled: true, disabledReason: "This saved effort is unavailable." }] : [])]}
      onChange={(childEffort) => behavior({ childEffort: childEffort || null })} />
    <label>Maximum Concurrent Children
      <input type="number" inputMode="numeric" min={0} max={MAX_LIVE_CHILD_LIMIT} value={Number.isNaN(value.behavior.maximumConcurrentChildren) ? "" : value.behavior.maximumConcurrentChildren}
        onChange={(event) => behavior({ maximumConcurrentChildren: event.currentTarget.value === "" ? NaN : Number(event.currentTarget.value) })} />
    </label>
    <RoleSelect label="Follow-Ups" disabled={disabled} value={value.behavior.followUps}
      options={[{ value: "recommend_only", label: "Recommend Only" }, { value: "execute_approved", label: "Execute Approved" }]}
      onChange={(followUps) => behavior({ followUps })} />
    <RoleSelect label="Completion" disabled={disabled} value={value.behavior.completion}
      options={[{ value: "retain", label: "Retain" }, { value: "stop_and_archive", label: "Stop and Archive" }]}
      onChange={(completion) => behavior({ completion })} />
    <RoleSelect label="Descendant Requests" disabled={disabled} value={value.delegation.parentControl}
      options={[{ value: "off", label: "Human" }, { value: "questions", label: "Questions" }, { value: "questions_and_approvals", label: "Questions and Approvals" }]}
      onChange={(parentControl) => onChange({ ...value, delegation: { ...value.delegation, parentControl } })} />
    {WORKFLOW_DECISION_CATEGORIES.map((category) => <RoleSelect key={category} label={DECISION_LABELS[category]} disabled={disabled}
      value={value.delegation.decisions[category]} options={[{ value: "human", label: "Human" }, { value: "orchestrator", label: "Orchestrator" }]}
      onChange={(owner) => onChange({ ...value, delegation: { ...value.delegation, decisions: { ...value.delegation.decisions, [category]: owner } } })} />)}
    <RoleSelect label="Strict Project Isolation" disabled={disabled} value={value.execution.strictProjectIsolation ? "enabled" : "disabled"}
      options={[{ value: "disabled", label: "Disabled" }, { value: "enabled", label: "Enabled", disabled: true, disabledReason: "Requires the coupled preset." }]}
      onChange={(mode) => onChange({ ...value, execution: { ...value.execution, strictProjectIsolation: mode === "enabled" } })} />
    <p>Strict Project Isolation requires the coupled preset and cannot be enabled while preserving this session's provider permissions.</p>
    <RoleSelect label="Integration Isolation" disabled={disabled} value={value.execution.integrationIsolation ? "enabled" : "disabled"}
      options={[{ value: "disabled", label: "Disabled" }, { value: "enabled", label: "Enabled" }]}
      onChange={(mode) => onChange({ ...value, execution: { ...value.execution, integrationIsolation: mode === "enabled" } })} />
    <p>Integration Isolation loads Wollipog management tools as the only integration. Disabling it keeps this harness's normal integrations.</p>
    <p>{DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE}</p>
    <p>Secrets, authentication, persistent permission grants, governance, budgets, and tool guardrails remain human-owned. Video and unsupported UI evidence routes to a human.</p>
  </fieldset>;
}
