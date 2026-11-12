import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
  type OrchestratorSettingsView, type RunnerView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { browserRandomUUID } from "../browser-crypto.js";
import type { FormState } from "../automation-form.js";
import { evaluateOrchestratorPolicy, policyDraftFromDefaults, policySummaryFacts, type OrchestratorPolicyDraft } from "../orchestrator-policy.js";
import { OrchestratorPolicyDialog } from "./OrchestratorPolicyDialog.js";
import { maskedAccountTitles } from "../personal-identifiers.js";
import { Notice } from "./Notice.js";
import { AutomationExpectedProviderAccount } from "./ProviderAccountSelection.js";
import { Select } from "./ui/ChoiceControls.js";

/** The same policy dialog as New Session. The stored schedule holds the applied settings rather
 * than silently following changes to the owner's account defaults on a later day. */
export function AutomationCampaignFields({ form, runner, accountPlacement, onChange }: {
  form: FormState; runner: RunnerView | undefined; onChange: (form: FormState) => void;
  /** Where a run would start, for the Default account's preview; null when it can't be derived. */
  accountPlacement: ComponentProps<typeof AutomationExpectedProviderAccount>["placement"];
}) {
  const api = useApi();
  const expectationId = `${useId()}-expected-account`;
  const [view, setView] = useState<OrchestratorSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const customizeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    api.orchestratorSettings().then(v => { if (active) setView(v); }, cause => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [api]);
  const campaign = form.campaign;
  const agent = runner?.agents.find(a => a.id === form.agentId);
  const provider = agent?.driver === "claude-code" ? "claude" : agent?.driver === "codex-app-server" ? "codex" : null;
  const accounts = (runner?.providerAccounts ?? []).filter(account => account.provider === provider);
  const accountTitles = maskedAccountTitles(accounts.map(account => account.label));
  const tiers = agent?.capabilities?.models.find(model => model.id === form.model || (!form.model && model.default))?.serviceTiers ?? [];
  const base = view?.defaults ?? DEFAULT_ORCHESTRATOR_DEFAULTS;
  const draft: OrchestratorPolicyDraft = {
    values: { ...base, behavior: { ...base.behavior, ...form.orchestrator?.behavior },
      delegation: { ...base.delegation, ...form.orchestrator?.delegation,
        decisions: { ...base.delegation.decisions, ...form.orchestrator?.delegation?.decisions } },
      execution: { ...base.execution, ...form.orchestrator?.execution } },
    controlMode: campaign?.controlMode ?? "custom",
    limitText: String(form.orchestrator?.behavior?.maximumConcurrentChildren ?? base.behavior.maximumConcurrentChildren),
  };
  const context = view ? { view, machine: runner?.hostname ?? "this machine", runnerProtocolVersion: runner?.protocolVersion,
    driver: agent?.driver, hostExecutionTarget: true, agentOffersOrchestratorPreset: agent?.capabilities?.permissionModes?.includes("orchestrator") ?? false,
    strictProjectBoundaryAvailable: true, providerExecutionAvailable: true, presetReason: () => undefined } : null;
  const apply = (next: OrchestratorPolicyDraft) => {
    const { fullControl, ...common } = campaign!;
    onChange({ ...form, campaign: { ...common, controlMode: next.controlMode,
      ...(next.controlMode === "full_control" && fullControl ? { fullControl } : {}) }, orchestrator: {
      behavior: { ...next.values.behavior, maximumConcurrentChildren: Number(next.limitText) },
      delegation: next.values.delegation, execution: next.values.execution,
    } });
    setEditing(false);
  };
  const evaluation = context ? evaluateOrchestratorPolicy(context, draft) : null;
  return <>
    <div className="field">
      <span className="field-label">Session Role</span>
      <Select label="Session Role" value={campaign ? "orchestrator" : "normal"} onChange={value => {
        if (value === "normal") onChange({ ...form, sessionRole: "normal", campaign: undefined, orchestrator: undefined,
          permissionMode: form.permissionMode === "orchestrator" ? "" : form.permissionMode });
        else {
          const initial = policyDraftFromDefaults(base);
          onChange({ ...form, sessionRole: "orchestrator", campaign: { controlMode: initial.controlMode, repository: "", tasks: [] },
            orchestrator: { behavior: initial.values.behavior, delegation: initial.values.delegation, execution: initial.values.execution } });
        }
      }} options={[{ value: "normal", label: "Normal" }, { value: "orchestrator", label: "Orchestrator", disabled: !view,
        description: "Launch a fresh campaign for every occurrence." }]} />
    </div>
    {campaign && <>
      {accounts.length > 0 && <div className="field"><span className="field-label">Orchestrator Provider Account</span>
        <Select label="Orchestrator Provider Account" value={form.providerAccountId ?? ""}
          options={[{ value: "", label: "Default" }, ...accounts.map((account, index) => ({ value: account.id, label: accountTitles[index]! }))]}
          describedBy={!form.providerAccountId ? expectationId : undefined}
          onChange={value => onChange({ ...form, providerAccountId: value || undefined })} />
        {/* What Default resolves to (#4512); a named account needs no prediction. */}
        {!form.providerAccountId && runner && <AutomationExpectedProviderAccount runner={runner} agentId={form.agentId}
          placement={accountPlacement} choosable id={expectationId} />}
      </div>}
      {(tiers.length > 0 || form.serviceTier) && <div className="field"><span className="field-label">Service Tier</span>
        <Select label="Service Tier" value={form.serviceTier ?? ""} onChange={value => onChange({ ...form, serviceTier: value || undefined })}
          options={[{ value: "", label: "Default" }, ...tiers.map(tier => ({ value: tier.id, label: tier.name }))]} />
      </div>}
      {error && <Notice tone="danger">{error}</Notice>}
      <label className="field"><span>Campaign Repository</span>
        <input value={campaign.repository} placeholder="owner/repository" maxLength={512}
          onChange={event => onChange({ ...form, campaign: { ...campaign, repository: event.target.value.trim().toLowerCase() } })} />
        <span className="field-helper">Each run verifies this repository before starting. Changing the folder's origin cannot expand its authority.</span>
      </label>
      {evaluation && <div className="field">
        <span className="field-label">Orchestrator Policy</span>
        <p className="field-helper">{policySummaryFacts(draft, evaluation).map(fact => fact.label).join(" · ")}</p>
        <p className="field-helper">Child harness: {evaluation.harness.options.find(option => option.value === evaluation.harness.value)?.label ?? "Automatic"}.
          {" "}Child model: {draft.values.behavior.childModel ?? "Automatic"}. Child effort: {draft.values.behavior.childEffort ?? "Automatic"}.</p>
        <p className="field-helper">Saved with this automation. Changes apply to future occurrences.</p>
        {evaluation.problems[0] && <p className="field-error">{evaluation.problems[0].message}</p>}
        <button ref={customizeRef} type="button" className="btn" aria-haspopup="dialog" onClick={() => setEditing(true)}>Customize…</button>
      </div>}
      <p className="field-helper">The run's cost and tool-call limits cover the Orchestrator, its children and follow-up implementation. Full Control keeps mandatory human decisions with you.</p>
      {campaign.controlMode === "full_control" && <p className="field-helper">{CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE}</p>}
      {campaign.controlMode === "full_control" && <div className="field-row">
        <label className="field"><span>Maximum Issues</span><input type="number" min={1} max={100}
          value={campaign.fullControl?.issues?.maxIssues ?? ""} placeholder="Automatic"
          onChange={event => onChange({ ...form, campaign: { ...campaign, fullControl: { ...campaign.fullControl,
            issues: { ...campaign.fullControl?.issues, maxIssues: event.target.value ? Number(event.target.value) : undefined } } } })} /></label>
        <label className="field"><span>Follow-Ups Without Approval</span><input type="number" min={0} max={100}
          value={campaign.fullControl?.budget?.acceptedFollowUps ?? ""} placeholder="Automatic"
          onChange={event => onChange({ ...form, campaign: { ...campaign, fullControl: { ...campaign.fullControl,
            budget: { ...campaign.fullControl?.budget, acceptedFollowUps: event.target.value ? Number(event.target.value) : undefined } } } })} /></label>
      </div>}
      <h3 className="section-title">Recurring Child Tasks</h3>
      {campaign.tasks.map((task, index) => <fieldset key={task.key} className="section">
        <legend>Task {index + 1}</legend>
        <label className="field"><span>Task Title</span><input value={task.title} maxLength={120}
          onChange={event => onChange({ ...form, campaign: { ...campaign, tasks: campaign.tasks.map(t => t.key === task.key ? { ...t, title: event.target.value } : t) } })} /></label>
        <label className="field"><span>Task Prompt</span><textarea value={task.prompt} rows={3} maxLength={16_384}
          onChange={event => onChange({ ...form, campaign: { ...campaign, tasks: campaign.tasks.map(t => t.key === task.key ? { ...t, prompt: event.target.value } : t) } })} /></label>
        <button type="button" className="btn" aria-label={`Remove Task ${index + 1}`}
          onClick={() => onChange({ ...form, campaign: { ...campaign, tasks: campaign.tasks.filter(t => t.key !== task.key) } })}>Remove Task</button>
      </fieldset>)}
      <button type="button" className="btn" disabled={campaign.tasks.length >= 100} onClick={() => onChange({ ...form,
        campaign: { ...campaign, tasks: [...campaign.tasks, { key: browserRandomUUID(), title: "", prompt: "" }] } })}>Add Child Task</button>
      {editing && context && <OrchestratorPolicyDialog context={context} draft={draft} returnFocusRef={customizeRef}
        onApply={apply} onClose={() => setEditing(false)} />}
    </>}
  </>;
}
